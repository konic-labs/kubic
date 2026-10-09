// Prod `kubic run -p` runner: the composition root drives the
// real lane headless and derives the terminus from the lane's own
// settled outcome (E1). Everything durable lands under
// <sessionsRoot>/<id>/ (E3): the transcript and usage rows in the session
// store, file effects in <id>/journal/ via lane interception, and the
// entry chain itself is the trajectory record — so every ref resolves to
// a real location. Resume keeps one chain: the -p prompt commits
// parent-linked to the last existing entry under a random id (E4).

import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { abortLane, forgetLaneKills } from '@kubic/agent/lane/abort';
import type { Lane, LaneCompactionOptions } from '@kubic/agent/lane/boot';
import {
  type KubicLaneEvent,
  subscribeLaneEvents,
} from '@kubic/agent/lane/events';
import {
  type ClassifiedFailure,
  classifyFailure,
  type RetryDecision,
} from '@kubic/agent/lane/failures';
import {
  describePendingSettlement,
  inspectPending,
  pendingInputText,
  settlePending,
} from '@kubic/agent/lane/pending';
import {
  laneConversationIdOf,
  type SessionHandle,
} from '@kubic/agent/lane/session-store';
import {
  entriesToTranscript,
  readConversationEntries,
  readSessionEntries,
  type TranscriptItem,
} from '@kubic/agent/lane/transcript';
import {
  awaitTurn,
  runTurnWithOverflowRecovery,
  type TurnOutcome,
  turnAbort,
  turnLaneRecord,
} from '@kubic/agent/lane/turn';
import type { ModelSelection } from '@kubic/agent/model-select';
import type { PermissionClasses, RunMode } from '@kubic/agent/permissions';
import {
  BACKGROUND_CONTEXT,
  type Context,
  createModels,
  createRegistry,
  type EntryRecord,
  Harness,
  type MutableModels,
  UserEntry,
  withCancel,
} from '@kubic/agent/pi-boundary';
import { expandSkillInvocation } from '@kubic/agent/skills';
import type { StreamTuningTables } from '@kubic/agent/stream-options';
import { DEFAULT_RUN_ROLE } from '@kubic/core/run-role';
import type { ExecutionEnv } from '@kubic/exec/env';
import { NodeExecutionEnv } from '@kubic/exec/env';
import { gitHeadOf, withDetachedCheckout } from '@kubic/exec/git-clean';
import type { JournalRetention } from '@kubic/exec/journal';
import {
  type ApprovalConfig,
  fullAccessInForceWarning,
  type InstalledPolicy,
  TIMEOUT_REASON_MARKER,
} from '@kubic/host/approvals';
import {
  appendToLedger,
  auditLedgerDirFor,
  runStartAudit,
} from '@kubic/host/audit';
import type { RuntimeThinking, RuntimeVerify } from '@kubic/host/config';
import { readSessionRunUsage } from '@kubic/host/cost';
import { emitNoIsolationNotice, shouldEmitNotice } from '@kubic/host/doctor';
import type { EffectivePolicy } from '@kubic/host/policy';
import type { RoleLayerInput } from '@kubic/host/roles';
import type { DebugSink, RunOutcome, RunProgressSink } from '@kubic/host/run';
import {
  DEFAULT_RUN_TIMEOUT_MS,
  type HeadlessRunResult,
  hasVerifyCommands,
  hookErrorLine,
  type LaneOutcomeTerminus,
  MAX_RUN_TIMEOUT_MS,
  mapCaughtErrorToTerminus,
  mapLaneOutcomeToFailure,
  modelLine,
  type RetryRecord,
  RunSpans,
  runSpanHooks,
  runVerifier,
  serializeSpanArtifact,
  verifierLabels,
} from '@kubic/host/run';
import {
  matchableSecrets,
  redactingSink,
  redactSecretValues,
} from '@kubic/host/secret-refs';
import { defaultSessionsRoot } from '@kubic/host/sessions';
import { persistRunTrajectory } from './run-trajectory.js';
import { type BootRefusal, SessionBoot } from './session/bootstrap.js';

export interface HeadlessRunOptions {
  sessionId?: string;
  timeoutMs?: number;
  maxTurns?: number;
  // Skills surface: `--no-skills` disables layered
  // discovery and `--skill <path>` adds one explicitly (repeatable —
  // explicit intent applies even under --no-skills).
  noSkills?: boolean;
  skills?: string[];
  // `--invoke-skill <name>` — one explicit skill
  // (hidden included) whose content runs as the turn prompt, with the
  // run's prompt as instructions. Unknown names fail the run closed.
  invokeSkill?: string;
  // Role selection: `--role <name>` boots the lane as
  // the role document `.kubic/roles/<name>.md` defines — its prompt text
  // replaces the constant and its resolved tool set becomes the
  // lane's allowlist. Absent means the default, unchanged.
  role?: string;
  // Debug channel: when set, the run emits its lane/tool
  // debug lines to the injected sink (stderr in prod). The span artifact is
  // written either way — spans are the durable half.
  debug?: boolean;
  // `--dangerously-skip-approvals` — full access for the
  // session this run creates or resumes, recorded in its posture.json and
  // the audit ledger, never in config.
  dangerouslySkipApprovals?: boolean;
  // `--tools <a,b>` narrows the run's tool
  // set (intersected with the classes/role/enterprise sets — never widened);
  // `--no-tools` is the empty set. Mutually exclusive, validated before the
  // lane boots.
  tools?: readonly string[];
  noTools?: boolean;
  // Explicit autonomous mode, recorded on the run's
  // session. Absent means off (interactive), never assumed.
  autonomous?: boolean;
  // Live progress on an interactive terminal (heading, compact
  // no-isolation notice, one line per tool call). Absent: today's stderr warning
  // block and no progress output.
  progress?: RunProgressSink;
}

export interface HeadlessRunDeps {
  sessionsRoot?: string;
  models?: MutableModels;
  model?: ModelSelection;
  // Request options: the merged `[model]` tuning plus
  // every `[roles.<name>]` table that sets a key (runtimeStreamTuning).
  // The boot resolves them against the run's role into `settings.stream`.
  // Absent means untuned — the provider defaults stand.
  streamTuning?: StreamTuningTables;
  // The lane's agent id: the configured `[agent].name`, threaded
  // from runtimeLaneDeps. Absent means 'root' — the shipped behaviour, byte
  // for byte (journal attribution follows it).
  agentId?: string;
  env?: ExecutionEnv;
  context?: Context;
  /** Diagnostics sink (reconcile and overlap notices, skill-load reports). */
  debug?: (line: string) => void;
  // Runtime config projections: the permission classes and the
  // journal retention bound the loaded configuration produced. Absent means
  // the lane's own defaults and an unbounded journal (never an invented
  // limit).
  policyClasses?: PermissionClasses;
  // The config layer's own record of where the classes came from
  // ('default' when nothing configured them). Absent means 'default' — the
  // documented safe default, never an assumed operator choice.
  policySource?: 'config' | 'default';
  // The config `[approvals]` policy (route, maxPendingMs,
  // autoApprove, requireJustification, sessionScoped). Absent means the
  // documented defaults.
  approvals?: ApprovalConfig;
  // Enterprise policy: the composition root resolves it
  // once (`runtimePolicy` in config-runtime) and threads it here. A run only
  // gates its tool set and model selection when the layer actually
  // configured those halves — an absent [policy] section never narrows
  // anything.
  modelPolicy?: EffectivePolicy;
  journalRetention?: JournalRetention;
  // Gate commands, from `[verify]` via runtimeRunDeps. Run
  // in the worktree after the run settles; their verdicts become the
  // trajectory's `signal:*` labels. Absent means nothing is verified.
  verify?: RuntimeVerify;
  // Thinking level, from `runtimeLaneDeps` via
  // prodRunDeps: the effective level with its source. A per-run source
  // (`cli` `--thinking` / `env` `KUBIC_MODEL_THINKING`, enterprise-frozen
  // included) is the lane's override; a file-layer source is the lane's
  // config default. Absent means the lane boots at the session's stored
  // level, a role default, or Pi's 'off'.
  thinking?: RuntimeThinking;
  // The installed-policy seat. Absent means the shipped
  // DEFAULT: the documented DEFAULT_PERMISSIONS classes plus the destructive/
  // network/confine guards and the approval ask, all derived by
  // installPolicy. Tests inject a variant here; nothing else may skip
  // the install, which is why the default is not an opt-in.
  policy?: InstalledPolicy;
  // Declared out-of-scope paths for the baseline.
  // Populated by `[journal] outOfScope` through runtimeRunDeps;
  // absent means the mechanism's own skips only — `.git/`, `.kubic/` and
  // `.gitignore` hits.
  reconcileOutOfScope?: string[];
  // [agent] systemPromptFile contents, from the same config
  // load — the boot composes them ahead of the skills block. Absent means
  // the lane assembles its prompt unchanged.
  systemPromptSection?: string;
  // The `[session]` compaction policy from the same
  // config load — the boot hands it to the settings. Absent means the
  // lane defaults (automatic, the default reserve, the default recent
  // window).
  compaction?: LaneCompactionOptions;
  // Debug sink for the debug lines. Defaults to stderr so a live
  // `kubic run --debug` emits without the composition root wiring anything;
  // tests inject an array collector instead.
  debugSink?: DebugSink;
  // Operator notices: the line naming what happened to a
  // pending operation a crashed run left open. Defaults to stderr; tests
  // inject a collector.
  notice?: (line: string) => void;
  // Skills inputs. Absent means the prod defaults: the
  // real home directory, this process's cwd, and the documented trust
  // opt-in (`KUBIC_TRUST_PROJECT`, the same switch the config layer reads).
  // Tests inject a home/cwd/trust triple to drive discovery over a fixture.
  skills?: {
    homeDir?: string;
    cwd?: string;
    trusted?: boolean;
    trustProject?: (dir: string) => boolean;
    // The config `skills` projection — resolved at
    // load, loaded with source 'settings'. Absent means none configured.
    settingsSkills?: string[];
  };
  // The per-path trust check (the store's resolved-root
  // decision plus the env opt-in), threaded from the composition root's
  // config load. It gates the project models.json and the ancestor project
  // skills on the path each resolves to. Absent falls back to the env flag.
  trustProject?: (path: string) => boolean;
  // Role-document inputs. Absent means the prod defaults:
  // this process's cwd (so `.kubic/roles/*.md` is read from the workspace)
  // through the real FileBridge. Tests inject a fixture cwd.
  roles?: {
    cwd?: string;
    layers?: RoleLayerInput[];
    // Project trust for the repo documents.
    // The composition root threads the config load's per-path check here
    // (`runtimeLaneDeps`); absent both means the root is untrusted.
    trusted?: boolean;
    trustProject?: (dir: string) => boolean;
    // The home directory whose `.kubic/roles` layer
    // under the project documents. Absent means no global source — the
    // composition root passes the real home; tests inject a fixture.
    homeDir?: string;
  };
  // Interrupt source (Ctrl-C, a supervisor SIGTERM, a closed terminal SIGHUP). Absent means the
  // real process. Tool children run in detached process groups, so a
  // terminal SIGINT never reaches them: without this seam the run died on
  // the default handler and orphaned them, skipping the drain, the sweep and
  // the session close. Tests inject an emitter.
  signals?: SignalSource;
  // Where models.json is read from (tests); absent means process.cwd().
  modelsCwd?: string;
  // User-facing warnings that must show without --debug (a refused
  // models.json). Absent means stderr — stdout stays consumable.
  warn?: (line: string) => void;
}

interface SignalSource {
  on(event: InterruptSignal, listener: (signal: string) => void): unknown;
  off(event: InterruptSignal, listener: (signal: string) => void): unknown;
}

type InterruptSignal = 'SIGINT' | 'SIGTERM' | 'SIGHUP';
const INTERRUPT_SIGNALS: readonly InterruptSignal[] = [
  'SIGINT',
  'SIGTERM',
  'SIGHUP',
];

// Guard exhaustion surfaces as control flow, never as a lane failure:
// caught below and mapped to turn_limit (--max-turns) or timeout (wall
// clock) with the ref triple intact.
class TurnLimitError extends Error {
  readonly turns: number;
  constructor(turns: number) {
    super(`turn limit reached after ${turns} turns`);
    this.turns = turns;
  }
}

class WallClockError extends Error {
  readonly ms: number;
  constructor(ms: number) {
    super(`run timed out after ${ms}ms`);
    this.ms = ms;
  }
}

// An interrupt (SIGINT/SIGTERM/SIGHUP) ends the turn like a guard does:
// control flow, mapped to `cancelled` after the drain — the
// run's exit code is 128+signo, the POSIX convention `kubic tui` uses.
class InterruptedError extends Error {
  readonly signal: string;
  constructor(signal: string) {
    super(`run interrupted by ${signal}`);
    this.signal = signal;
  }
}

function refs(
  id: string,
): Pick<HeadlessRunResult, 'journalRef' | 'usageRef' | 'trajectoryRef'> {
  return {
    journalRef: `journal:${id}`,
    usageRef: `usage:${id}`,
    trajectoryRef: `trajectory:${id}`,
  };
}

// The user-facing overflow line must tell the truth.
// The decision hook fires for every decision (including abandon), but
// only a retry_with_new_context compacts and retries — anything else
// stays silent, and the failure terminus already reports the failure.
export function overflowRecoveryNotice(
  decision: RetryDecision,
): string | undefined {
  if (decision.decision !== 'retry_with_new_context') return undefined;
  return `context overflow — compacting and retrying once (${decision.reason})`;
}

// The envelope record carries whether the retry
// happened, so --json distinguishes retried-then-failed (retried: true)
// from decided-to-retry-but-compaction-refused and abandoned
// (retried: false). Absent when the lane made no decision.
export function retryRecord(
  decision: RetryDecision | undefined,
  retried: boolean,
): RetryRecord | undefined {
  if (decision === undefined) return undefined;
  return { ...decision, retried };
}

function finished(
  id: string,
  terminus: HeadlessRunResult['terminus'],
  summary: string,
  errorMessage?: string,
  signal?: string,
  failure?: ClassifiedFailure,
  // The retry decision when the lane made one (overflow
  // recovery) — strategy, reason, notBefore and whether the retry
  // happened, also on success.
  retry?: RetryRecord,
): HeadlessRunResult {
  return {
    terminus,
    summary,
    sessionId: id,
    ...refs(id),
    ...(signal === undefined ? {} : { signal }),
    ...(failure === undefined ? {} : { failure }),
    ...(retry === undefined ? {} : { retry }),
    ...(errorMessage === undefined
      ? {}
      : { error: { kind: terminus, message: errorMessage } }),
  };
}

function storeFailure(
  sessionId: string | undefined,
  error: unknown,
): HeadlessRunResult {
  const message = error instanceof Error ? error.message : String(error);
  const terminus = mapCaughtErrorToTerminus(error);
  // A caught failure carries its failure classification too, so the
  // envelope never has to guess the domain from the exit code.
  const failure =
    terminus === 'workspace_unavailable'
      ? classifyFailure('workspace', 'workspace_failed', message)
      : classifyFailure('process', '', message);
  const ref = sessionId ?? 'unassigned';
  return {
    terminus,
    summary: message,
    sessionId: ref,
    ...refs(ref),
    failure,
    error: { kind: terminus, message },
  };
}

// The named non-answer a completed run with no assistant text reports: the
// summary is the model's own output or this sentence — never the operator's
// prompt echoed back as if it were a result.
export const NO_ASSISTANT_TEXT_SUMMARY =
  '(no assistant text — the run settled without output)';

// Final assistant text of the settled run for the result summary. A run
// that left no assistant text yields undefined; the caller reports the
// named non-answer (NO_ASSISTANT_TEXT_SUMMARY) instead of the prompt.
// Takes the shared transcript: newest assistant item wins.
export function assistantSummary(
  items: readonly TranscriptItem[],
): string | undefined {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index];
    if (item === undefined || item.kind !== 'assistant') continue;
    const text = item.text.trim();
    if (text === '') continue;
    return text.slice(0, 500);
  }
  return undefined;
}

// Terminus + failure for a settled turn: the failure code
// and its message go through the same settlement kernel the lane record
// does, so approval/workspace/provider failures keep their 4/5/6 classes
// and the precise code rides beside the terminus.
function failedTurnTerminus(outcome: TurnOutcome): LaneOutcomeTerminus {
  if (outcome.kind !== 'failed') return { terminus: 'failed' };
  return mapLaneOutcomeToFailure('failed', {
    code: outcome.reason,
    message: outcome.error ?? outcome.reason,
  });
}

// The terminus for a guard that stopped the run before or instead of a
// settlement: an interrupt is `cancelled` (128+signo), a wall-clock bound is
// `timeout` (exit 1), and `--max-turns` is `turn_limit` (exit 3), each with
// the ref triple intact.
function stoppedResult(
  id: string,
  error: Error,
  capture: { interrupted: boolean },
): HeadlessRunResult {
  if (error instanceof InterruptedError) {
    capture.interrupted = true;
    return finished(
      id,
      'cancelled',
      error.message,
      error.message,
      error.signal,
    );
  }
  if (error instanceof WallClockError) {
    return finished(id, 'timeout', error.message, error.message);
  }
  return finished(id, 'turn_limit', error.message, error.message);
}

// Capture of the run's transcript (the readers): the live conversation
// while the lane is open, the session storage otherwise. A read failure
// leaves the trajectory without actions, never the run without its result.
async function captureEntries(
  lane: Lane | undefined,
  session: SessionHandle,
  context: Context,
): Promise<EntryRecord[]> {
  try {
    return lane === undefined
      ? await readSessionEntries(session.storage, context)
      : await readConversationEntries(lane.conversation, context);
  } catch {
    return [];
  }
}

// How long the end-of-run lane abort may take before the run gives up on it.
// The kills have already run by then; this bounds a harness that is waiting
// on a task that ignores cancellation.
// How long the end-of-run lane abort may take before the run gives up on it.
// The kills have already run by then; this bounds a harness that is waiting
// on a task that ignores cancellation (a provider that never settles its
// stream), so the run always reports its own result.
const LANE_ABORT_BOUND_MS = 2_000;

// Best-effort conversation abort + kill drain on the divert paths (a guard
// or an interrupt abandoned a live turn): the durable stop is stated against
// a context that is NOT the cancelled bound, and the wait is bounded so the
// run's own result never hangs on it.
async function abortAbandonedLane(
  lane: Lane,
  report: (message: string) => void,
): Promise<void> {
  const cancel = withCancel(BACKGROUND_CONTEXT);
  const timer = setTimeout(
    () =>
      cancel.cancel(new Error(`lane abort exceeded ${LANE_ABORT_BOUND_MS}ms`)),
    LANE_ABORT_BOUND_MS,
  );
  try {
    await abortLane(lane, cancel.context);
  } catch (error) {
    report(
      `guard: drain failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  } finally {
    clearTimeout(timer);
  }
}

// The mapped result outranks telemetry: a throwing debug sink in the
// end-of-run cleanup must not replace the run's own HeadlessRunResult.
function guardedReport(
  report: ((message: string) => void) | undefined,
  message: string,
): void {
  try {
    report?.(message);
  } catch {
    // Swallowed by design — the mapped result stands.
  }
}

// One plain `pi.user` entry for a prompt no submission carried: a throwaway
// Harness over the session's own storage (no model layer is needed to write
// an entry), closed again immediately.
async function appendPromptEntry(
  session: SessionHandle,
  prompt: string,
  context: Context,
): Promise<void> {
  const harness = await Harness.open(
    session.adopt(),
    { models: createModels(), registry: createRegistry() },
    context,
  );
  try {
    // A forked session's prompt lands on its lane conversation.
    const conversation =
      session.meta.conversation === undefined
        ? await harness.root(context)
        : await harness.conversation(
            laneConversationIdOf(session.meta),
            context,
          );
    if (conversation === undefined)
      throw new Error(
        `session ${session.id}: its lane conversation is missing`,
      );
    await conversation.commit(async (tx) => {
      await tx.appendEntry(UserEntry, conversation.id, {
        model: [{ role: 'user', content: prompt, timestamp: Date.now() }],
      });
    }, context);
  } finally {
    await harness.close(context);
  }
}

// `submit` writes `pi.user` itself, so a run that reached its turn has
// exactly ONE user entry. Every other exit path — no model, a refused role,
// a signal between boot and the turn, a busy refusal — still keeps the
// prompt durable (the guarantee `kubic run -p` gives) through
// one plain entry write. The TRANSCRIPT decides, in both directions: a
// prompt already carried by an entry (the turn's own, a resumed run's, an
// earlier identical prompt) is never written twice, and a lane that booted
// but never admitted the prompt still gets its entry.
async function ensurePromptDurable(
  lane: Lane | undefined,
  session: SessionHandle,
  prompt: string,
  context: Context,
  report: (message: string) => void,
): Promise<void> {
  const entries = await captureEntries(lane, session, context);
  const present = entriesToTranscript(entries).some(
    (item) => item.kind === 'user' && item.text.trim() === prompt.trim(),
  );
  if (present) return;
  try {
    if (lane === undefined) {
      await appendPromptEntry(session, prompt, context);
    } else {
      await lane.conversation.commit(async (tx) => {
        await tx.appendEntry(UserEntry, lane.conversation.id, {
          model: [{ role: 'user', content: prompt, timestamp: Date.now() }],
        });
      }, context);
    }
  } catch (error) {
    report(
      `session: prompt not persisted: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

// The finished run reports its OWN usage — the session's usage
// rollup (what `kubic cost` reads), the tool calls it executed and the
// model that answered. Read after the session is closed; a run that never
// created a session, or a read that fails, keeps the refs-only report
// (never invented numbers).

// What the settled run leaves for its trajectory: filled
// as the run boots, read once after it settles.
interface RunCapture {
  startedAt: number;
  sessionsRoot?: string;
  sessionId?: string;
  cwd?: string;
  model?: { provider: string; id: string };
  // The thinking level the lane actually booted with
  // (post-clamp) — the trajectory names the applied level, the same source
  // as the envelope, never the request that may have been clamped.
  thinking?: string;
  role?: string;
  skills: string[];
  entries: unknown[];
  lane?: RunOutcome['lane'];
  interrupted: boolean;
  // Every provider key the request-time resolver has handed out so far: what
  // the debug channel, the session writes, the result and the trajectory are
  // scrubbed of. Empty until a models.json key is used.
  liveSecrets: () => string[];
}

// kubic run -p plus its trajectory: every run
// that attached a session writes <sessions-root>/<id>/trajectory.json when
// it settles — completed or not — and the result's trajectory ref names
// that file. A trajectory that cannot be written is reported on the warning
// channel; it never changes the run's own result.

// The `[lane]` debug line for a retry or compaction event, or
// undefined for any other event. The 1.0 harness reports the attempt and the
// error (the contract — no maxAttempts, no notBefore).
// A lane fault (pi-durable `task_failed` — Pi 1.0 has no
// `handler_error` event) maps to the handler_error line, and a
// committed response maps to the [model] token line. Both reuse the
// spans vocabulary formatters, so every path emits byte-identical lines.
export function laneActivityDebugLine(
  event: KubicLaneEvent,
): string | undefined {
  if (event.type === 'fault') {
    return hookErrorLine(event.code, event.message);
  }
  if (event.type === 'usage') {
    return modelLine(
      event.row.usage.input,
      event.row.usage.output,
      event.row.usage.cacheRead,
      `${event.row.provider}/${event.row.model}`,
    );
  }
  if (event.type === 'retry') {
    const attempt = event.attempt ?? 1;
    return event.phase === 'start'
      ? `[lane] retry attempt ${attempt} after error: ${event.error ?? 'unknown'}`
      : `[lane] retry attempt ${attempt} settled`;
  }
  if (event.type === 'compaction') {
    const reason = event.reason === undefined ? '' : ` (${event.reason})`;
    return event.phase === 'start'
      ? `[lane] compaction started${reason}`
      : `[lane] compaction finished${reason}`;
  }
  return undefined;
}

// The run's agent id: the configured `[agent].name`, else 'root'. It tags
// the run's journal, reconcile and trajectory entries.
function resolveRunAgentId(depsAgentId: string | undefined): string {
  return depsAgentId ?? 'root';
}

export async function runHeadlessPrompt(
  prompt: string,
  options: HeadlessRunOptions,
  deps: HeadlessRunDeps = {},
): Promise<HeadlessRunResult> {
  // The settled run's trajectory capture.
  const capture: RunCapture = {
    startedAt: Date.now(),
    skills: [],
    entries: [],
    interrupted: false,
    liveSecrets: () => [],
  };
  // The live lane model and the approval posture the lane
  // was installed with travel on the result (and so the --json envelope),
  // whatever path the run ends on.
  const report: {
    model?: string;
    posture?: 'approvals' | 'full-access';
    // The run's mode, set from the session record
    // once the session exists and merged onto the result below.
    mode?: RunMode;
  } = {};
  // The base the run starts from: captured before any turn, so
  // an agent that commits mid-run cannot move the baseline it is judged by.
  const base = gitHeadOf(deps.env?.cwd ?? process.cwd());
  const result = await runHeadlessPromptOnce(
    prompt,
    options,
    deps,
    report,
    capture,
  );
  const withPosture =
    report.posture === undefined
      ? result
      : { ...result, posture: report.posture };
  const settledMode =
    report.mode === undefined
      ? withPosture
      : { ...withPosture, mode: report.mode };
  let settled: HeadlessRunResult;
  if (settledMode.sessionId === 'unassigned') {
    settled = settledMode;
  } else {
    try {
      const measured = await readSessionRunUsage(
        deps.sessionsRoot ?? defaultSessionsRoot(),
        settledMode.sessionId,
      );
      settled = {
        ...settledMode,
        usage: measured.usage,
        // The live lane model reported by the boot wins over the
        // session's recorded usage model — a pin may have switched models in
        // this run, and the result must name the one that actually ran.
        ...(settledMode.model !== undefined || measured.model === undefined
          ? {}
          : { model: measured.model }),
      };
    } catch {
      settled = settledMode;
    }
  }
  // A provider that echoes the key it rejected puts the value in
  // the run's own failure text. The result (the --json envelope) and the
  // trajectory's prompt are scrubbed of every live provider key before either
  // leaves the run; the session JSONL (which the trajectory's entries are
  // read back from) is scrubbed at its write bridge.
  const liveKeys = matchableSecrets(capture.liveSecrets());
  const scrub = <T>(value: T): T =>
    liveKeys.length === 0 ? value : (redactSecretValues(value, liveKeys) as T);
  settled = scrub(settled);
  // kubic run -p plus its trajectory: every run that
  // attached a session writes <sessions-root>/<id>/trajectory.json when it
  // settles — completed or not — and the result's trajectory ref names that
  // file. A trajectory that cannot be written is reported on the warning
  // channel; it never changes the run's own result.
  if (capture.sessionId === undefined || capture.sessionsRoot === undefined) {
    return settled;
  }
  // Gates after settlement: the configured `[verify]`
  // commands run in the run's worktree — the same workspace the lane ran
  // in — and their verdicts become the trajectory's `signal:*` labels. A
  // run that never reached a workspace (a refused boot) has nothing to
  // verify, so its gates stay unknown. A verifier failure never changes
  // the run's own result; it is reported on the warning channel.
  const warn =
    deps.warn ?? ((line: string) => process.stderr.write(`${line}\n`));
  const cwd = capture.cwd ?? deps.env?.cwd;
  let evalLabels: Record<string, string> = {};
  if (cwd !== undefined) {
    try {
      if (hasVerifyCommands(deps.verify?.commands)) {
        evalLabels = await verifyRun(cwd, base, deps);
      }
    } catch (error) {
      warn(
        `verify: gates not recorded for session ${capture.sessionId}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  try {
    const path = persistRunTrajectory({
      sessionsRoot: capture.sessionsRoot,
      sessionId: capture.sessionId,
      agentId: resolveRunAgentId(deps.agentId),
      role: capture.role ?? DEFAULT_RUN_ROLE,
      prompt: scrub(prompt),
      entries: capture.entries,
      ...(capture.model === undefined ? {} : { model: capture.model }),
      ...(capture.thinking === undefined ? {} : { thinking: capture.thinking }),
      cwd: cwd ?? process.cwd(),
      skills: capture.skills,
      startedAt: capture.startedAt,
      endedAt: Date.now(),
      base,
      evalLabels,
      warn,
      outcome: {
        terminus: settled.terminus,
        summary: settled.summary,
        ...(capture.lane === undefined ? {} : { lane: capture.lane }),
        interrupted: capture.interrupted,
      },
    });
    return { ...settled, trajectoryRef: path };
  } catch (error) {
    warn(
      `trajectory not written for session ${capture.sessionId}: ${error instanceof Error ? error.message : String(error)}`,
    );
    return settled;
  }
}

// Gates after settlement: the `[verify]` commands run in
// the run's worktree, then — when the run started from a git revision — in
// a throwaway detached checkout of that revision, so a gate that passed
// before the run and fails after it is recorded as a regression. The
// checkout is removed whatever happens; outside git no regression is
// claimed.
async function verifyRun(
  cwd: string,
  base: { revision: string; branch: string | null } | null,
  deps: HeadlessRunDeps,
): Promise<Record<string, string>> {
  const commands = deps.verify?.commands ?? {};
  const timeout =
    deps.verify?.timeoutMs === undefined
      ? {}
      : { timeoutMs: deps.verify.timeoutMs };
  const current = await runVerifier(
    deps.env ?? new NodeExecutionEnv(cwd),
    commands,
    timeout,
  );
  const baseline =
    base === null
      ? null
      : await withDetachedCheckout(cwd, base.revision, (checkout) =>
          runVerifier(new NodeExecutionEnv(checkout), commands, timeout),
        );
  return verifierLabels(current, baseline ?? undefined);
}

async function runHeadlessPromptOnce(
  prompt: string,
  options: HeadlessRunOptions,
  deps: HeadlessRunDeps = {},
  report: {
    model?: string;
    posture?: 'approvals' | 'full-access';
    // The run's mode, set from the session record.
    mode?: RunMode;
  },
  capture: RunCapture,
): Promise<HeadlessRunResult> {
  // Every result after the lane booted names the model the
  // lane actually ran (the live lane model, never the bare selection).
  const result = await runHeadlessPromptImpl(
    prompt,
    options,
    deps,
    report,
    capture,
  );
  return report.model === undefined
    ? result
    : { ...result, model: report.model };
}

async function runHeadlessPromptImpl(
  prompt: string,
  options: HeadlessRunOptions,
  deps: HeadlessRunDeps,
  report: {
    model?: string;
    posture?: 'approvals' | 'full-access';
    // The run's mode, set from the session record.
    mode?: RunMode;
  },
  capture: RunCapture,
): Promise<HeadlessRunResult> {
  const context = deps.context ?? BACKGROUND_CONTEXT;
  // Debug channel: `--debug` routes the span lines AND the run's
  // diagnostics (extension receipt, reconcile/overlap notices, skill-load
  // reports, drain failures) to one sink. An injected deps.debug still wins;
  // without either, the diagnostics are off.
  const debugSink: DebugSink | undefined =
    options.debug === true
      ? (deps.debugSink ?? ((line: string) => console.error(line)))
      : undefined;
  // The vocabulary is closed: a diagnostic without its own class rides
  // the sink as `[session]`.
  // Every resolved provider key is redacted from the debug
  // channel — the values are known only once the resolver has run, so the
  // redaction reads them at emit time.
  const rawDebug: ((line: string) => void) | undefined =
    deps.debug ??
    (debugSink === undefined
      ? undefined
      : (line: string) =>
          debugSink(/^\[[a-z]+\]/.test(line) ? line : `[session] ${line}`));
  const debug: ((line: string) => void) | undefined =
    rawDebug === undefined
      ? undefined
      : redactingSink(rawDebug, () => capture.liveSecrets());
  const warnLine =
    deps.warn ?? ((line: string) => process.stderr.write(`${line}\n`));
  // Operator notices: a model switched or kept at boot, a pending
  // operation's settlement, an overflow recovery.
  const notice = deps.notice ?? ((line: string) => console.error(line));
  // The turn prompt `--invoke-skill` expands to. Every downstream prompt
  // use reads this, never the raw parameter.
  let effectivePrompt = prompt;
  // Spans on the live path: the run, its lane accept/drive
  // steps and every harness tool call are recorded on the SpanRecorder
  // and persisted to <root>/<id>/spans.jsonl when the run settles.
  const spans = new RunSpans(Date.now, debugSink);
  const runSpan = spans.startRun();
  // Set by the first signal. The boot checks it before each expensive step
  // (and the run before the turn), so a pre-turn Ctrl-C cancels the boot
  // instead of letting it run on unseen.
  let interruptedBy: string | undefined;
  const boot = new SessionBoot(
    {
      command: 'run',
      context,
      ...(options.sessionId === undefined
        ? {}
        : { sessionId: options.sessionId }),
      // The run's mode is always recorded — explicit `--autonomous` or off
      // by default.
      sessionMode: options.autonomous === true ? 'autonomous' : 'interactive',
      ...(options.role === undefined ? {} : { role: options.role }),
      ...(options.tools === undefined ? {} : { tools: options.tools }),
      ...(options.noTools === undefined ? {} : { noTools: options.noTools }),
      ...(options.noSkills === undefined ? {} : { noSkills: options.noSkills }),
      ...(options.skills === undefined ? {} : { cliSkills: options.skills }),
      ...(options.dangerouslySkipApprovals === undefined
        ? {}
        : { dangerouslySkipApprovals: options.dangerouslySkipApprovals }),
      // The tool spans, installed after policy so a blocked call never
      // opens one.
      spanHooks: () => runSpanHooks(spans),
      cancelled: () => interruptedBy !== undefined,
      onPolicyInstalled: (booted) => recordRunStart(booted),
      onSkillsBooted: (booted) => {
        // `--invoke-skill` expands against the invocable set (admitted +
        // gate-passed, hidden included, withheld excluded) — the skill
        // content runs as the turn prompt with the operator's prompt as
        // instructions. An unknown name fails the run with the named error
        // (exit 1, like a refused --role): the invocation IS the run.
        if (options.invokeSkill !== undefined) {
          try {
            effectivePrompt = expandSkillInvocation(
              booted.skills?.invocable ?? [],
              options.invokeSkill,
              prompt,
            );
          } catch (error) {
            const message =
              error instanceof Error ? error.message : String(error);
            return { kind: 'failed', message };
          }
        }
        const loaded = booted.skills?.skills ?? [];
        if (loaded.length > 0) {
          debug?.(
            `skills: ${loaded.length} loaded (${loaded
              .map((skill) => `${skill.name}@${skill.source}`)
              .join(', ')})`,
          );
        }
        return undefined;
      },
    },
    {
      sessionsRoot: deps.sessionsRoot,
      env: deps.env,
      classes: deps.policyClasses,
      policySource: deps.policySource,
      approvals: deps.approvals,
      policy: deps.policy,
      models: deps.models,
      modelsCwd: deps.modelsCwd,
      model: deps.model,
      streamTuning: deps.streamTuning,
      thinking: deps.thinking,
      compaction: deps.compaction,
      agentId: deps.agentId,
      journalRetention: deps.journalRetention,
      reconcileOutOfScope: deps.reconcileOutOfScope,
      systemPromptSection: deps.systemPromptSection,
      modelPolicy: deps.modelPolicy,
      trustProject: deps.trustProject,
      skills: deps.skills,
      roles: deps.roles,
    },
    {
      ...(debug === undefined ? {} : { debug }),
      warn: warnLine,
      fauxNotice: warnLine,
      modelNotice: notice,
      // An unresolvable explicit --skill warns on stderr — never only on
      // the debug channel — so a typo cannot read as loaded.
      skillsWarn: warnLine,
      skillsLog: (line) => debug?.(`skills: ${line}`),
    },
  );
  capture.liveSecrets = () => boot.liveSecrets();
  // The run's start names the mode in the ledger — a fresh session only (a
  // resume continues the recorded run) — and a run on a full-access session
  // is never silent: the grant's own warning when this run enabled it,
  // otherwise the named in-force warning, on stderr so stdout stays
  // consumable. Best-effort: a dead ledger never fails the run.
  function recordRunStart(booted: SessionBoot): void {
    const installed = booted.installed;
    const env = booted.env;
    if (installed === undefined || env === undefined) return;
    report.posture = installed.posture.fullAccess ? 'full-access' : 'approvals';
    if (options.sessionId === undefined) {
      appendToLedger(
        auditLedgerDirFor(env.cwd),
        runStartAudit({
          sessionId: booted.id,
          command: 'kubic run',
          runMode: options.autonomous === true ? 'autonomous' : 'interactive',
          workspace: env.cwd,
          posture: report.posture,
          autonomous: options.autonomous === true,
          base: booted.base ?? 'unknown',
        }),
        (message) => debug?.(`audit: run start not recorded: ${message}`),
      );
    }
    if (installed.posture.fullAccess) {
      warnLine(booted.fullAccessWarning ?? fullAccessInForceWarning(booted.id));
    }
  }
  // Defense-in-depth with run-cli's checks: direct callers bypass the CLI,
  // so a path-unsafe session id, an invalid guard bound or a contradictory
  // tool selection fails closed with the usage terminus (exit 2) before any
  // store or lane exists.
  const invalid =
    usageRefusal(boot.validateSessionId()) ??
    guardBoundsRefusal(options) ??
    usageRefusal(boot.validateTools());
  if (invalid !== undefined) {
    return finished('unassigned', 'usage', invalid, invalid);
  }
  const opened = await boot.open();
  if (opened?.kind === 'store')
    return storeFailure(options.sessionId, opened.error);
  const session = boot.session as SessionHandle;
  const id = session.id;
  capture.sessionId = id;
  capture.sessionsRoot = boot.root;
  // The result and envelope name the session's recorded
  // mode — a resumed or attached session keeps the creating run's mode.
  // A pre record (no mode) falls back to this invocation's flag.
  report.mode =
    session.meta.mode ??
    (options.autonomous === true ? 'autonomous' : 'interactive');
  // Set when a guard or an interrupt abandoned a live turn: the finally then
  // states the durable conversation abort (plus the kill drain) instead of
  // dropping handles for work that is still running.
  let abandoned = false;
  // The run's guard: every wait runs on this cancellable context,
  // cancelled by the wall clock, the turn count (guard) or a signal. The
  // DURABLE stop is conversation.abort() on the divert paths; this context
  // only stops waiting.
  const guard = withCancel(context);
  // The error that stopped the wait. Read through a call so the closure's
  // write is not narrowed away by the reads below.
  let guardError: Error | undefined;
  const guardFailure = (): Error | undefined => guardError;
  // The abort reason travels on the context (lane/turn.ts reads it), while
  // `guardError` keeps the original error for the run's own message.
  const tripGuard = (
    error: Error,
    reason: 'guard' | 'signal' = 'guard',
  ): void => {
    guardError ??= error;
    guard.cancel(turnAbort(reason, error.message));
  };
  // Counted from the committed usage events: one per assistant
  // response, the turn unit `--max-turns` bounds.
  let turns = 0;
  // The run's guard timer: armed with the wall-clock bound once
  // the session exists, cleared on every exit path.
  let deadline: ReturnType<typeof setTimeout> | undefined;
  // Interrupts (SIGINT/SIGTERM/SIGHUP): installed from here until the finally
  // has drained, so the default handler cannot kill the run past its
  // own cleanup. The first signal kills the running children synchronously
  // (they sit in their own process groups and never saw the signal — keys
  // them by conversation id) and cancels the guard; the listeners detach at
  // once, so a second Ctrl-C force-quits through the default handler.
  const signals = deps.signals ?? process;
  let signalsAttached = false;
  const detachSignals = (): void => {
    if (!signalsAttached) return;
    signalsAttached = false;
    for (const name of INTERRUPT_SIGNALS) signals.off(name, onSignal);
  };
  function onSignal(signal: string): void {
    detachSignals();
    interruptedBy ??= signal;
    const lane = boot.lane;
    if (lane !== undefined) {
      for (const kill of lane.kills.drain(String(lane.conversation.id))) {
        try {
          kill();
        } catch {
          // Already exited.
        }
      }
    }
    tripGuard(new InterruptedError(signal), 'signal');
  }
  const attachSignals = (): void => {
    signalsAttached = true;
    for (const name of INTERRUPT_SIGNALS) signals.on(name, onSignal);
  };
  const bootInterrupted = (): HeadlessRunResult | undefined => {
    if (interruptedBy === undefined) return undefined;
    capture.interrupted = true;
    const message = new InterruptedError(interruptedBy).message;
    return finished(id, 'cancelled', message, message, interruptedBy);
  };
  // The span artifact is written on every exit path (success or mapped
  // failure) next to the session journal.
  const flushSpans = (): void => {
    spans.endRun(runSpan);
    try {
      boot.bridge.appendFile(
        join(id, 'spans.jsonl'),
        serializeSpanArtifact(spans.trace(), runSpan, id),
      );
    } catch {
      // Telemetry must never mask the run's own result: a failed artifact
      // write is not a run failure.
    }
  };
  // The no-isolation notice: the trust model is announced on
  // stderr before the first turn, once per process start, using the module
  // strings verbatim so `kubic tui` reads identically. Suppressed by the
  // documented KUBIC_NO_NOTICE opt-out. stderr, never stdout: `--json`
  // stays parseable.
  // With a progress sink the notice is its compact one-liner,
  // printed by `progress.begin` once the lane has booted (still before the
  // first turn); the three-line block stays for every other run.
  const noIsolationNotice = shouldEmitNotice(process.env);
  if (noIsolationNotice && options.progress === undefined) {
    emitNoIsolationNotice((line) => process.stderr.write(`${line}\n`));
  }
  try {
    // Attached inside the try: the finally below always detaches them.
    attachSignals();
    // The wall clock starts with the run's own work (the pending settlement
    // and the turn), not with the session open.
    const boundMs = options.timeoutMs ?? DEFAULT_RUN_TIMEOUT_MS;
    deadline = setTimeout(
      () => tripGuard(new WallClockError(boundMs)),
      boundMs,
    );
    let refused: BootRefusal | undefined;
    try {
      refused = await boot.boot();
    } finally {
      // What the boot settled is the trajectory's, whichever step stopped.
      captureBoot(boot, capture);
    }
    if (refused !== undefined) {
      if (refused.kind === 'cancelled') {
        return bootInterrupted() ?? finished(id, 'cancelled', 'cancelled');
      }
      const message =
        refused.kind === 'store' ? String(refused.error) : refused.message;
      return finished(
        id,
        refused.kind === 'provider' ? 'provider_probe_failed' : 'failed',
        message,
        message,
      );
    }
    const lane = boot.lane as Lane;
    const installed = boot.installed as InstalledPolicy;
    report.model = boot.liveModel === undefined ? undefined : boot.liveModelRef;
    options.progress?.begin({
      ...(report.model === undefined ? {} : { model: report.model }),
      ...(capture.role === undefined ? {} : { role: capture.role }),
      notice: noIsolationNotice,
    });
    // The turn guard: one event subscription per conversation counts
    // the run's turns for `--max-turns`. Durable retries are the harness's own
    // (they commit no assistant entry), so a turn is one committed response.
    const detachEvents = await subscribeLaneEvents(
      lane.harness,
      lane.conversation.id,
      (event) => {
        // A retry backoff and a compaction are
        // named on the debug channel — tens of silent seconds otherwise.
        const activity = laneActivityDebugLine(event);
        if (activity !== undefined) debug?.(activity);
        if (event.type === 'tool-start') {
          options.progress?.toolStart({
            toolCallId: event.toolCallId,
            toolName: event.toolName,
            args: event.args,
          });
          return;
        }
        if (event.type === 'tool-end') {
          options.progress?.toolEnd({
            toolCallId: event.toolCallId,
            toolName: event.toolName,
            isError: event.isError,
            ...(event.entry === undefined ? {} : { entry: event.entry }),
          });
          return;
        }
        if (event.type !== 'usage') return;
        turns += 1;
        if (options.maxTurns !== undefined && turns > options.maxTurns) {
          tripGuard(new TurnLimitError(turns - 1));
        }
      },
      context,
    );
    try {
      const beforeTurn = bootInterrupted();
      if (beforeTurn !== undefined) return beforeTurn;
      // A turn a dead process left open would refuse this
      // prompt. The documented policy: when the pending run carries this very
      // prompt (a retried script), it is resumed AS this run — never
      // re-prompted.
      // Otherwise it is resumed first under the same guard and then this
      // prompt is admitted; a resume that cannot settle (guard fired,
      // approval with no TTY) is durably aborted. Each choice is named on
      // stderr.
      // Lane spans: `accept` covers admitting this run's work —
      // the pending turn a dead process left, settled first — and `drive`
      // covers the durable turn itself (submit → wait → settlement). Tool
      // spans nest under `drive` because `startLane('drive')` is the lane
      // open when the harness runs them.
      const pending = await inspectPending(lane, context);
      const acceptSpan = spans.startLane('accept');
      let resumed: Awaited<ReturnType<typeof lane.harness.submission>>;
      try {
        if (pending.pending) {
          const pendingPrompt = await pendingInputText(lane, context);
          const placed = (await lane.harness.inspect(context)).submissions.find(
            (record) => record.type === 'input' && record.status === 'placed',
          );
          if (
            pendingPrompt !== undefined &&
            // An `--invoke-skill` retry coalesces with its
            // own pending expanded prompt (identical to `prompt` for
            // non-invoke runs).
            pendingPrompt === effectivePrompt &&
            placed !== undefined
          ) {
            resumed = await lane.harness.submission(placed.id, context);
            notice(
              `${pending.summary ?? 'pending work'} carries this prompt: resuming it instead of re-prompting`,
            );
          } else {
            const settlement = await settlePending(lane, 'resume', {
              context,
              kills: lane.kills,
              guard: guard.context,
            });
            notice(describePendingSettlement(pending.summary, settlement));
          }
        }
      } finally {
        spans.endLane(acceptSpan, guardFailure()?.message);
      }
      const stopped = guardFailure();
      if (stopped !== undefined) {
        abandoned = true;
        return stoppedResult(id, stopped, capture);
      }
      // One stable request id per invocation: a re-submit inside this run
      // finds the same submission instead of prompting twice, while a fresh
      // invocation is a fresh prompt.
      const requestId = `kubic-run:${randomUUID()}`;
      let outcome: TurnOutcome;
      // The overflow-recovery decision, when the lane
      // made one — carried into the envelope on every exit path below.
      let retryDecision: RetryDecision | undefined;
      let retryRetried = false;
      const driveSpan = spans.startLane('drive');
      try {
        if (resumed !== undefined) {
          outcome = await awaitTurn(resumed, guard.context);
        } else {
          // A context overflow compacts and retries
          // once on the fresh context; every other outcome passes through
          // exactly as runTurn reports it.
          const recovered = await runTurnWithOverflowRecovery(
            lane,
            effectivePrompt,
            {
              requestId,
              context: guard.context,
              // Headless keeps today's refusal: a run that somehow finds the
              // conversation busy fails by name instead of queueing behind a
              // turn nobody is watching.
              whenBusy: 'reject',
              onRetryDecision: (decision) => {
                const text = overflowRecoveryNotice(decision);
                if (text !== undefined) notice(text);
              },
            },
          );
          outcome = recovered.outcome;
          retryDecision = recovered.decision;
          retryRetried = recovered.retried;
        }
      } finally {
        spans.endLane(driveSpan, guardFailure()?.message);
      }
      capture.lane = turnLaneRecord(outcome);
      if (outcome.kind === 'aborted') {
        // The durable run is still live: the finally states the abort and
        // drains the kill registry before the sweep.
        abandoned = true;
        const stopped = guardFailure();
        if (stopped !== undefined) return stoppedResult(id, stopped, capture);
        if (outcome.reason === 'user') {
          const message = 'lane aborted before it settled';
          return finished(id, 'failed', message, message);
        }
        const message = 'run guard exhausted';
        return finished(id, 'turn_limit', message, message);
      }
      // The installed policy refused an approval. The block reaches
      // the model as a tool error, so the lane settles `completed` — but a
      // dangerous operation the user never approved did NOT happen, and
      // reporting exit 0 would be the dishonest half of the problem. Read the
      // recorded refusals directly: a run whose policy denied an approval maps
      // to the approval terminus (exit 4) with the refusal named. Checked
      // BEFORE the outcome is mapped: a denial OUTRANKS a settled turn.
      //
      // Exit 4 covers the whole approval terminus; the STATUS is
      // the honest half. A denial whose reason carries the timeout marker is
      // a bound that elapsed, everything else is a refusal — a script can
      // tell "the operator said no" from "nobody answered in time".
      // Classification keys off the one TIMEOUT_REASON_MARKER string (the
      // same one classifyVerdict uses) rather than a private regex that could
      // drift from the producers.
      const denials = installed.denials();
      if (denials.length > 0) {
        const named = denials
          .map((denial) => `${denial.capability} (${denial.toolName})`)
          .join(', ');
        // Classification reads the first recorded denial's reason.
        const first = denials[0]?.reason ?? '';
        const message = `approval refused: ${named} — ${first}`;
        const terminus = first.includes(TIMEOUT_REASON_MARKER)
          ? 'approval_timed_out'
          : 'approval_denied';
        return finished(id, terminus, message, message);
      }
      if (outcome.kind === 'completed') {
        const items = entriesToTranscript(
          await readConversationEntries(lane.conversation, context),
        );
        return finished(
          id,
          'completed',
          assistantSummary(items) ?? NO_ASSISTANT_TEXT_SUMMARY,
          undefined,
          undefined,
          undefined,
          retryRecord(retryDecision, retryRetried),
        );
      }
      const { terminus, failure } = failedTurnTerminus(outcome);
      const message = outcome.error ?? outcome.reason;
      return finished(
        id,
        terminus,
        `${outcome.reason}: ${message}`,
        message,
        undefined,
        failure,
        retryRecord(retryDecision, retryRetried),
      );
    } finally {
      await detachEvents();
    }
  } catch (error) {
    return storeFailure(id, error);
  } finally {
    // Drain in-flight work FIRST — the sweep must observe the
    // tree after orphaned tool processes are dead, or their late writes
    // land outside both the journal and the reconciliation. Runs on every
    // exit path (guard exhaustion, an abandoned turn, an unexpected throw,
    // plain completion); a completed or failed turn forgets its (dead) kill
    // handles. Failures only reach the debug channel: the mapped result
    // and the sweep both stand.
    const lane = boot.lane;
    if (lane !== undefined) {
      if (abandoned) {
        await abortAbandonedLane(lane, (message) =>
          guardedReport(debug, message),
        );
      } else {
        forgetLaneKills(lane);
      }
    }
    // In-flight work is dead: a later signal takes the default path again.
    detachSignals();
    if (deadline !== undefined) clearTimeout(deadline);
    // The sweep, the policy's posture check and the session close, on every
    // exit path. While the session is still open: the span artifact, the
    // prompt guarantee and the trajectory's entries.
    await boot.teardown({
      ...(abandoned ? { closeBoundMs: LANE_ABORT_BOUND_MS } : {}),
      beforeClose: async () => {
        flushSpans();
        // The prompt guarantee first: a run that never admitted the prompt
        // still gets its one durable entry, and the transcript decides —
        // never a second copy for a prompt that is already carried. Done
        // before the capture below so the trajectory carries the fallback
        // write.
        try {
          await ensurePromptDurable(
            lane,
            session,
            effectivePrompt,
            context,
            (message) => guardedReport(debug, message),
          );
        } catch (error) {
          guardedReport(
            debug,
            `session: prompt not persisted: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
        // The trajectory's entries, read while the session is still open
        // through the shared transcript adapter; a read failure leaves the
        // trajectory without actions, never the run without its result.
        capture.entries = await captureEntries(lane, session, context);
      },
    });
  }
}

// A refusal from the session checks or the guard bounds, as the usage
// message, or undefined.
function usageRefusal(refusal: BootRefusal | undefined): string | undefined {
  return refusal?.kind === 'usage' ? refusal.message : undefined;
}

// Guard overrides are validated before any store or lane exists: an
// invalid bound fails closed with the usage terminus (exit 2) and never
// boots a lane. Unset bounds fall through to the CLI default.
function guardBoundsRefusal(options: HeadlessRunOptions): string | undefined {
  if (
    options.timeoutMs !== undefined &&
    (!Number.isInteger(options.timeoutMs) || options.timeoutMs <= 0)
  ) {
    return `invalid timeoutMs ${JSON.stringify(options.timeoutMs)} (need a positive integer of milliseconds)`;
  }
  // Same ceiling as the CLI (defense-in-depth for direct callers): above
  // 2^31-1 ms setTimeout clamps to 1 ms, which would fire the "bound"
  // immediately and misreport a timeout.
  if (
    options.timeoutMs !== undefined &&
    options.timeoutMs > MAX_RUN_TIMEOUT_MS
  ) {
    return `invalid timeoutMs ${JSON.stringify(options.timeoutMs)} (max ${MAX_RUN_TIMEOUT_MS})`;
  }
  if (
    options.maxTurns !== undefined &&
    (!Number.isInteger(options.maxTurns) || options.maxTurns <= 0)
  ) {
    return `invalid maxTurns ${JSON.stringify(options.maxTurns)} (need a positive integer of turns)`;
  }
  return undefined;
}

// What the boot settled, for the trajectory: the role, the model the lane
// runs (else the selection), the workspace, the loaded skills and the
// thinking level the lane booted with (post-clamp; unset stays unset).
function captureBoot(boot: SessionBoot, capture: RunCapture): void {
  if (boot.role !== undefined) capture.role = boot.role.resolved.name;
  const model = boot.liveModel ?? boot.model;
  if (model !== undefined) {
    capture.model = { provider: model.provider, id: model.id };
  }
  if (boot.env !== undefined) capture.cwd = boot.env.cwd;
  if (boot.skills !== undefined) {
    capture.skills = boot.skills.skills.map((skill) => skill.name);
  }
  if (boot.thinkingLevel !== undefined) capture.thinking = boot.thinkingLevel;
}
