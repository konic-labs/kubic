// The prod `kubic tui` boot: the shared session bootstrap plus the loop
// surface the interactive path drives.
import { join } from 'node:path';
import {
  DEFAULT_RESERVE_TOKENS,
  effectiveReserveTokens,
} from '@kubic/agent/compaction';
import type { Lane } from '@kubic/agent/lane/boot';
import { escalateLaneModel } from '@kubic/agent/lane/boot';
import {
  describePendingSettlement,
  inspectPending,
  pendingInputText,
  settlePending,
} from '@kubic/agent/lane/pending';
import type {
  SessionHandle,
  SessionStore,
} from '@kubic/agent/lane/session-store';
import { forkSession, listSessions } from '@kubic/agent/lane/session-store';
import {
  entriesToTranscript,
  readConversationEntries,
} from '@kubic/agent/lane/transcript';
import type { AnyModel, EscalationLadder } from '@kubic/agent/model-select';
import {
  clampThinking,
  ModelSelectError,
  supportedThinking,
} from '@kubic/agent/model-select';
import { walkFiles } from '@kubic/agent/ops/walk';
import type { MutableModels } from '@kubic/agent/pi-boundary';
import { BACKGROUND_CONTEXT } from '@kubic/agent/pi-boundary';
import type { ModelEscalationEvent } from '@kubic/agent/prompts';
import { expandSkillInvocation } from '@kubic/agent/skills';
import { DEFAULT_RUN_ROLE } from '@kubic/core/run-role';
import type { ExecutionEnv, FileSystem } from '@kubic/exec/env';
import type { FileJournalStore } from '@kubic/exec/journal';
import type {
  InstalledPolicy,
  SessionFullAccessGrant,
} from '@kubic/host/approvals';
import { fullAccessInForceWarning } from '@kubic/host/approvals';
import { providerKeyHints } from '@kubic/host/models';
import { TurnSpans } from '@kubic/host/run';
import type { SessionSummary, SessionUsageRow } from '@kubic/host/sessions';
import {
  readSessionUsage,
  summarizeProjectSessions,
} from '@kubic/host/sessions';
import { describeSkillSkips } from '@kubic/host/skills';
import type { StatusUsageRow } from '@kubic/tui/status-bar';
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
} from '../config-runtime.js';
import { persistRunTrajectory } from '../run/trajectory.js';
import type { BootRefusal } from '../session/bootstrap.js';
import { SessionBoot } from '../session/bootstrap.js';
import { liveModelOf, tuiLoop } from './lane-loop.js';
import { tuiTurnOutcome } from './outcome.js';
import type {
  ContextLimits,
  TuiLaneBoot,
  TuiModelChoice,
  TuiRunOptions,
} from './types.js';

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

// A session's `pi.usage` buckets as status-bar rows. A model
// bucket is keyed `provider/modelId` — split at the FIRST slash, because a
// model id may itself contain slashes (openrouter/anthropic/…) — and a tool
// bucket has no provider/model identity, so it is labelled `tool:<name>`
// exactly as `kubic cost` labels it. The bar reads only the counters; the
// names keep the row shape honest.
export function statusRowsFromSessionUsage(
  rows: readonly SessionUsageRow[],
): StatusUsageRow[] {
  return rows.map((row) => {
    if (row.kind === 'tool') {
      return { provider: 'tool', model: row.key, usage: row.usage };
    }
    const at = row.key.indexOf('/');
    return {
      provider: at === -1 ? '' : row.key.slice(0, at),
      model: at === -1 ? row.key : row.key.slice(at + 1),
      usage: row.usage,
    };
  });
}

// A refused tool selection: a usage error (exit 2), not a generic lane boot
// failure.
export class ToolSelectionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ToolSelectionError';
  }
}

// The prod lane boot: the shared session bootstrap (session, role, model,
// policy, journal baseline, skills, lane) plus the loop surface the
// interactive path drives.
export async function bootTuiLane(
  sessionId?: string,
  options: TuiRunOptions = {},
): Promise<TuiLaneBoot> {
  const context = BACKGROUND_CONTEXT;
  // Warnings for the transcript, never stderr: the screen owns the terminal.
  // The skill loader's unresolvable --skill and each settled turn's
  // trajectory write push here; the loop drains them.
  const transcriptNotices: string[] = [];
  // Warnings that must show before the screen opens (a refused
  // models.json): they ride the boot notices, printed on stderr first.
  const bootWarnings: string[] = [];
  // The model and thinking notices of the boot: a model switched or kept,
  // a clamped level. The footer names them from the first render.
  const modelNotices: string[] = [];
  // The turn cell the loop's counter fills post-boot via
  // setCurrentTurnSupplier. Unwired (undefined) reads turn-less, so a
  // boot without a loop behaves like a headless run.
  const turnCell: { supplier?: () => number | undefined } = {};
  const boot = new SessionBoot(
    {
      command: 'tui',
      context,
      ...(sessionId === undefined ? {} : { sessionId }),
      ...(options.role === undefined ? {} : { role: options.role }),
      ...(options.toolSelection === undefined
        ? {}
        : { tools: options.toolSelection }),
      ...(options.noTools === undefined ? {} : { noTools: options.noTools }),
      ...(options.noSkills === undefined ? {} : { noSkills: options.noSkills }),
      ...(options.skillsList === undefined
        ? {}
        : { cliSkills: options.skillsList }),
      ...(options.dangerouslySkipApprovals === undefined
        ? {}
        : { dangerouslySkipApprovals: options.dangerouslySkipApprovals }),
      // The answer seat: with the overlay's surface attached, `kubic tui`
      // is the command that can actually collect a verdict on a challenged
      // call instead of refusing it unseen.
      ...(options.answer === undefined ? {} : { answer: options.answer }),
      currentTurn: () => turnCell.supplier?.(),
    },
    {
      sessionsRoot: options.sessionsRoot,
      env: options.env,
      classes: options.classes,
      policySource: options.policySource,
      approvals: options.approvals,
      policy: options.policy,
      models: options.models,
      model: options.model,
      streamTuning: options.streamTuning,
      thinking: options.thinking,
      compaction: options.compaction,
      agentId: options.agentId,
      journalRetention: options.journalRetention,
      reconcileOutOfScope: options.reconcileOutOfScope,
      systemPromptSection: options.systemPromptSection,
      modelPolicy: options.modelPolicy,
      trustProject: options.trustProject,
      skills: options.skills,
      roles: options.roles,
    },
    {
      ...(options.debug === undefined ? {} : { debug: options.debug }),
      warn: (line) => bootWarnings.push(line),
      modelNotice: (line) => modelNotices.push(line),
      thinkingNotice: (line) => modelNotices.push(line),
      // An unresolvable explicit --skill is a transcript notice, never only
      // a line on the debug sink the TUI drops — so a typo cannot read as a
      // loaded skill.
      skillsWarn: (line) => {
        transcriptNotices.push(`warning: ${line}`);
      },
      // No debug footer on the alt-screen: loader lines are dropped (the
      // block itself is observable).
      skillsLog: () => undefined,
    },
  );
  const badSession = boot.validateSessionId();
  if (badSession?.kind === 'usage') throw new Error(badSession.message);
  const badTools = boot.validateTools();
  if (badTools?.kind === 'usage')
    throw new ToolSelectionError(badTools.message);
  const opened = await boot.open();
  if (opened?.kind === 'store') throw opened.error;
  const session = boot.session as SessionHandle;
  const id = session.id;
  const root = boot.root;
  // The session's committed spend, read from its own `pi.usage`
  // ledger (the reader — the same numbers `kubic cost` prints) BEFORE the
  // lane adopts the storage. Best-effort: a torn or foreign usage document
  // must never block a boot; the bar then starts from zero.
  let usageRows: StatusUsageRow[] = [];
  try {
    usageRows = statusRowsFromSessionUsage(
      await readSessionUsage(session.storage, context),
    );
  } catch {
    usageRows = [];
  }
  // The quit's last-resort kill drain. keys every bash group
  // by String(conversation.id): whatever is still registered when the quit
  // runs is killed here — before the sweep and the close — because a tool
  // may register its kill after the abort bound gave up on it. A settled
  // turn's handles are forgotten (forgetKills), so a kept background job is
  // not this quit's to kill.
  let killRemaining: (() => void) | undefined;
  // The TUI's run end is its close — quit, SIGINT, EOF — so the end-of-run
  // sweep rides it. There is no closed-latch: idempotence comes from
  // `reconcile`'s per-path after-hash comparison, so a second close on an
  // unchanged tree appends nothing.
  const close = async (): Promise<void> => {
    try {
      killRemaining?.();
    } catch {
      // A kill that already exited is not a reason to skip the sweep.
    }
    await boot.teardown();
  };
  try {
    const refused = await boot.boot();
    if (refused !== undefined) throw bootRefusalError(refused);
    const booted = boot.lane as Lane;
    const models = boot.models as MutableModels;
    const assembled = boot.assembled;
    const installed = boot.installed as InstalledPolicy;
    const journal = boot.journal as FileJournalStore;
    const store = boot.store as SessionStore;
    const bridge = boot.bridge;
    const env = boot.env as ExecutionEnv;
    const selectedRole = boot.role;
    const enterprisePolicy = options.modelPolicy;
    // The loaded skill names, for the trajectory's resources; the invocable
    // skills (admitted + gate-passed, hidden included, withheld excluded),
    // so `/skill:` expands and completes against the boot's gated set; and
    // the skills the loader met but did not load, for the boot notices.
    const skillNames = (boot.skills?.skills ?? []).map((skill) => skill.name);
    const bootedSkillList = boot.skills?.invocable ?? [];
    const skillSkips = boot.skills?.skipped ?? [];
    // The run's escalation ladder: the role's own rungs win over the merged
    // `[model]` ones (`resolveLaneLadder`), and the record lives here — one
    // ladder object per boot, so every explicit climb and the single auto
    // climb draw from the same budget. Undefined when nothing configured a
    // ladder: the `/model` switch keeps its existing path.
    const laneLadderSteps = resolveLaneLadder(
      options.escalate,
      selectedRole?.resolved.escalate,
    );
    const laneLadder: EscalationLadder | undefined =
      laneLadderSteps === undefined
        ? undefined
        : {
            steps: [...laneLadderSteps.steps],
            maxEscalations: laneLadderSteps.maxEscalations,
            record: [],
          };
    // The climbs this run recorded: the sink every escalateLaneModel call
    // reports to — the trajectory event and the transcript line read them
    // from here.
    const escalationEvents: ModelEscalationEvent[] = [];
    // The single automatic trigger's streak: consecutive tool-failure turns
    // climb one rung, once per run.
    const autoEscalation = createAutoEscalation();
    // Transcript rows already reported: the drain below reports each
    // recorded climb once, however many turns settle.
    let reportedEscalations = 0;
    killRemaining = (): void => {
      // Every bash group is keyed by the conversation id, so the quit's
      // backstop drains exactly that key (forgetKills may already have
      // dropped a settled turn's handles — that is the point).
      for (const kill of booted.kills.drain(String(booted.conversation.id))) {
        try {
          kill();
        } catch {
          // Already exited — the registry drains every entry regardless.
        }
      }
    };
    // A turn a dead process left open would sit until its guarded resume timed
    // out; the interactive policy is the durable abort — its approvals would
    // need the overlay, which is not on screen yet, and the operator is present
    // to re-send. The interrupted prompt's own text is named too when the dead
    // process had already placed it (the "resume this very prompt" rule): the
    // operator sees WHAT was interrupted. The outcome is named in the footer
    // from the first render.
    const pendingNotices: string[] = [];
    const pending = await inspectPending(booted, context);
    if (pending.pending) {
      const interrupted = await pendingInputText(booted, context);
      const settlement = await settlePending(booted, 'abort', {
        context,
        kills: booted.kills,
      });
      const notice = describePendingSettlement(pending.summary, settlement);
      pendingNotices.push(
        interrupted === undefined
          ? notice
          : `${notice} — interrupted prompt: ${interrupted}`,
      );
    }
    const fullAccess = installed.posture.fullAccess;
    // The model the lane actually runs: the status bar, the
    // usage rows the turn runner records and the context gauge all
    // read this.
    const runningModel = await liveModelOf(booted, context);
    // The thinking level the lane actually
    // runs — read back from the committed agent document, exactly the
    // value whose clamp (or keep) the boot notices already reported. The
    // seed below shows this from the first frame; a stale seed would
    // disagree with the lane until the first turn's refresh.
    const runningThinking =
      (await booted.conversation.agent(context)).thinkingLevel ?? 'off';
    return {
      sessionId: id,
      model: `${runningModel.provider}/${runningModel.id}`,
      // The injected sink, threaded to the turn runner
      // for its fault and token lines (absent in prod — no --debug flag).
      debug: options.debug,
      // Per-turn spans next to the headless artifact — the
      // session's spans.jsonl carries one run span per TUI turn plus its
      // tool spans. Best-effort: telemetry never fails a turn or a boot.
      turnSpans: {
        turns: new TurnSpans(id),
        write: (artifact: string): void => {
          try {
            bridge.appendFile(join(id, 'spans.jsonl'), artifact);
          } catch {
            // A failed artifact write is not a turn failure.
          }
        },
      },
      thinking: runningThinking,
      // The resolved set travels on the boot so the
      // `/scoped-models` case (a different closure) can report it.
      scopedModels:
        selectedRole === undefined
          ? undefined
          : {
              role: selectedRole.resolved.name,
              models:
                selectedRole.resolved.models === undefined
                  ? undefined
                  : [...selectedRole.resolved.models],
            },
      // The gauge needs the running model's window; a catalog
      // that does not know it yields none and the gauge stays off.
      contextLimits: contextLimitsOf(
        models,
        runningModel.provider,
        runningModel.id,
      ),
      journal,
      // `/resume` lists THIS boot's sessions store; `/undo`
      // resolves journal paths against the same workspace root.
      keySourceOf: (provider: string) =>
        assembled?.providers.get(provider)?.authSource,
      // A session records the workspace it booted in (the boot env's cwd),
      // so "this project" is matched against the same directory. Each
      // summary parses a session file, so one read serves the palette and
      // `/resume` for SESSION_SUMMARY_TTL_MS.
      summarizeSessions: cachedSummaries((exclude) =>
        summarizeProjectSessions({
          sessionsRoot: root,
          workspace: env.cwd,
          ...(exclude === undefined ? {} : { exclude }),
          context,
        }),
      ),
      listSessions: async () => {
        const rows = await listSessions(store, context);
        return rows.map((row) => ({
          id: row.id,
          ...(row.meta?.cwd === undefined ? {} : { cwd: row.meta.cwd }),
          ...(row.meta?.createdAt === undefined
            ? {}
            : { createdAt: row.meta.createdAt }),
        }));
      },
      cwd: env.cwd,
      // The turn boundary of `allow all edits this turn`.
      endApprovalTurn: () => installed.endTurn?.(),
      editsApprovedThisTurn: () => installed.editsApprovedThisTurn?.() === true,
      // The toggle's host path. `installed.setFullAccess` flips
      // the live posture the ask reads and writes posture.json + the
      // row; the returned grant carries the warning the caller reports.
      setFullAccess: (enabled: boolean): SessionFullAccessGrant => {
        const command = `tui /approvals ${enabled ? 'on' : 'off'}`;
        installed.setFullAccess?.(enabled, `kubic ${command}`);
        return enabled
          ? {
              posture: installed.posture,
              warning: `full access enabled for session ${id} — every challenged call runs without asking`,
            }
          : {
              posture: installed.posture,
              warning: `full-access revoked for session ${id} — every challenged call asks again`,
            };
      },
      reconcile: () => {
        boot.reconciliation?.sweep();
      },
      rebaseline: (turn: number) => {
        boot.reconciliation?.rebaseline(turn);
      },
      // The lane samples this cell per tool call (through
      // LaneBootOptions.currentTurn) — installing the loop's counter here
      // keeps tool entries on the sweep numbering without touching boot.
      setCurrentTurnSupplier: (supplier: () => number | undefined) => {
        turnCell.supplier = supplier;
      },
      listFiles: workspaceFileLister(env),
      // Explicit skill invocation over the invocable
      // set — hidden skills included, withheld skills excluded (their
      // names resolve unknown, and completion never lists them).
      skillInvocation: {
        names: bootedSkillList.map((skill) => skill.name),
        invoke: (name: string, instructions?: string) =>
          expandSkillInvocation(bootedSkillList, name, instructions),
      },
      forkAt: async (at: number) =>
        (await forkSession(store, id, { at }, context)).id,
      ...(modelNotices.length === 0
        ? {}
        : { modelNotice: modelNotices.join('; ') }),
      ...(pendingNotices.length === 0
        ? {}
        : { pendingNotice: pendingNotices.join('; ') }),
      fullAccess,
      usageRows,
      // The loader lines for skipped skills ride the boot notices once: one
      // notice (warning on stderr before the
      // alt-screen opens, via the runner below). A clean boot stays
      // silent: `describeSkillSkips` is undefined when nothing was
      // skipped.
      ...((): { notices?: string[] } => {
        const skillSkipNotice = describeSkillSkips(skillSkips);
        const notices = [
          ...bootWarnings,
          ...(fullAccess
            ? [boot.fullAccessWarning ?? fullAccessInForceWarning(id)]
            : []),
          ...(skillSkipNotice === undefined ? [] : [skillSkipNotice]),
        ];
        return notices.length === 0 ? {} : { notices };
      })(),
      approvalsSkipped: installed.approvalsSkipped,
      loop: {
        ...tuiLoop(booted, context),
        // The LIVE model's modalities, resolved against the same
        // catalog `/model` switches through — a switch to a text-only model
        // refuses the next attachment (and clears the pending ones).
        supportsImages: async (loopContext) => {
          const live = await liveModelOf(booted, loopContext);
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
        // Resolve against the live catalog before touching the
        // conversation, so `/model typo/nope` fails by name and the lane
        // keeps the model it had; configure then commits the change to the
        // session's agent document, and the read-back is the label
        // every surface shows. The enterprise gate is the
        // boot's own: a switch outside `allowed_models`/`allowed_providers`
        // is refused with the same named error before the lane is touched,
        // so the live model stays put.
        switchModel: async (selection, loopContext, reason) => {
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
            enterprisePolicy,
            // Escalation outside the role's set is refused: the live model
            // stays put, like the enterprise gate.
            roleModelScope(selectedRole?.resolved),
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
          if (laneLadder !== undefined && requested !== boot.liveModelRef) {
            await escalateLaneModel(
              booted,
              laneLadder,
              requested,
              reason ?? `/model ${requested}`,
              loopContext,
              (event) => escalationEvents.push(event),
            );
          }
          // A switch re-clamps the thinking level to the
          // NEW model's ladder and commits both in one change, so the stored
          // level, the `/thinking` report, the cycle key and the status bar
          // agree with what the provider will actually be asked for.
          const agent = await booted.conversation.agent(loopContext);
          const effective = clampThinking(
            models,
            resolved,
            agent.thinkingLevel ?? 'off',
          );
          await booted.conversation.configure(
            {
              model: { provider: resolved.provider, modelId: resolved.id },
              thinkingLevel: effective,
            },
            loopContext,
          );
          // The agent document is the truth: read the live model back instead
          // of echoing the request (it also re-clamps the compaction reserve,
          // which follows the current model live).
          const live = await liveModelOf(booted, loopContext);
          boot.liveModelRef = `${live.provider}/${live.id}`;
          // The switch committed a re-clamped level with the
          // model — the audit rows follow it.
          boot.liveThinkingRef = effective;
          // An explicit climb moves the auto
          // trigger's streak out from under it — restart the count on
          // the new model without spending the single auto slot.
          resetAutoEscalation(autoEscalation);
          return boot.liveModelRef;
        },
        model: async (loopContext) => {
          const running = await liveModelOf(booted, loopContext);
          return `${running.provider}/${running.id}`;
        },
        // The thinking level lives in the same `pi.agent`
        // document as the model — nothing extra to persist, and a
        // resume restores it. The clamp is Kubic's own: a level
        // the live model does not support resolves to the nearest one, and
        // the caller reports the EFFECTIVE value, never the requested one.
        thinking: async (loopContext) => {
          const agent = await booted.conversation.agent(loopContext);
          return agent.thinkingLevel ?? 'off';
        },
        switchThinking: async (level, loopContext) => {
          const live = await liveModelOf(booted, loopContext);
          const model = models.getModel(live.provider, live.id) as
            | AnyModel
            | undefined;
          const effective =
            model === undefined ? level : clampThinking(models, model, level);
          await booted.conversation.configure(
            { thinkingLevel: effective },
            loopContext,
          );
          const agent = await booted.conversation.agent(loopContext);
          // The audit rows name the committed level.
          const committed = agent.thinkingLevel ?? effective;
          boot.liveThinkingRef = committed;
          return committed;
        },
        supportedThinking: async (loopContext) => {
          const live = await liveModelOf(booted, loopContext);
          const model = models.getModel(live.provider, live.id) as
            | AnyModel
            | undefined;
          return model === undefined
            ? ['off']
            : supportedThinking(models, model);
        },
        // The picker's catalog. Only providers the assembly
        // marked usable are offered (a keyless built-in would fail at the
        // request, not at the switch); an injected test catalog has no
        // receipt, so every registered provider counts as usable there.
        listModels: async (loopContext) => {
          const live = await liveModelOf(booted, loopContext);
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
        },
        // The picker's provider headers. A keyless built-in is
        // listed with the variable Pi's auth check would read; an injected
        // test catalog has no receipt, so every provider counts as usable.
        listProviders: async () => {
          const providers = models.getProviders().map((provider) => {
            const info = assembled?.providers.get(provider.id);
            return {
              id: provider.id,
              usable: info?.usable ?? true,
              ...(info?.authSource === undefined
                ? {}
                : { keySource: info.authSource }),
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
        },
        // Trajectory per settled turn: the same record
        // `kubic run` writes, holding the session's latest settled turn.
        // The entries and the transcript come adapter —
        // never a second entry reader.
        recordTurn: async (turn) => {
          const entries = await readConversationEntries(
            booted.conversation,
            context,
          );
          // The live model can have moved since boot (`/model`), so the
          // trajectory records what the lane actually runs — the same read
          // the returned `model` and the status bar use.
          let live = await liveModelOf(booted, context);
          // The single automatic trigger — N
          // consecutive tool-failure turns climb one rung, once per run,
          // never back. Runs before the trajectory persist so the
          // settling turn's own record already carries the climb.
          noteAutoEscalationTurn(
            autoEscalation,
            turn.turn?.kind === 'failed' ? turn.turn.reason : undefined,
          );
          if (laneLadder !== undefined && shouldAutoEscalate(autoEscalation)) {
            const next = nextLadderRung(
              laneLadder.steps,
              `${live.provider}/${live.id}`,
            );
            if (next !== undefined) {
              try {
                await escalateLaneModel(
                  booted,
                  laneLadder,
                  next,
                  `${AUTO_ESCALATION_TOOL_FAILURES} consecutive tool failures`,
                  context,
                  (event) => escalationEvents.push(event),
                );
                markAutoEscalated(autoEscalation);
                // The climb moved the lane: the trajectory below names
                // what the lane runs now, not what ran the settled turn.
                live = await liveModelOf(booted, context);
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
            sessionsRoot: root,
            sessionId: id,
            agentId: options.agentId ?? 'root',
            role: options.role ?? DEFAULT_RUN_ROLE,
            prompt: turn.prompt,
            entries,
            model: { provider: live.provider, id: live.id },
            cwd: env.cwd,
            skills: skillNames,
            startedAt: turn.startedAt,
            endedAt: Date.now(),
            outcome: tuiTurnOutcome(turn, entriesToTranscript(entries)),
            // Every climb this run recorded —
            // explicit and automatic — lands on the trajectory, oldest
            // first. The file is overwritten per settled turn, so the
            // full sink ships every time, never a delta.
            ...(escalationEvents.length === 0
              ? {}
              : {
                  escalations: escalationEvents.map((event) =>
                    toTrajectoryEscalation(event, null),
                  ),
                }),
            // An unreadable ledger or journal is a transcript notice: the
            // screen is up, so a stderr line would paint over it.
            warn: (line: string): void => {
              transcriptNotices.push(`warning: ${line}`);
            },
          });
        },
        // The transcript rows for recorded climbs.
        // The runner drains this after every settled turn — each climb is
        // reported once, however many turns settle afterwards.
        drainEscalationRows: () => {
          const rows = escalationEvents
            .slice(reportedEscalations)
            .map((event) => formatEscalationRow(event));
          reportedEscalations = escalationEvents.length;
          return rows;
        },
        // The notices recorded since the last drain: the boot's skill
        // warnings and the settled turn's trajectory warnings.
        drainNotices: () => transcriptNotices.splice(0),
      },
      close,
    };
  } catch (error) {
    await close();
    throw error;
  }
}

// A boot refusal as the error the TUI command maps to its exit code: a bad
// tool selection is a usage error (exit 2), no usable model a provider
// error (exit 6), everything else its own error.
function bootRefusalError(refusal: BootRefusal): unknown {
  switch (refusal.kind) {
    case 'usage':
      return new ToolSelectionError(refusal.message);
    case 'provider':
      return new ModelSelectError(refusal.message);
    case 'store':
      return refusal.error;
    case 'failed':
      return refusal.cause ?? new Error(refusal.message);
    case 'cancelled':
      return new Error('the boot was cancelled');
  }
}

// How long one read of the session summaries serves the palette
// and `/resume` (a summary parses a whole session file).
export const SESSION_SUMMARY_TTL_MS = 30_000;

export function cachedSummaries(
  read: (exclude?: string) => Promise<readonly SessionSummary[]>,
  now: () => number = Date.now,
): (exclude?: string) => Promise<readonly SessionSummary[]> {
  let cached:
    | {
        readonly exclude: string | undefined;
        readonly at: number;
        readonly rows: Promise<readonly SessionSummary[]>;
      }
    | undefined;
  return (exclude) => {
    if (
      cached !== undefined &&
      cached.exclude === exclude &&
      now() - cached.at < SESSION_SUMMARY_TTL_MS
    ) {
      return cached.rows;
    }
    const rows = read(exclude);
    cached = { exclude, at: now(), rows };
    // A failed read is not kept: the next ask tries again.
    rows.catch(() => {
      if (cached?.rows === rows) cached = undefined;
    });
    return rows;
  };
}

// The `@` mention source — every file the find/grep walk would
// visit (gitignore rules honoured, node_modules/.git skipped, bounded),
// workspace-relative. Cached for a short window so a burst of keystrokes
// walks once; a failed walk lists nothing.
export const FILE_LIST_TTL_MS = 2000;

export function workspaceFileLister(
  env: { readonly fs: FileSystem },
  now: () => number = Date.now,
): () => readonly string[] {
  let cached: readonly string[] = [];
  let at = Number.NEGATIVE_INFINITY;
  return () => {
    if (now() - at < FILE_LIST_TTL_MS) return cached;
    try {
      cached = walkFiles(env.fs, '.')
        .entries.filter((entry) => !entry.isDirectory)
        .map((entry) => entry.path)
        .sort();
    } catch {
      cached = [];
    }
    at = now();
    return cached;
  };
}
