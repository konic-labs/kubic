// The durable loop surface over one booted lane: the turn, the event
// stream, the transcript read and the abort/drain pair every boot has, plus
// what the prod boot adds — the live model and thinking switches, the
// picker's catalog, and the trajectory each settled turn records.
import {
  DEFAULT_RESERVE_TOKENS,
  effectiveReserveTokens,
  runCompactCommand,
} from '@kubic/agent/compaction';
import { abortLane, forgetLaneKills } from '@kubic/agent/lane/abort';
import { escalateLaneModel, type Lane } from '@kubic/agent/lane/boot';
import { subscribeLaneEvents } from '@kubic/agent/lane/events';
import {
  entriesToTranscript,
  readConversationEntries,
} from '@kubic/agent/lane/transcript';
import { runTurn } from '@kubic/agent/lane/turn';
import {
  type AnyModel,
  clampThinking,
  type EscalationLadder,
  ModelSelectError,
  supportedThinking,
} from '@kubic/agent/model-select';
import {
  BACKGROUND_CONTEXT,
  type Context,
  type ModelThinkingLevel,
  type MutableModels,
} from '@kubic/agent/pi-boundary';
import type { ModelEscalationEvent } from '@kubic/agent/prompts';
import { DEFAULT_RUN_ROLE } from '@kubic/core/run-role';
import { providerKeyHints } from '@kubic/host/models';
import {
  AUTO_ESCALATION_TOOL_FAILURES,
  createAutoEscalation,
  formatEscalationRow,
  markAutoEscalated,
  nextLadderRung,
  noteAutoEscalationTurn,
  resetAutoEscalation,
  shouldAutoEscalate,
  toTrajectoryEscalation,
} from '../auto-escalation.js';
import {
  resolveLaneLadder,
  roleModelScope,
  selectModelUnderPolicy,
} from '../config/model-selection.js';
import { persistRunTrajectory } from '../run/trajectory.js';
import type { SessionBoot } from '../session/bootstrap.js';
import type { TuiRunOptions } from './options.js';
import { tuiTurnOutcome } from './outcome.js';
import type {
  ContextLimits,
  TuiLaneLoop,
  TuiModelChoice,
  TuiProviderChoice,
  TuiTurnRecord,
} from './types.js';

// The durable loop surface over one booted lane — exactly what
// bootTuiLane installs. Exported so the prod boot, embedders and the tests
// share ONE wiring: a lane member the loop needs cannot be forgotten in a
// hand-spread fake (the failure mode that hides a dropped dep).
export function tuiLoop(
  lane: Lane,
  context: Context = BACKGROUND_CONTEXT,
): TuiLaneLoop {
  return {
    runTurn: (prompt, opts) => runTurn(lane, prompt, opts),
    // The live model's own input modalities. The boot
    // model is what this closure can see; `bootTuiLane` overrides it with
    // the catalog read so a `/model` switch moves the verdict with it.
    supportsImages: async () => lane.model.input.includes('image'),
    subscribe: (sink, loopContext) =>
      subscribeLaneEvents(
        lane.harness,
        lane.conversation.id,
        sink,
        loopContext,
      ),
    entries: (loopContext) =>
      readConversationEntries(lane.conversation, loopContext),
    // `/compact [focus]` — Pi's manual compaction task with Kubic's compact
    // prompt as the summarizer instructions, under the manual keep window.
    compact: (focus, loopContext, options) =>
      runCompactCommand(lane, focus, loopContext, options),
    // The shared abort+drain (conversation.abort, every kill
    // attempted, failures aggregated) and the settled-turn forget.
    abort: async (loopContext) => {
      await abortLane(lane, loopContext);
    },
    forgetKills: () => forgetLaneKills(lane),
    killsKey: String(lane.conversation.id),
    kills: lane.kills,
    // The lane's own context: every member is called with it, so an embedder
    // that booted the lane on a bounded context is never silently
    // un-cancellable.
    context,
  };
}

// The model the conversation actually runs: the committed
// `pi.agent` document first, the boot model as the fallback for the window
// before the first configure.
export async function liveModelOf(
  lane: Lane,
  context: Context,
): Promise<{ provider: string; id: string }> {
  const agent = await lane.conversation.agent(context);
  const live = agent.model;
  if (live !== undefined) {
    return { provider: live.provider, id: live.modelId };
  }
  return { provider: lane.model.provider, id: lane.model.id };
}

// A model's context window and the token level at which the
// lane compacts (window − reserve, the same policy the harness reads).
// No window means the catalog does not know it: the gauge then stays off
// rather than showing a made-up percentage.
export function contextLimitsOf(
  models: MutableModels,
  provider: string,
  id: string,
): ContextLimits {
  const definition = models
    .getModels(provider)
    .find((model) => model.id === id);
  const contextWindow = definition?.contextWindow;
  if (contextWindow === undefined || !(contextWindow > 0)) return {};
  return {
    contextWindow,
    compactionThreshold:
      contextWindow -
      effectiveReserveTokens(contextWindow, DEFAULT_RESERVE_TOKENS),
  };
}

// What the prod loop surface reads from its boot.
export interface BootedLoopInputs {
  readonly boot: SessionBoot;
  readonly lane: Lane;
  readonly models: MutableModels;
  readonly options: TuiRunOptions;
  readonly context: Context;
  // The sessions root and the session id the trajectory is written under,
  // and the workspace it names.
  readonly root: string;
  readonly id: string;
  readonly cwd: string;
  // The offered skill names, for the trajectory's resources.
  readonly skillNames: readonly string[];
  // Transcript warnings the loop drains (the screen owns the terminal).
  readonly transcriptNotices: string[];
}

// The run's escalation ladder: the role's own rungs win over the merged
// `[model]` ones (`resolveLaneLadder`), and the record lives here — one
// ladder object per boot, so every explicit climb and the single auto
// climb draw from the same budget. No ladder when nothing configured one:
// the `/model` switch keeps its plain path.
class LaneEscalation {
  readonly ladder: EscalationLadder | undefined;
  // The climbs this run recorded: the sink every escalateLaneModel call
  // reports to — the trajectory event and the transcript line read them
  // from here.
  readonly events: ModelEscalationEvent[] = [];
  // The single automatic trigger's streak: consecutive tool-failure turns
  // climb one rung, once per run.
  readonly auto = createAutoEscalation();
  // Transcript rows already reported: each recorded climb is reported
  // once, however many turns settle.
  private reported = 0;

  constructor(inputs: BootedLoopInputs) {
    const steps = resolveLaneLadder(
      inputs.options.escalate,
      inputs.boot.role?.resolved.escalate,
    );
    this.ladder =
      steps === undefined
        ? undefined
        : {
            steps: [...steps.steps],
            maxEscalations: steps.maxEscalations,
            record: [],
          };
  }

  record(event: ModelEscalationEvent): void {
    this.events.push(event);
  }

  // The transcript rows for the climbs recorded since the last drain.
  drainRows(): string[] {
    const rows = this.events
      .slice(this.reported)
      .map((event) => formatEscalationRow(event));
    this.reported = this.events.length;
    return rows;
  }
}

// The prod loop surface over a booted lane.
export function bootedLoop(inputs: BootedLoopInputs): TuiLaneLoop {
  const { lane, models, context } = inputs;
  const escalation = new LaneEscalation(inputs);
  return {
    ...tuiLoop(lane, context),
    // The LIVE model's modalities, resolved against the same
    // catalog `/model` switches through — a switch to a text-only model
    // refuses the next attachment (and clears the pending ones).
    supportsImages: async (loopContext) => {
      const live = await liveModelOf(lane, loopContext);
      return (
        models
          .getModels(live.provider)
          .find((model) => model.id === live.id)
          ?.input.includes('image') === true
      );
    },
    // A `/model` switch moves the context window with it, so
    // the gauge never keeps the old model's percentage.
    contextLimits: (provider, id) => contextLimitsOf(models, provider, id),
    switchModel: (selection, loopContext, reason) =>
      switchLaneModel(inputs, escalation, selection, loopContext, reason),
    model: async (loopContext) => {
      const running = await liveModelOf(lane, loopContext);
      return `${running.provider}/${running.id}`;
    },
    // The thinking level lives in the same `pi.agent`
    // document as the model — nothing extra to persist, and a
    // resume restores it.
    thinking: async (loopContext) => {
      const agent = await lane.conversation.agent(loopContext);
      return agent.thinkingLevel ?? 'off';
    },
    switchThinking: (level, loopContext) =>
      switchLaneThinking(inputs, level, loopContext),
    supportedThinking: async (loopContext) => {
      const live = await liveModelOf(lane, loopContext);
      const model = models.getModel(live.provider, live.id) as
        | AnyModel
        | undefined;
      return model === undefined ? ['off'] : supportedThinking(models, model);
    },
    listModels: (loopContext) => listLaneModels(inputs, loopContext),
    listProviders: () => listLaneProviders(inputs),
    recordTurn: (turn) => recordTuiTurn(inputs, escalation, turn),
    // The transcript rows for recorded climbs.
    // The runner drains this after every settled turn — each climb is
    // reported once, however many turns settle afterwards.
    drainEscalationRows: () => escalation.drainRows(),
    // The notices recorded since the last drain: the boot's skill
    // warnings and the settled turn's trajectory warnings.
    drainNotices: () => inputs.transcriptNotices.splice(0),
  };
}

// `/model` and `/escalate`. The id is resolved against the live catalog
// before the conversation is touched, so `/model typo/nope` fails by name and
// the lane keeps the model it had; configure then commits the change to the
// session's agent document, and the read-back is the label every surface
// shows. The enterprise gate is the boot's own: a switch outside
// `allowed_models`/`allowed_providers` is refused with the same named error
// before the lane is touched, so the live model stays put.
async function switchLaneModel(
  inputs: BootedLoopInputs,
  escalation: LaneEscalation,
  selection: { provider: string; modelId: string },
  loopContext: Context,
  reason: string | undefined,
): Promise<string> {
  const { boot, lane, models, options } = inputs;
  // `/model` is the session override, and a
  // frozen enterprise `[model]` cannot be overridden by it — refused
  // by name before the catalog or the conversation is touched. Naming
  // the pin itself changes nothing and passes.
  if (options.modelPinFrozen === true && options.model !== undefined) {
    const pinned = `${options.model.provider}/${options.model.id}`;
    const requested = `${selection.provider}/${selection.modelId}`;
    if (requested !== pinned) {
      throw new ModelSelectError(
        `model '${requested}' refused: the model is pinned by enterprise policy (${pinned}); /model cannot change it`,
      );
    }
  }
  const resolved = selectModelUnderPolicy(
    models,
    { provider: selection.provider, id: selection.modelId },
    undefined,
    undefined,
    options.modelPolicy,
    // Escalation outside the role's set is refused: the live model
    // stays put, like the enterprise gate.
    roleModelScope(boot.role?.resolved),
  );
  // With a ladder configured the switch climbs
  // it through escalateLaneModel — one-way, budget-bounded,
  // recorded — so an off-ladder target, a down-step, or an
  // exhausted budget refuses by name with the live model untouched.
  // Naming the live model is a no-op pass down the plain path
  // (no budget burned, no event); without a ladder the plain path
  // below runs exactly as before. After a climb, control falls
  // through to the re-clamp below, which commits the thinking
  // level for the NEW model in the same switch.
  const requested = `${selection.provider}/${selection.modelId}`;
  if (escalation.ladder !== undefined && requested !== boot.liveModelRef) {
    await escalateLaneModel(
      lane,
      escalation.ladder,
      requested,
      reason ?? `/model ${requested}`,
      loopContext,
      (event) => escalation.record(event),
    );
  }
  // A switch re-clamps the thinking level to the
  // NEW model's ladder and commits both in one change, so the stored
  // level, the `/thinking` report, the cycle key and the status bar
  // agree with what the provider will actually be asked for.
  const agent = await lane.conversation.agent(loopContext);
  const effective = clampThinking(
    models,
    resolved,
    agent.thinkingLevel ?? 'off',
  );
  await lane.conversation.configure(
    {
      model: { provider: resolved.provider, modelId: resolved.id },
      thinkingLevel: effective,
    },
    loopContext,
  );
  // The agent document is the truth: read the live model back instead
  // of echoing the request (it also re-clamps the compaction reserve,
  // which follows the current model live).
  const live = await liveModelOf(lane, loopContext);
  boot.liveModelRef = `${live.provider}/${live.id}`;
  // The switch committed a re-clamped level with the
  // model — the audit rows follow it.
  boot.liveThinkingRef = effective;
  // An explicit climb moves the auto
  // trigger's streak out from under it — restart the count on
  // the new model without spending the single auto slot.
  resetAutoEscalation(escalation.auto);
  return boot.liveModelRef;
}

// `/thinking <level>` and the cycle key. The clamp is Kubic's own: a level
// the live model does not support resolves to the nearest one, and the
// caller reports the EFFECTIVE value, never the requested one.
async function switchLaneThinking(
  inputs: BootedLoopInputs,
  level: ModelThinkingLevel,
  loopContext: Context,
): Promise<ModelThinkingLevel> {
  const { boot, lane, models } = inputs;
  const live = await liveModelOf(lane, loopContext);
  const model = models.getModel(live.provider, live.id) as AnyModel | undefined;
  const effective =
    model === undefined ? level : clampThinking(models, model, level);
  await lane.conversation.configure({ thinkingLevel: effective }, loopContext);
  const agent = await lane.conversation.agent(loopContext);
  // The audit rows name the committed level.
  const committed = agent.thinkingLevel ?? effective;
  boot.liveThinkingRef = committed;
  return committed;
}

// The picker's catalog. Only providers the assembly
// marked usable are offered (a keyless built-in would fail at the
// request, not at the switch); an injected test catalog has no
// receipt, so every registered provider counts as usable there.
async function listLaneModels(
  inputs: BootedLoopInputs,
  loopContext: Context,
): Promise<readonly TuiModelChoice[]> {
  const { lane, models } = inputs;
  const assembled = inputs.boot.assembled;
  const live = await liveModelOf(lane, loopContext);
  const rows: TuiModelChoice[] = [];
  for (const provider of models.getProviders()) {
    if (assembled !== undefined) {
      const info = assembled.providers.get(provider.id);
      if (info !== undefined && !info.usable) continue;
    }
    const note =
      assembled === undefined
        ? undefined
        : assembled.providers.get(provider.id)?.origin;
    for (const model of models.getModels(provider.id)) {
      rows.push({
        provider: provider.id,
        id: model.id,
        current: provider.id === live.provider && model.id === live.id,
        ...(note === undefined ? {} : { note }),
        contextWindow: model.contextWindow,
        reasoning: model.reasoning,
        thinking: supportedThinking(models, model as AnyModel),
      });
    }
  }
  return rows;
}

// The picker's provider headers. A keyless built-in is
// listed with the variable Pi's auth check would read; an injected
// test catalog has no receipt, so every provider counts as usable.
async function listLaneProviders(
  inputs: BootedLoopInputs,
): Promise<readonly TuiProviderChoice[]> {
  const assembled = inputs.boot.assembled;
  const providers = inputs.models.getProviders().map((provider) => {
    const info = assembled?.providers.get(provider.id);
    return {
      id: provider.id,
      usable: info?.usable ?? true,
      ...(info?.authSource === undefined ? {} : { keySource: info.authSource }),
    };
  });
  const keyless = providers
    .filter((provider) => !provider.usable)
    .map((provider) => provider.id);
  const hints =
    keyless.length === 0
      ? new Map<string, string>()
      : await providerKeyHints(keyless);
  return providers.map((provider) => {
    const keyVar = hints.get(provider.id);
    return keyVar === undefined ? provider : { ...provider, keyVar };
  });
}

// Trajectory per settled turn: the same record
// `kubic run` writes, holding the session's latest settled turn.
// The entries and the transcript come from the shared adapter —
// never a second entry reader.
async function recordTuiTurn(
  inputs: BootedLoopInputs,
  escalation: LaneEscalation,
  turn: TuiTurnRecord,
): Promise<void> {
  const { lane, context, options } = inputs;
  const entries = await readConversationEntries(lane.conversation, context);
  // The live model can have moved since boot (`/model`), so the
  // trajectory records what the lane actually runs — the same read
  // the returned `model` and the status bar use.
  let live = await liveModelOf(lane, context);
  // The single automatic trigger — N
  // consecutive tool-failure turns climb one rung, once per run,
  // never back. Runs before the trajectory persist so the
  // settling turn's own record already carries the climb.
  noteAutoEscalationTurn(
    escalation.auto,
    turn.turn?.kind === 'failed' ? turn.turn.reason : undefined,
  );
  if (escalation.ladder !== undefined && shouldAutoEscalate(escalation.auto)) {
    const next = nextLadderRung(
      escalation.ladder.steps,
      `${live.provider}/${live.id}`,
    );
    if (next !== undefined) {
      try {
        await escalateLaneModel(
          lane,
          escalation.ladder,
          next,
          `${AUTO_ESCALATION_TOOL_FAILURES} consecutive tool failures`,
          context,
          (event) => escalation.record(event),
        );
        markAutoEscalated(escalation.auto);
        // The climb moved the lane: the trajectory below names
        // what the lane runs now, not what ran the settled turn.
        live = await liveModelOf(lane, context);
      } catch {
        // Best-effort: a refused climb (the shared budget burned
        // by explicit climbs since the streak started) leaves the
        // run intact; the next tool-failure retries while the
        // streak holds. escalateLaneModel validates before it
        // mutates, so a refusal records nothing.
      }
    }
  }
  persistRunTrajectory({
    sessionsRoot: inputs.root,
    sessionId: inputs.id,
    agentId: options.agentId ?? 'root',
    role: options.role ?? DEFAULT_RUN_ROLE,
    prompt: turn.prompt,
    entries,
    model: { provider: live.provider, id: live.id },
    cwd: inputs.cwd,
    skills: [...inputs.skillNames],
    startedAt: turn.startedAt,
    endedAt: Date.now(),
    outcome: tuiTurnOutcome(turn, entriesToTranscript(entries)),
    // Every climb this run recorded —
    // explicit and automatic — lands on the trajectory, oldest
    // first. The file is overwritten per settled turn, so the
    // full sink ships every time, never a delta.
    ...(escalation.events.length === 0
      ? {}
      : {
          escalations: escalation.events.map((event) =>
            toTrajectoryEscalation(event, null),
          ),
        }),
    // An unreadable ledger or journal is a transcript notice: the
    // screen is up, so a stderr line would paint over it.
    warn: (line: string): void => {
      inputs.transcriptNotices.push(`warning: ${line}`);
    },
  });
}
