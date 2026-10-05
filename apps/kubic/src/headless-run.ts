// Prod `kubic run -p` runner (issue #28): the composition root drives the
// real solo lane headless and derives the §78 terminus from the lane's own
// settled outcome (E1). Everything durable lands under
// <sessionsRoot>/<id>/ (E3): the transcript and usage rows in the session
// store, file effects in <id>/journal/ via lane interception, and the
// entry chain itself is the trajectory record — so every ref resolves to
// a real location. Resume keeps one chain: the -p prompt commits
// parent-linked to the last existing entry under a random id (E4).

import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { PermissionClasses } from '../../../packages/agents/src/policy.js';
import {
  checkAgreement,
  SOLO_DEFAULTS,
  validateClasses,
} from '../../../packages/agents/src/policy.js';
import {
  type AgentTask,
  validateAgentTask,
} from '../../../packages/agents/src/task.js';
import type { ExecutionEnv } from '../../../packages/exec/src/env.js';
import { NodeExecutionEnv } from '../../../packages/exec/src/env.js';
import {
  createNodeFileBridge,
  type FileBridge,
} from '../../../packages/exec/src/file-bridge.js';
import {
  gitHeadOf,
  withDetachedCheckout,
} from '../../../packages/exec/src/git-clean.js';
import {
  FileJournalStore,
  type JournalRetention,
} from '../../../packages/exec/src/journal.js';
import {
  beginReconciliation,
  type RunReconciliation,
} from '../../../packages/exec/src/journal-reconcile.js';
import { budgetToolGate } from '../../../packages/extensions/src/runtime.js';
import type {
  BundleLoad,
  PostureOptions,
} from '../../../packages/extensions/src/startup.js';
import {
  enableSessionFullAccess,
  fullAccessInForceWarning,
  type InstalledSoloPolicy,
  installSoloPolicy,
  orchestratedWorkerFromEnv,
  type SoloApprovalConfig,
} from '../../../packages/host/src/approvals.js';
import { createLedgerModelKeyResolver } from '../../../packages/host/src/config/model-key-audit.js';
import type { RuntimeVerify } from '../../../packages/host/src/config/runtime.js';
import {
  matchableSecrets,
  redactBridgeWrites,
  redactingSink,
  redactSecretValues,
} from '../../../packages/host/src/config/secrets.js';
import {
  FAUX_MODEL_ID,
  FAUX_NOTICE,
  FAUX_PROVIDER_ID,
  invalidProviderMessage,
  providerOverrideFromEnv,
} from '../../../packages/host/src/faux-provider.js';
import {
  emitSoloWarning,
  shouldEmitSoloNotice,
} from '../../../packages/host/src/limits/solo-warning.js';
import { assembleModels } from '../../../packages/host/src/models-cli.js';
import { readSessionRunUsage } from '../../../packages/host/src/ops/cost/cost-cli.js';
import {
  RunSpans,
  runSpanHooks,
  serializeSpanArtifact,
} from '../../../packages/host/src/ops/perf/run-spans.js';
import {
  BUDGET_EXHAUSTED,
  type BudgetLimit,
  createRunBudgetEnforcer,
  type OrchestratorBudget,
  parseWorkerBudgetEnv,
  RUN_EXIT_BUDGET,
} from '../../../packages/host/src/orchestrator/approvals/budgets.js';
import {
  createWorkerMailboxSeat,
  TIMEOUT_REASON_MARKER,
  workerAskIdentity,
} from '../../../packages/host/src/orchestrator/approvals/worker-asks.js';
import { createAskUserTool } from '../../../packages/host/src/orchestrator/approvals/worker-question-tool.js';
import { resolveRunBaseRevision } from '../../../packages/host/src/policy/audit-ledger.js';
import {
  type EffectivePolicy,
  hasModelPolicy,
  hasToolPolicy,
  isModelAllowed,
  isToolAllowedByEnterprise,
} from '../../../packages/host/src/policy/enterprise.js';
import { findProjectRoot } from '../../../packages/host/src/project-root.js';
import type {
  ResolvedRole,
  RoleLayerInput,
} from '../../../packages/host/src/roles/resolver.js';
import {
  rolePromptFor,
  type SelectedRole,
  selectRole,
} from '../../../packages/host/src/roles/roles-boot.js';
import {
  DEFAULT_RUN_TIMEOUT_MS,
  type HeadlessRunResult,
  type LaneOutcomeTerminus,
  MAX_RUN_TIMEOUT_MS,
  mapCaughtErrorToTerminus,
  mapLaneOutcomeToFailure,
  type RetryRecord,
  SESSION_ID_PATTERN,
} from '../../../packages/host/src/run-cli.js';
import { defaultSessionsRoot } from '../../../packages/host/src/sessions-cli.js';
import { bootSkills } from '../../../packages/host/src/skills-boot.js';
import type { DebugSink } from '../../../packages/host/src/spans.js';
import type { RunOutcome } from '../../../packages/host/src/trajectory/run-trajectory.js';
import {
  hasVerifyCommands,
  runVerifier,
  verifierLabels,
} from '../../../packages/host/src/verify/verifier.js';
import {
  abortLane,
  forgetLaneKills,
} from '../../../packages/worker/src/lane/abort.js';
import {
  type KubicLaneEvent,
  subscribeLaneEvents,
} from '../../../packages/worker/src/lane/events.js';
import {
  type ClassifiedFailure,
  classifyFailure,
  type RetryDecision,
} from '../../../packages/worker/src/lane/failures.js';
import {
  describePendingSettlement,
  inspectPending,
  pendingInputText,
  settlePending,
} from '../../../packages/worker/src/lane/pending.js';
import {
  attachSession,
  createSession,
  laneConversationIdOf,
  openSessionStore,
  type SessionHandle,
  sessionsTouchingWorkspace,
} from '../../../packages/worker/src/lane/session-store.js';
import {
  bootSoloLane,
  type SoloLane,
} from '../../../packages/worker/src/lane/solo.js';
import {
  entriesToTranscript,
  readConversationEntries,
  readSessionEntries,
  type TranscriptItem,
} from '../../../packages/worker/src/lane/transcript.js';
import {
  awaitTurn,
  runTurnWithOverflowRecovery,
  type TurnOutcome,
  turnAbort,
  turnLaneRecord,
} from '../../../packages/worker/src/lane/turn.js';
import { withRoleGrant } from '../../../packages/worker/src/lifecycle/env.js';
import { readyMarker } from '../../../packages/worker/src/lifecycle/spawn.js';
import {
  ModelSelectError,
  type ModelSelection,
  type selectModel,
} from '../../../packages/worker/src/model-select.js';
import { OPERATIONS } from '../../../packages/worker/src/ops/registry.js';
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
} from '../../../packages/worker/src/pi-boundary.js';
import { selectModelUnderPolicy } from './config-runtime.js';
import { loadExtensionStartup } from './extension-startup.js';
import {
  hasExplicitModelSelection,
  roleModelSelection,
} from './model-projection.js';
import { persistRunTrajectory } from './run-trajectory.js';

export interface HeadlessRunOptions {
  sessionId?: string;
  timeoutMs?: number;
  maxTurns?: number;
  // §29.3 skills surface (issue #99): `--no-skills` disables layered
  // discovery and `--skill <path>` adds one explicitly (repeatable —
  // explicit intent applies even under --no-skills).
  noSkills?: boolean;
  skills?: string[];
  // §12.1 role selection (issue #99): `--role <name>` boots the lane as
  // the role document `.kubic/roles/<name>.md` defines — its prompt text
  // replaces the solo constant and its resolved tool set becomes the
  // lane's allowlist. Absent means the solo default, unchanged.
  role?: string;
  // §50 debug channel (issue #98): when set, the run emits its lane/tool
  // debug lines to the injected sink (stderr in prod). The span artifact is
  // written either way — spans are the durable half.
  debug?: boolean;
  // §41.4 (issue #308): `--dangerously-skip-approvals` — full access for the
  // session this run creates or resumes, recorded in its posture.json and
  // the audit ledger, never in config.
  dangerouslySkipApprovals?: boolean;
  // §40.1 mechanism 1 (issue #273): `--tools <a,b>` narrows the run's tool
  // set (intersected with the classes/role/enterprise sets — never widened);
  // `--no-tools` is the empty set. Mutually exclusive, validated before the
  // lane boots.
  tools?: readonly string[];
  noTools?: boolean;
}

export interface HeadlessRunDeps {
  sessionsRoot?: string;
  models?: MutableModels;
  model?: ModelSelection;
  // The lane's agent id (issue #133): the configured `[agent].name`, threaded
  // from runtimeLaneDeps. Absent means 'root' — the shipped behaviour, byte
  // for byte (journal attribution and `kubic diff --agent` follow it).
  agentId?: string;
  env?: ExecutionEnv;
  context?: Context;
  /** Preloaded extension startup object (tests); otherwise loaded here. */
  extensions?: BundleLoad;
  /** Prod inputs for the startup load — tests drive missing bundles here. */
  extensionOptions?: PostureOptions;
  /** Progress receipt for the extension load (one line, never swallowed). */
  debug?: (line: string) => void;
  // Runtime config projections (issue #90): the permission classes and the
  // journal retention bound the loaded configuration produced. Absent means
  // the lane's own defaults and an unbounded journal (never an invented
  // limit).
  policyClasses?: PermissionClasses;
  // Issue #86: the config layer's own record of where the classes came from
  // ('default' when nothing configured them). Absent means 'default' — the
  // documented safe default, never an assumed operator choice.
  policySource?: 'config' | 'default';
  // Issue #230: the config `[approvals]` policy (route, maxPendingMs,
  // autoApprove, requireJustification, sessionScoped). Absent means the
  // documented defaults.
  approvals?: SoloApprovalConfig;
  // §58 enterprise policy (issue #288): the composition root resolves it
  // once (`runtimePolicy` in config-runtime) and threads it here. A run only
  // gates its tool set and model selection when the layer actually
  // configured those halves — an absent [policy] section never narrows
  // anything.
  modelPolicy?: EffectivePolicy;
  journalRetention?: JournalRetention;
  // §48 gate commands (issue #267), from `[verify]` via runtimeRunDeps. Run
  // in the worktree after the run settles; their verdicts become the
  // trajectory's `signal:*` labels. Absent means nothing is verified.
  verify?: RuntimeVerify;
  // The installed-policy seat (issue #86). Absent means the shipped
  // DEFAULT: the documented SOLO_DEFAULTS classes plus the destructive/
  // network/confine guards and the approval ask, all derived by
  // installSoloPolicy. Tests inject a variant here; nothing else may skip
  // the install, which is why the default is not an opt-in.
  policy?: InstalledSoloPolicy;
  // Declared out-of-scope paths for the §42.5 baseline (issue #87; §35).
  // Populated by `[journal] outOfScope` through runtimeRunDeps (issue #115);
  // absent means the mechanism's own skips only — `.git/`, `.kubic/` and
  // `.gitignore` hits.
  reconcileOutOfScope?: string[];
  // Debug sink for the §50 lines (issue #98). Defaults to stderr so a live
  // `kubic run --debug` emits without the composition root wiring anything;
  // tests inject an array collector instead.
  debugSink?: DebugSink;
  // Operator notices (issue #147): the line naming what happened to a
  // pending operation a crashed run left open. Defaults to stderr; tests
  // inject a collector.
  notice?: (line: string) => void;
  // §29.3 skills inputs (issue #99). Absent means the prod defaults: the
  // real home directory, this process's cwd, and the documented trust
  // opt-in (`KUBIC_TRUST_PROJECT`, the same switch the config layer reads).
  // Tests inject a home/cwd/trust triple to drive discovery over a fixture.
  skills?: {
    homeDir?: string;
    cwd?: string;
    trusted?: boolean;
    trustProject?: (dir: string) => boolean;
  };
  // Issue #228 (§35.1): the per-path trust check (the store's resolved-root
  // decision plus the env opt-in), threaded from the composition root's
  // config load. It gates the project models.json and the ancestor project
  // skills on the path each resolves to. Absent falls back to the env flag.
  trustProject?: (path: string) => boolean;
  // §12.1 role-document inputs (issue #99). Absent means the prod defaults:
  // this process's cwd (so `.kubic/roles/*.md` is read from the workspace)
  // through the real FileBridge. Tests inject a fixture cwd.
  roles?: {
    cwd?: string;
    layers?: RoleLayerInput[];
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

export interface SignalSource {
  on(event: InterruptSignal, listener: (signal: string) => void): unknown;
  off(event: InterruptSignal, listener: (signal: string) => void): unknown;
}

type InterruptSignal = 'SIGINT' | 'SIGTERM' | 'SIGHUP';
const INTERRUPT_SIGNALS: readonly InterruptSignal[] = [
  'SIGINT',
  'SIGTERM',
  'SIGHUP',
];

// The bounded wait a worker CHILD gives the manager for an answer to a
// challenged call (issue #105, §41.2): long enough for a human to read the
// dialog, short enough that a run never looks hung. The child denies closed
// with the named status when it elapses.
const DEFAULT_WORKER_APPROVAL_BOUND_MS = 120_000;

// Guard exhaustion surfaces as control flow, never as a lane failure:
// caught below and mapped to budget_exhausted (--max-turns) or timeout
// (wall clock) with the ref triple intact.
class TurnBudgetError extends Error {
  readonly turns: number;
  constructor(turns: number) {
    super(`turn budget exhausted after ${turns} turns`);
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

// §71 child-side budget exhaustion (issue #208): the worker's own lane hit a
// dimension of the KUBIC_BUDGET the manager handed down. Control flow, never a
// lane failure: caught below and mapped to budget_exhausted (exit 3) with the
// exact limit that tripped.
export class BudgetExceededError extends Error {
  readonly limit: BudgetLimit;
  constructor(limit: BudgetLimit) {
    super(
      `budget ${BUDGET_EXHAUSTED} (limit=${limit}): the worker exceeded its configured ${limit} budget, exit ${RUN_EXIT_BUDGET}`,
    );
    this.name = 'BudgetExceededError';
    this.limit = limit;
  }
}

// An interrupt (SIGINT/SIGTERM/SIGHUP) ends the turn like a guard does:
// control flow, mapped to `cancelled` (issue #280) after the drain — the
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

// Issue #209 review: the user-facing overflow line must tell the truth.
// The decision hook fires for every decision (including abandon), but
// only a retry_with_new_context compacts and retries — anything else
// stays silent, and the failure terminus already reports the failure.
export function overflowRecoveryNotice(
  decision: RetryDecision,
): string | undefined {
  if (decision.decision !== 'retry_with_new_context') return undefined;
  return `context overflow — compacting and retrying once (${decision.reason})`;
}

// Issue #209 review: the envelope record carries whether the retry
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
  // Issue #209: the retry decision when the lane made one (solo overflow
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
  // Issue #155: a caught failure carries its §52 classification too, so the
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

// The named non-answer a completed run with no assistant text reports
// (issue #129): the summary is the model's own output or this sentence —
// never the operator's prompt echoed back as if it were a result.
export const NO_ASSISTANT_TEXT_SUMMARY =
  '(no assistant text — the run settled without output)';

// Final assistant text of the settled run for the result summary. A run
// that left no assistant text yields undefined; the caller reports the
// named non-answer (NO_ASSISTANT_TEXT_SUMMARY) instead of the prompt.
// Takes the shared transcript (#400): newest assistant item wins.
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

// §78 terminus + §52 failure for a settled turn (issue #155): the §52 code
// and its message go through the same settlement kernel the lane record
// does, so budget/approval/workspace/provider failures keep their 3/4/5/6
// classes and the precise code rides beside the terminus.
function failedTurnTerminus(outcome: TurnOutcome): LaneOutcomeTerminus {
  if (outcome.kind !== 'failed') return { terminus: 'failed' };
  return mapLaneOutcomeToFailure('failed', {
    code: outcome.reason,
    message: outcome.error ?? outcome.reason,
  });
}

// §78 terminus for a guard that stopped the run before or instead of a
// settlement (issue #280): an interrupt is `cancelled` (128+signo), a
// wall-clock bound is `timeout` (exit 1 — never the budget code), and the
// remaining guards — `--max-turns` and a configured §71 budget — are
// `budget_exhausted` (exit 3) with the ref triple intact.
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
  return finished(id, 'budget_exhausted', error.message, error.message);
}

// §46 capture of the run's transcript (#400's readers): the live conversation
// while the lane is open, the session storage otherwise. A read failure
// leaves the trajectory without actions, never the run without its result.
async function captureEntries(
  solo: SoloLane | undefined,
  session: SessionHandle,
  context: Context,
): Promise<EntryRecord[]> {
  try {
    return solo === undefined
      ? await readSessionEntries(session.storage, context)
      : await readConversationEntries(solo.conversation, context);
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

// Waits for `work` for at most `ms`; undefined when the bound elapses. The
// promise is observed either way, so a late rejection is never unhandled.
async function settledWithin<T>(
  work: Promise<T>,
  ms: number,
): Promise<T | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const bound = new Promise<undefined>((resolve) => {
    timer = setTimeout(() => resolve(undefined), ms);
  });
  try {
    return await Promise.race([work.catch(() => undefined), bound]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

// Best-effort conversation abort + kill drain on the divert paths (a guard
// or an interrupt abandoned a live turn): the durable stop is stated against
// a context that is NOT the cancelled bound, and the wait is bounded so the
// run's own result never hangs on it.
async function abortAbandonedLane(
  solo: SoloLane,
  report: (message: string) => void,
): Promise<void> {
  const cancel = withCancel(BACKGROUND_CONTEXT);
  const timer = setTimeout(
    () =>
      cancel.cancel(new Error(`lane abort exceeded ${LANE_ABORT_BOUND_MS}ms`)),
    LANE_ABORT_BOUND_MS,
  );
  try {
    await abortLane(solo, cancel.context);
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
    // Issue #265: a forked session's prompt lands on its lane conversation.
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

// #247: `submit` writes `pi.user` itself, so a run that reached its turn has
// exactly ONE user entry. Every other exit path — no model, a refused role,
// a signal between boot and the turn, a busy refusal — still keeps the
// prompt durable (the pre-1.0 guarantee `kubic run -p` always had) through
// one plain entry write. The TRANSCRIPT decides, in both directions: a
// prompt already carried by an entry (the turn's own, a resumed run's, an
// earlier identical prompt) is never written twice, and a lane that booted
// but never admitted the prompt still gets its entry.
async function ensurePromptDurable(
  solo: SoloLane | undefined,
  session: SessionHandle,
  prompt: string,
  context: Context,
  report: (message: string) => void,
): Promise<void> {
  const entries = await captureEntries(solo, session, context);
  const present = entriesToTranscript(entries).some(
    (item) => item.kind === 'user' && item.text.trim() === prompt.trim(),
  );
  if (present) return;
  try {
    if (solo === undefined) {
      await appendPromptEntry(session, prompt, context);
    } else {
      await solo.conversation.commit(async (tx) => {
        await tx.appendEntry(UserEntry, solo.conversation.id, {
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

// Issue #185 (§39, §68): the finished run reports its OWN usage — the
// session's usage rollup (what `kubic cost` reads), the tool calls it
// executed and the model that answered — so an orchestrator building a
// worker's §68 metrics reads real numbers from the child's report. Read
// after the session is closed; a run that never created a session, or a
// read that fails, keeps the refs-only report (never invented numbers).

// What the settled run leaves for its §46 trajectory (issue #383): filled
// as the run boots, read once after it settles.
// §67 (issue #191): read the manager-written task named by KUBIC_TASK_FILE.
// Absent/empty means no task (a solo run, or a worker the manager gave no
// grant); an unreadable or invalid file, or one naming a different worktree,
// is a named refusal — never a half-applied grant.
function readAgentTask(
  bridge: Pick<FileBridge, 'readTextFile'>,
  path: string | undefined,
): { task?: AgentTask; error?: string } {
  if (path === undefined || path === '') return {};
  let raw: string;
  try {
    raw = bridge.readTextFile(path);
  } catch (error) {
    return {
      error: `agent task ${path} is unreadable: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    return {
      error: `agent task ${path} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  const validation = validateAgentTask(parsed);
  if (!validation.valid) {
    return {
      error: `agent task ${path} refused: ${validation.errors.join('; ')}`,
    };
  }
  return { task: validation.task };
}

interface RunCapture {
  startedAt: number;
  sessionsRoot?: string;
  sessionId?: string;
  cwd?: string;
  model?: { provider: string; id: string };
  role?: string;
  /** §67 (issue #191): the manager's task, when this run was handed one. */
  task?: AgentTask;
  skills: string[];
  entries: unknown[];
  lane?: RunOutcome['lane'];
  interrupted: boolean;
  // Every provider key the request-time resolver has handed out so far
  // (issue #359): what the debug channel, the session writes, the result and
  // the trajectory are scrubbed of. Empty until a models.json key is used.
  liveSecrets: () => string[];
}

// kubic run -p (issue #28) plus its §46 trajectory (issue #383): every run
// that attached a session writes <sessions-root>/<id>/trajectory.json when
// it settles — completed or not — and the result's trajectory ref names
// that file. A trajectory that cannot be written is reported on the warning
// channel; it never changes the run's own result.

// Issue #150: the `[lane]` debug line for a retry or compaction event, or
// undefined for any other event. The 1.0 harness reports the attempt and the
// error (#398's contract — no maxAttempts, no notBefore).
export function laneActivityDebugLine(
  event: KubicLaneEvent,
): string | undefined {
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

export async function runHeadlessPrompt(
  prompt: string,
  options: HeadlessRunOptions,
  deps: HeadlessRunDeps = {},
): Promise<HeadlessRunResult> {
  // The settled run's §46 trajectory capture (issue #383).
  const capture: RunCapture = {
    startedAt: Date.now(),
    skills: [],
    entries: [],
    interrupted: false,
    liveSecrets: () => [],
  };
  // Issue #148/#308: the live lane model and the approval posture the lane
  // was installed with travel on the result (and so the --json envelope),
  // whatever path the run ends on.
  const report: {
    model?: string;
    posture?: 'approvals' | 'full-access';
  } = {};
  // The base the run starts from (issue #267): captured before any turn, so
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
  let settled: HeadlessRunResult;
  if (withPosture.sessionId === 'unassigned') {
    settled = withPosture;
  } else {
    try {
      const measured = await readSessionRunUsage(
        deps.sessionsRoot ?? defaultSessionsRoot(),
        withPosture.sessionId,
      );
      settled = {
        ...withPosture,
        usage: measured.usage,
        // Issue #148: the live lane model reported by the boot wins over the
        // session's recorded usage model — a pin may have switched models in
        // this run, and the result must name the one that actually ran.
        ...(withPosture.model !== undefined || measured.model === undefined
          ? {}
          : { model: measured.model }),
      };
    } catch {
      settled = withPosture;
    }
  }
  // Issue #359: a provider that echoes the key it rejected puts the value in
  // the run's own failure text. The result (the --json envelope) and the
  // trajectory's prompt are scrubbed of every live provider key before either
  // leaves the run; the session JSONL (which the trajectory's entries are
  // read back from) is scrubbed at its write bridge.
  const liveKeys = matchableSecrets(capture.liveSecrets());
  const scrub = <T>(value: T): T =>
    liveKeys.length === 0 ? value : (redactSecretValues(value, liveKeys) as T);
  settled = scrub(settled);
  // kubic run -p plus its §46 trajectory (issue #383): every run that
  // attached a session writes <sessions-root>/<id>/trajectory.json when it
  // settles — completed or not — and the result's trajectory ref names that
  // file. A trajectory that cannot be written is reported on the warning
  // channel; it never changes the run's own result.
  if (capture.sessionId === undefined || capture.sessionsRoot === undefined) {
    return settled;
  }
  // §48 gates after settlement (issue #267): the configured `[verify]`
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
      agentId: deps.agentId ?? 'root',
      role: capture.role ?? 'solo',
      prompt: scrub(prompt),
      // §67 (issue #191): the worker's task is recorded with the run, so a
      // trajectory names the grant the agent actually ran under.
      ...(capture.task === undefined
        ? {}
        : {
            task: {
              taskId: capture.task.taskId,
              objective: capture.task.objective,
              role: capture.task.role,
            },
          }),
      entries: capture.entries,
      ...(capture.model === undefined ? {} : { model: capture.model }),
      cwd: cwd ?? process.cwd(),
      skills: capture.skills,
      startedAt: capture.startedAt,
      endedAt: Date.now(),
      base,
      evalLabels,
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

// §48 gates after settlement (issue #267): the `[verify]` commands run in
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
  },
  capture: RunCapture,
): Promise<HeadlessRunResult> {
  // Issue #148: every result after the lane booted names the model the
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
  },
  capture: RunCapture,
): Promise<HeadlessRunResult> {
  // Defense-in-depth with run-cli's --session check: direct callers bypass
  // the CLI, so reject path-unsafe ids here (exit-2-bound usage terminus)
  // before any store attach or path join can see them.
  if (
    options.sessionId !== undefined &&
    !SESSION_ID_PATTERN.test(options.sessionId)
  ) {
    const invalid = `invalid --session id ${JSON.stringify(options.sessionId)} (use [A-Za-z0-9_-])`;
    return finished('unassigned', 'usage', invalid, invalid);
  }
  // Guard overrides are validated before any store or lane exists: an
  // invalid bound fails closed with the usage terminus (exit 2) and never
  // boots a lane. Unset bounds fall through to the CLI default below.
  if (
    options.timeoutMs !== undefined &&
    (!Number.isInteger(options.timeoutMs) || options.timeoutMs <= 0)
  ) {
    const invalid = `invalid timeoutMs ${JSON.stringify(options.timeoutMs)} (need a positive integer of milliseconds)`;
    return finished('unassigned', 'usage', invalid, invalid);
  }
  // Same ceiling as the CLI (defense-in-depth for direct callers): above
  // 2^31-1 ms setTimeout clamps to 1 ms, which would fire the "bound"
  // immediately and misreport budget_exhausted.
  if (
    options.timeoutMs !== undefined &&
    options.timeoutMs > MAX_RUN_TIMEOUT_MS
  ) {
    const invalid = `invalid timeoutMs ${JSON.stringify(options.timeoutMs)} (max ${MAX_RUN_TIMEOUT_MS})`;
    return finished('unassigned', 'usage', invalid, invalid);
  }
  if (
    options.maxTurns !== undefined &&
    (!Number.isInteger(options.maxTurns) || options.maxTurns <= 0)
  ) {
    const invalid = `invalid maxTurns ${JSON.stringify(options.maxTurns)} (need a positive integer of turns)`;
    return finished('unassigned', 'usage', invalid, invalid);
  }
  // §40.1 mechanism 1 (issue #273): the per-invocation tool selection is
  // validated before any lane boots — mutual exclusion, unknown names and
  // the §40.3 agreement with the permission classes all fail closed as the
  // usage terminus (exit 2), never a silently narrowed run.
  if (options.tools !== undefined && options.noTools === true) {
    const invalid = '--tools and --no-tools are mutually exclusive';
    return finished('unassigned', 'usage', invalid, invalid);
  }
  if (options.tools !== undefined) {
    const known = Object.keys(OPERATIONS).sort();
    const unknown = options.tools.find((tool) => !known.includes(tool));
    if (unknown !== undefined) {
      const invalid = `unknown tool ${JSON.stringify(unknown)} (known tools: ${known.join(', ')})`;
      return finished('unassigned', 'usage', invalid, invalid);
    }
    const agreement = checkAgreement(
      validateClasses({ ...(deps.policyClasses ?? SOLO_DEFAULTS) }),
      [...options.tools],
    );
    if (!agreement.agree) {
      return finished(
        'unassigned',
        'usage',
        agreement.reason,
        agreement.reason,
      );
    }
  }
  // §71 child-side budget (issue #208): the manager hands each worker its
  // resolved spec through the §3.8 allowlisted KUBIC_BUDGET. A malformed
  // payload fails closed as a usage terminus — a silently dropped limit is
  // the false sense of cost control this issue exists to remove.
  let runBudget: OrchestratorBudget | undefined;
  try {
    runBudget = parseWorkerBudgetEnv(process.env.KUBIC_BUDGET);
  } catch (error) {
    const invalid = error instanceof Error ? error.message : String(error);
    return finished('unassigned', 'usage', invalid, invalid);
  }
  const root = deps.sessionsRoot ?? defaultSessionsRoot();
  const context = deps.context ?? BACKGROUND_CONTEXT;
  // §50 debug channel: `--debug` routes the span lines AND the run's
  // diagnostics (extension receipt, reconcile/overlap notices, skill-load
  // reports, drain failures) to one sink. An injected deps.debug still wins;
  // without either, the diagnostics are off — the prod `kubic run` wires
  // only the flag, so these lines were unreachable before.
  const debugSink: DebugSink | undefined =
    options.debug === true
      ? (deps.debugSink ?? ((line: string) => console.error(line)))
      : undefined;
  // The §50 vocabulary is closed: a diagnostic without its own class rides
  // the sink as `[session]`.
  // Issue #359: every resolved provider key is redacted from the debug
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
  // Extension startup (issue #93): the solo lane loads the first-party
  // bundle set through the trust gates BEFORE any store or lane exists — a
  // missing/refused bundle fails this run closed (ExtensionStartupError maps
  // to `failed` below with the named message) instead of running bare. The
  // receipt always fires, so refusals are reported, never swallowed.
  let extensions: BundleLoad | undefined;
  try {
    extensions =
      deps.extensions ??
      (await loadExtensionStartup('run', process.cwd(), {
        receipt: (line) => debug?.(line),
        ...(deps.extensionOptions === undefined
          ? {}
          : { options: deps.extensionOptions }),
      }));
  } catch (error) {
    return storeFailure(undefined, error);
  }
  // §49.3 spans on the live path (issue #98): the run, its lane accept/drive
  // steps and every harness tool call are recorded on the §29 SpanRecorder
  // and persisted to <root>/<id>/spans.jsonl when the run settles. The
  // recorder is created before the store so a store failure still leaves a
  // (run-only) trace behind.
  const spans = new RunSpans(Date.now, debugSink);
  const runSpan = spans.startRun();
  // Every session write goes through the one bridge, so it is the choke
  // point for scrubbing the live provider keys out of the session JSONL and
  // the span artifact (issue #359): a provider echoing a rejected key in its
  // error body must not persist it.
  const bridge = redactBridgeWrites(createNodeFileBridge(root), () =>
    capture.liveSecrets(),
  );
  const store = openSessionStore(root, bridge);
  let session: SessionHandle;
  try {
    session =
      options.sessionId === undefined
        ? await createSession(
            store,
            { cwd: deps.env?.cwd ?? process.cwd() },
            context,
          )
        : await attachSession(store, options.sessionId, context);
  } catch (error) {
    return storeFailure(options.sessionId, error);
  }
  const id = session.id;
  capture.sessionId = id;
  capture.sessionsRoot = root;
  // Declared outside the try so the `finally` sweep below can reach it
  // (issue #87): assigned once the lane's env (the workspace root) exists.
  let reconciliation: RunReconciliation | undefined;
  // Issue #325: the installed policy's end-of-session posture check.
  let settlePolicy: (() => void) | undefined;
  // Issue #109: the booted lane is hoisted so every exit path can stop the
  // in-flight turn — a guard firing mid-turn must not abandon the tool
  // processes it interrupted.
  let solo: SoloLane | undefined;
  // Set when a guard or an interrupt abandoned a live turn: the finally then
  // states the durable conversation abort (plus the kill drain) instead of
  // dropping handles for work that is still running.
  let abandoned = false;
  // The run's guard (issue #84): every wait runs on this cancellable context,
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
  // Counted from the committed usage events (#398): one per assistant
  // response, the turn unit `--max-turns` bounds.
  let turns = 0;
  // The run's guard timer (issue #84): armed with the wall-clock bound once
  // the session exists, cleared on every exit path.
  let deadline: ReturnType<typeof setTimeout> | undefined;
  // Interrupts (SIGINT/SIGTERM/SIGHUP): installed from here until the finally
  // has drained, so the default handler can no longer kill the run past its
  // own cleanup. The first signal kills the running children synchronously
  // (they sit in their own process groups and never saw the signal — D1 keys
  // them by conversation id) and cancels the guard; the listeners detach at
  // once, so a second Ctrl-C force-quits through the default handler.
  const signals = deps.signals ?? process;
  let signalsAttached = false;
  // Set by the first signal. Boot checks it before each expensive step (and
  // before the turn), so a pre-turn Ctrl-C cancels the boot instead of
  // letting it run on unseen.
  let interruptedBy: string | undefined;
  const detachSignals = (): void => {
    if (!signalsAttached) return;
    signalsAttached = false;
    for (const name of INTERRUPT_SIGNALS) signals.off(name, onSignal);
  };
  function onSignal(signal: string): void {
    detachSignals();
    interruptedBy ??= signal;
    if (solo !== undefined) {
      for (const kill of solo.kills.drain(String(solo.conversation.id))) {
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
  // The span artifact is the durable half of criterion 1: written on every
  // exit path (success or mapped failure) next to the session journal.
  const flushSpans = (): void => {
    spans.endRun(runSpan);
    try {
      bridge.appendFile(
        join(id, 'spans.jsonl'),
        serializeSpanArtifact(spans.trace(), runSpan, id),
      );
    } catch {
      // Telemetry must never mask the run's own result: a failed artifact
      // write is not a run failure.
    }
  };
  // Solo no-isolation notice (issue #89): the trust model is announced on
  // stderr before the first turn, once per process start, using the module
  // strings verbatim so `kubic tui` reads identically. Suppressed for
  // orchestrator-managed children (KUBIC_WORKER_ID set — `kubic doctor`
  // reports that mode's own worktree limit) and for the documented
  // KUBIC_NO_NOTICE opt-out. stderr, never stdout: `--json` stays parseable.
  if (shouldEmitSoloNotice(process.env)) {
    emitSoloWarning((line) => process.stderr.write(`${line}\n`));
  }
  try {
    // Attached inside the try: the finally below always detaches them.
    attachSignals();
    bridge.createDir(join(id, 'journal'));
    // The wall clock starts with the run's own work (the pending settlement
    // and the turn), not with the boot: a slow boot is not a slow turn. The
    // prompt entry is written by `submit` itself (#247), so there is no
    // pre-boot prompt write to fail here.
    const boundMs = options.timeoutMs ?? DEFAULT_RUN_TIMEOUT_MS;
    deadline = setTimeout(
      () => tripGuard(new WallClockError(boundMs)),
      boundMs,
    );
    const afterBound = bootInterrupted();
    if (afterBound !== undefined) return afterBound;
    // Readiness handshake (issue #94; §13): when this process IS a worker
    // (`kubic orchestrate` launches it with KUBIC_WORKER_ID in the §3.8
    // allowlist), announce that the worker is up the moment its session is
    // attached and its prompt recorded. The orchestrator's launch waits
    // for exactly this line — a child that never prints it is terminal
    // SPAWN_FAILED instead of a silent hang, and the latency to it is the
    // §61 startup sample. An ordinary `kubic run` has no worker id and
    // prints nothing extra.
    const workerId = process.env.KUBIC_WORKER_ID;
    if (workerId !== undefined && workerId !== '') {
      process.stdout.write(`${readyMarker(workerId)}\n`);
    }
    // §12.1 role selection (issue #99; issue #133 adds the config layers):
    // `--role` loads the role document and derives ALL THREE halves of the
    // lane boot from it — the prompt text (the document's `## Prompt`), the
    // tool allowlist (the resolved set), and the model default (a layer's
    // `[roles.<name>].model` pin). It resolves BEFORE the model selection so
    // the pin can act as the selection default. All four refusals are
    // fail-closed with a named reason: an unknown role, a contradictory
    // document (§40.3), a document with no instructions, and a parse failure.
    // Nothing is invented, and an absent --role leaves the solo boot
    // byte-identical.
    let role: { resolved: ResolvedRole; prompt: string } | undefined;
    // §67 (issue #191): the manager hands the worker its task — the
    // capability grant travels with the work, so the child registers exactly
    // `task.toolNames` instead of re-deriving a role from its own worktree
    // (a checkout of HEAD, not the working tree the plan was composed from).
    // A task that cannot be read or validated fails the run closed, and a
    // task naming a different worktree than the child's cwd is a mismatch,
    // never a silent adaptation.
    const agentTask = readAgentTask(bridge, process.env.KUBIC_TASK_FILE);
    if (agentTask.error !== undefined) {
      return finished(id, 'failed', agentTask.error, agentTask.error);
    }
    const task = agentTask.task;
    if (task !== undefined) {
      capture.task = task;
    }
    // §58 enterprise gates (issue #288): one local view of the resolved
    // policy, so the role resolution, the model selection and the lane tool
    // set all read the same object.
    const enterprisePolicy = deps.modelPolicy;
    const toolGate =
      enterprisePolicy !== undefined && hasToolPolicy(enterprisePolicy)
        ? (tool: string): boolean =>
            isToolAllowedByEnterprise(enterprisePolicy, tool)
        : undefined;
    // The stored model of a resumed session is gated too (issue #288): the
    // selection is checked at boot, the stored one only by this closure.
    const modelGate =
      enterprisePolicy !== undefined && hasModelPolicy(enterprisePolicy)
        ? (provider: string, modelId: string): boolean =>
            isModelAllowed(enterprisePolicy, provider, modelId)
        : undefined;
    if (task !== undefined) {
      // The task IS the assignment: its role name and tool set are
      // authoritative, and the prompt was composed by the manager (it already
      // carries the role's `## Prompt` text). No role document is read, so an
      // uncommitted `.kubic/roles/<name>.md` in the manager's working tree
      // still gives the worker the tool set the manager resolved.
      capture.role = task.role;
      debug?.(
        `[policy] task=${task.taskId} role=${task.role} tools=${task.toolNames.join(',')}`,
      );
    } else if (options.role !== undefined) {
      const rolesBridge = createNodeFileBridge(
        deps.roles?.cwd ?? process.cwd(),
      );
      const rolesCwd = deps.roles?.cwd ?? process.cwd();
      // Issue #229: role documents resolve at the project root, so
      // `--role` from a subdirectory finds `<root>/.kubic/roles/*.md`.
      const rolesRoot = findProjectRoot(rolesBridge, rolesCwd, homedir());
      let selected: SelectedRole;
      try {
        selected = selectRole({
          bridge: rolesBridge,
          cwd: rolesCwd,
          role: options.role,
          projectRoot: rolesRoot,
          ...(deps.roles?.layers === undefined
            ? {}
            : { layers: deps.roles.layers }),
          // §58 enterprise policy (issue #288): a role document declaring a
          // denied tool is refused here, by name, before the lane boots.
          ...(enterprisePolicy === undefined
            ? {}
            : { toolPolicy: enterprisePolicy }),
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return finished(id, 'failed', message, message);
      }
      let promptText: string;
      try {
        // The prompt comes from the winning document (issue #203): a repo
        // override's text, or the preset embedded in the binary.
        promptText = rolePromptFor(selected.doc, selected.markdown);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return finished(id, 'failed', message, message);
      }
      debug?.(
        `[policy] role=${selected.resolved.name} tools=${selected.resolved.tools.join(',')}`,
      );
      role = { resolved: selected.resolved, prompt: promptText };
      capture.role = selected.resolved.name;
    }
    // A refused models.json is a config error the user must see: it goes
    // to the warning channel unconditionally; a successful load is a
    // receipt for the debug channel only.
    let models: MutableModels;
    // Issue #221: the implicit pick only considers customs and built-ins
    // whose auth is configured — a keyless built-in is never picked.
    let fallbackProviders: readonly string[] | undefined;
    if (deps.models === undefined) {
      // Request-time provider keys (issue #359, §36.1): a models.json key is
      // resolved per request and each use lands in the §60 ledger of the
      // run's workspace — a worker's under its own worktree root.
      const worker = process.env.KUBIC_WORKER_ID;
      let identityWords: string[] | undefined;
      const keyResolver = createLedgerModelKeyResolver({
        workspace: deps.env?.cwd ?? process.cwd(),
        role:
          role?.resolved.name ??
          (worker === undefined || worker === '' ? 'root' : `worker:${worker}`),
        sessionId: () => id,
        mode: worker === undefined || worker === '' ? 'solo' : 'orchestrator',
        onError: (message) =>
          debug?.(`[session] credential use not audited: ${message}`),
        // A dummy key that IS its provider's name (LM Studio's `lm-studio`)
        // is identity, not a secret (issue #359): the catalog's provider and
        // model ids are read once assembled — a line emitted before that
        // (the models receipts) has nothing to exempt yet.
        identity: () => {
          if (identityWords !== undefined) return identityWords;
          const catalog = models as MutableModels | undefined;
          if (catalog === undefined) return [];
          identityWords = catalogIdentity(catalog);
          return identityWords;
        },
      });
      capture.liveSecrets = keyResolver.live;
      // Worker role credentials (issue #200; §36.3): when this process IS an
      // orchestrator worker, its provider key travelled as a
      // KUBIC_ROLE_<role>_* grant. The models assembly reads the grant back
      // under the provider-key names its auth resolution asks for; the plain
      // names exist only in this view, never in the child's process env. A
      // plain `kubic run` holds no grant, so the view is the identity.
      const modelsEnv = withRoleGrant(
        Object.fromEntries(
          Object.entries(process.env).filter(
            (entry): entry is [string, string] => entry[1] !== undefined,
          ),
        ),
        options.role ?? 'worker',
      );
      const assembled = await assembleModels(
        deps.modelsCwd ?? process.cwd(),
        modelsEnv,
        {
          resolveApiKey: keyResolver.resolve,
          ...(deps.trustProject === undefined
            ? {}
            : { projectTrust: deps.trustProject }),
        },
      );
      for (const note of assembled.notes) {
        if (note.startsWith('models.json ignored')) {
          (deps.warn ?? ((line: string) => process.stderr.write(`${line}\n`)))(
            note,
          );
        } else {
          debug?.(note);
        }
      }
      models = assembled.models;
      fallbackProviders = assembled.fallbackProviders;
    } else {
      models = deps.models;
    }
    // The faux testing provider (`KUBIC_PROVIDER=faux`): registered by
    // assembleModels and pinned here, so it is the model that answers —
    // announced on the warning channel before the first turn (never
    // silent). Any other KUBIC_PROVIDER value is refused by name.
    const providerOverride = providerOverrideFromEnv(process.env);
    if (providerOverride.kind === 'invalid') {
      const message = invalidProviderMessage(providerOverride.value);
      return finished(id, 'provider_probe_failed', message, message);
    }
    const fauxPinned =
      providerOverride.kind === 'faux' && deps.models === undefined;
    if (fauxPinned) {
      (deps.warn ?? ((line: string) => process.stderr.write(`${line}\n`)))(
        FAUX_NOTICE,
      );
    }
    let model: ReturnType<typeof selectModel>;
    try {
      // An explicit pin (replay re-execution at the declared model, or the
      // `[model]`/env/cli pin runtimeModelPin projects) wins over default
      // selection; the role layer's own `provider/id` pin (issue #133) is
      // the next default, and `kubic run` with neither takes the first
      // usable provider (customs first; never a keyless built-in). The
      // §58 enterprise policy (issue #288) gates the explicit/role
      // selection and the implicit provider pool the same way on this
      // path and on `kubic tui`.
      const explicitSelection = fauxPinned
        ? { provider: FAUX_PROVIDER_ID, id: FAUX_MODEL_ID }
        : deps.model;
      const roleSelection = roleModelSelection(role?.resolved.model);
      model = selectModelUnderPolicy(
        models,
        explicitSelection,
        roleSelection,
        fallbackProviders,
        enterprisePolicy,
      );
    } catch (error) {
      if (error instanceof ModelSelectError) {
        return finished(
          id,
          'provider_probe_failed',
          error.message,
          error.message,
        );
      }
      throw error;
    }
    capture.model = { provider: model.provider, id: model.id };
    const env = deps.env ?? new NodeExecutionEnv(process.cwd());
    // §67 (issue #191): the task names the worktree the child must run in —
    // a mismatch is a fail-closed refusal, never a silent adaptation. The
    // physical path is compared (the env's own realpath), so a symlinked
    // worktree root is the same worktree.
    if (task !== undefined) {
      // The compare needs an UNCONFINED physical path: the env's own
      // `realpath` confines to `env.cwd` first, so a same-tree path spelled
      // differently (a logical root against a physical cwd) would throw and
      // read as a mismatch — a false refusal, not a normalized compare. The
      // bridge resolves absolute paths without confinement; a path that
      // cannot be resolved compares as null and is reported.
      const unconfined = createNodeFileBridge(env.cwd);
      const physical = (path: string): string | null => {
        try {
          return unconfined.realPath?.(path) ?? path;
        } catch {
          return null;
        }
      };
      if (physical(task.worktree) !== physical(env.cwd)) {
        const message = `agent task '${task.taskId}' names worktree ${task.worktree}, but this run is in ${env.cwd}`;
        return finished(id, 'failed', message, message);
      }
    }
    capture.cwd = env.cwd;
    // Installed policy (issue #86; §40, §41): the composition root derives
    // the classes and interceptor options the lane runs on, ONCE, from the
    // same function doctor reads (host/approvals.installSoloPolicy). Config-
    // sourced classes (issue #90) replace the documented SOLO_DEFAULTS; the
    // destructive/network/confine guards and the approval ask are installed
    // either way, so a run with no config is no longer a run with no policy.
    // The workspace root is explicit — the lane cannot invent one.
    // Per-worker approvals (issue #105): when this process IS an
    // orchestrator-managed worker child, the orchestration's run told it where
    // the ask mailbox is. The seat published there is what turns a challenged
    // call into a question for the USER instead of a dead end.
    const approvalMailboxDir = process.env.KUBIC_APPROVALS_DIR;
    // Issue #149: the manager's public verification key. An answer in the
    // mailbox is a verdict only when it carries this manager's MAC — the
    // mailbox is a directory the worker itself can write, so without the key
    // there is nothing to verify and no seat to attach.
    const approvalVerifyKey = process.env.KUBIC_APPROVALS_VERIFY_KEY;
    // Issue #230: the manager hands its child a bound below its own config
    // maxPendingMs; absent or malformed keeps the shipped child default.
    const workerBoundRaw = process.env.KUBIC_APPROVALS_BOUND_MS;
    const workerBoundMs =
      workerBoundRaw !== undefined && /^[1-9]\d*$/.test(workerBoundRaw)
        ? Number(workerBoundRaw)
        : DEFAULT_WORKER_APPROVAL_BOUND_MS;
    const approvalsSeat =
      approvalMailboxDir === undefined ||
      approvalMailboxDir.trim() === '' ||
      approvalVerifyKey === undefined ||
      approvalVerifyKey.trim() === ''
        ? undefined
        : createWorkerMailboxSeat({
            dir: approvalMailboxDir,
            // The child's own bound. It sits BELOW the orchestration's bound on
            // purpose: the child denies closed with the named status rather
            // than outliving the run that would answer it.
            maxPendingMs: workerBoundMs,
            verifyKey: approvalVerifyKey,
            // Issue #159: the §12 role this child was booted as, so the ask it
            // publishes (`kubic audit`) names the role that asked, not a
            // hardcoded label. Absent means an unroled worker.
            role: options.role ?? 'worker',
            // A refused (unsigned, forged or stale) answer is named on the
            // debug surface instead of reading as a silent denial.
            onRefused: (detail) => debug?.(`approvals: ${detail}`),
          });
    const warnLine =
      deps.warn ?? ((line: string) => process.stderr.write(`${line}\n`));
    // §41.4 (issue #308): the explicit flag enables full access for THIS
    // session through the one host enable path (posture.json + one §60 row +
    // the shared warning) BEFORE the policy is installed, so the lane boots
    // under the posture the user asked for.
    const fullAccessGrant =
      options.dangerouslySkipApprovals === true
        ? enableSessionFullAccess({
            sessionDir: join(root, id),
            sessionId: id,
            command: 'run',
            workspace: env.cwd,
            onAuditError: (message) =>
              debug?.(`audit: ledger append failed: ${message}`),
          })
        : undefined;
    // The `provider/id` the §60 rows name (issue #148): seeded with the
    // selection and re-pointed at the model the lane REPORTS once the boot
    // has applied the stored-model rule — the policy is installed before the
    // lane exists, so it reads this at record time instead of freezing the
    // pre-boot pick.
    let liveModelRef = `${model.provider}/${model.id}`;
    // §60 audit identity (issue #282): the base revision this run started
    // from — `git rev-parse HEAD` captured once here, `none` outside git.
    // The policy is installed before the lane boots, so the revision is
    // resolved now and carried on the install.
    const runBase = await resolveRunBaseRevision(env.cwd, (cmd, args) =>
      env.shell
        .spawn(cmd, args, {
          provenance: {
            sessionId: id,
            agentId: deps.agentId ?? 'root',
            toolCallId: 'run:base-revision',
            turnId: 0,
            operation: 'run',
          },
        })
        .wait(),
    );
    // The thinking level the lane runs (issue #282): re-pointed at the
    // conversation's agent document once the boot has applied the stored
    // level — read at record time, like the model.
    let liveThinkingRef: string | undefined;
    const installed =
      deps.policy ??
      installSoloPolicy({
        workspace: env.cwd,
        ...(deps.policyClasses === undefined
          ? {}
          : { classes: deps.policyClasses }),
        // The layer's own record, so the posture's `source` is the same
        // answer doctor prints — never inferred from the object's shape.
        source: deps.policySource ?? 'default',
        // Issue #230: the configured approval policy, never the defaults.
        ...(deps.approvals ?? {}),
        sessionDir: join(root, id),
        // The session root in use is refused control-plane state (#324).
        sessionsRoot: root,
        // §60 audit identity for the ledger record of each resolved ask.
        sessionId: id,
        model: () => liveModelRef,
        // Issue #282: the thinking level at record time, and the base
        // revision captured above.
        thinking: () => liveThinkingRef,
        base: runBase,
        // Per-worker approvals (issue #105): an orchestrator-managed child
        // (`kubic orchestrate` set KUBIC_APPROVALS_DIR) attaches the mailbox
        // seat, so a challenged call it cannot answer itself reaches the USER
        // through the manager instead of dying at "no approval surface". The
        // wait is bounded inside the seat, so a manager that never answers
        // denies closed rather than hanging the child's turn.
        ...(approvalsSeat === undefined
          ? {}
          : { answer: approvalsSeat, maxPendingMs: workerBoundMs }),
        // Issue #279: a worker child's §60 records are orchestrator records
        // in the main repo ledger (seat-answered asks: the manager's).
        ...((): {
          orchestratedWorker?: {
            workerId: string;
            orchestratorSession: string;
          };
        } => {
          const worker = orchestratedWorkerFromEnv(process.env);
          return worker === undefined ? {} : { orchestratedWorker: worker };
        })(),
      });
    report.posture = installed.posture.fullAccess ? 'full-access' : 'approvals';
    settlePolicy = installed.settle;
    // A headless run on a full-access session is never silent (issue #308):
    // the grant's own warning when this run enabled it, otherwise the named
    // in-force warning — on stderr, so stdout stays consumable.
    if (installed.posture.fullAccess) {
      warnLine(fullAccessGrant?.warning ?? fullAccessInForceWarning(id));
    }
    const journal = new FileJournalStore(
      join(root, id, 'journal'),
      deps.journalRetention ?? {},
    );
    // §42.5 baseline (issue #87, §42.1 mechanism 2): captured ONCE, before
    // the first turn, as a metadata walk (hashes only, no blobs) that skips
    // `.git/`, `.kubic/` and `.gitignore` hits on its own. A capture failure
    // is not a run failure — the sweep then simply has no baseline to
    // compare against.
    try {
      reconciliation = beginReconciliation({
        store: journal,
        root: env.cwd,
        runId: id,
        sessionId: id,
        agentId: deps.agentId ?? 'root',
        // #107 review follow-up: a very large file (or a bridge without ranged
        // reads) is named on the existing debug channel rather than silently
        // costing its size at boot.
        onNotice: (detail: string) => debug?.(`reconcile: ${detail}`),
        ...(deps.reconcileOutOfScope === undefined
          ? {}
          : { outOfScope: deps.reconcileOutOfScope }),
      });
    } catch (error) {
      debug?.(
        `reconcile: baseline capture failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    // Repo-level overlap warning (issue #118; §42.5 blind spot): two
    // DIFFERENT sessions in one workspace are legal — this is a warning on
    // the debug channel, never a block. But each run sweeps against its own
    // boot baseline, so a live sibling's in-progress changes land in this
    // run's journal as unattributed, non-reversible entries. The store can
    // show a session, not its liveness, so the line says "may be live" and
    // names the sibling ids. A probe failure is a receipt, not a run
    // failure — the same posture as the baseline capture above.
    try {
      const touching = await sessionsTouchingWorkspace(store, env.cwd, context);
      const others = touching.filter((sessionId) => sessionId !== id);
      if (others.length > 0) {
        debug?.(
          `reconcile: another run may be live in this workspace — its in-progress changes will be recorded as unattributed (sessions: ${others.join(', ')})`,
        );
      }
    } catch (error) {
      debug?.(
        `reconcile: overlap probe failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    // Live facet consumption (issue #93): the loaded worker facet becomes a
    // real tool-wrap contribution on the solo lane's tool stack, so the
    // budget the CLI started with bounds every tool call. The contribution
    // composes through the lane's own documented seam ({ id, wrap }) and the
    // installed policy's wrappers compose outermost of it (issue #86); the
    // harness is destructured too so the §49.3 tool-span hooks can attach
    // (issue #98).
    const contributions = [
      ...installed.contributions,
      ...(extensions === undefined ? [] : [budgetToolGate(extensions)]),
    ];
    // §29.3 skills on the live path (issue #99): discovery runs at boot
    // through the real FileBridge, the project roots stay gated behind the
    // documented trust opt-in, and the model-visible blocks are appended to
    // the assembled system prompt as a suffix section. A refusal here is
    // not fatal by design (skills are context, never a gate) — the loader
    // reports unreadable skills on the debug channel and continues.
    const trustProject = deps.trustProject ?? deps.skills?.trustProject;
    const skills = bootSkills({
      bridge,
      cwd: deps.skills?.cwd ?? process.cwd(),
      homeDir: deps.skills?.homeDir ?? homedir(),
      trusted:
        deps.skills?.trusted ??
        (process.env.KUBIC_TRUST_PROJECT === '1' ||
          process.env.KUBIC_TRUST_PROJECT === 'true'),
      ...(trustProject === undefined ? {} : { trustProject }),
      ...(options.noSkills === undefined ? {} : { noSkills: options.noSkills }),
      ...(options.skills === undefined ? {} : { cliSkills: options.skills }),
      // Issue #177: an unresolvable explicit --skill warns on stderr —
      // never only on the debug channel — so a typo cannot read as loaded.
      warn: warnLine,
      log: (line) => debug?.(`skills: ${line}`),
    });
    capture.skills = skills.skills.map((skill) => skill.name);
    if (skills.skills.length > 0) {
      debug?.(
        `skills: ${skills.skills.length} loaded (${skills.skills
          .map((skill) => `${skill.name}@${skill.source}`)
          .join(', ')})`,
      );
    }
    const beforeBoot = bootInterrupted();
    if (beforeBoot !== undefined) return beforeBoot;
    // Issue #148 (§26.1): a pin (the faux pin, the `[model]`/env pin, or
    // the role's model) is an explicit selection and switches a resumed
    // session whose stored model differs; the default pick never does —
    // the session keeps its own model. Either way it is named on stderr.
    const notice = deps.notice ?? ((line: string) => console.error(line));
    const explicitModel = hasExplicitModelSelection({
      fauxPinned,
      pin: deps.model,
      roleModel: role?.resolved.model,
    });
    // §71 child-side enforcement (issue #208): one meter for the run, built
    // BEFORE the lane so its beforeTool gate can subscribe BEFORE the policy
    // interceptors — the hook chain stops at the first block, so a later
    // subscriber would never count a blocked/denied attempt. A breach stops
    // the turn, so the run ends BUDGET_EXHAUSTED (exit 3) with the dimension
    // named — never a silent overspend.
    const budgetPlan = runBudget;
    const budgetEnforcer =
      budgetPlan === undefined
        ? undefined
        : createRunBudgetEnforcer(budgetPlan, (termination) => {
            tripGuard(new BudgetExceededError(termination.limit));
          });
    try {
      solo = await bootSoloLane({
        session,
        models,
        model,
        modelPolicy: explicitModel ? 'selected' : 'stored',
        onModelNotice: notice,
        env,
        sessionId: id,
        agentId: deps.agentId ?? 'root',
        journal,
        // Issue #154 (§14.2): an orchestrator worker child can ask the USER a
        // free-text question through its run's mailbox (the same dir and
        // verify key the approval seat uses); a solo run has nobody to ask.
        ...(approvalsSeat === undefined ||
        approvalMailboxDir === undefined ||
        approvalVerifyKey === undefined
          ? {}
          : {
              interactionTools: [
                createAskUserTool({
                  dir: approvalMailboxDir,
                  verifyKey: approvalVerifyKey,
                  maxPendingMs: workerBoundMs,
                  sessionId: workerAskIdentity().sessionId,
                  agentId: workerAskIdentity().agentId,
                  role: options.role ?? 'worker',
                }),
              ],
            }),
        ...(skills.block === undefined
          ? {}
          : { promptSections: [skills.block] }),
        // Issue #173: the advertised skills outside the cwd stay readable.
        ...(skills.readRoots.length === 0
          ? {}
          : { skillReadRoots: skills.readRoots }),
        // §67 (issue #191): a task's tool set is the grant, and it outranks
        // any role document; without a task the role document's resolved set
        // is what narrows the lane (absence, not approval).
        ...(task !== undefined
          ? { toolAllowlist: [...task.toolNames] }
          : role === undefined
            ? {}
            : {
                rolePrompt: role.prompt,
                ...(role.resolved.tools.length === 0
                  ? {}
                  : { toolAllowlist: role.resolved.tools }),
              }),
        // The explicit CLI selection narrows whatever the task or role
        // granted: the lane intersects it (never widens).
        ...(options.noTools === true ? { noTools: true } : {}),
        ...(options.tools === undefined
          ? {}
          : { toolSelection: [...options.tools] }),
        // One policy object carrying every mechanism (#86 + #90 + #93, #397):
        // the classes come from the config layer when it supplies them and
        // from the documented safe default otherwise, the interceptors are
        // always installed, the extension facet composes as a tool-wrap
        // contribution on the same stack, and the two hook factories register
        // the budget gate (`kubic.budget`, first) and the tool spans
        // (`kubic.spans`, after policy). SoloPolicyOptions' fields are
        // independent, so this is a union, not a choice.
        policy: {
          classes: installed.classes,
          interceptors: installed.interceptors,
          ...(contributions.length === 0 ? {} : { contributions }),
          // §71 (issue #208): the budget meter goes FIRST. The chain stops
          // at the first block, so this is what makes a destructive or
          // network-denied call still count against maxToolCalls.
          ...(budgetEnforcer === undefined
            ? {}
            : { beforePolicyHooks: () => budgetEnforcer.hooks() }),
          // §49.3 (issue #98): the tool spans, installed after policy so a
          // blocked call never opens one (issue #397's ordering rule).
          spanHooks: () => runSpanHooks(spans),
          // §58 enterprise tool gate (issue #288): the same predicate drives
          // the active tool set and the prompt tools line.
          ...(toolGate === undefined ? {} : { toolAllowed: toolGate }),
          ...(modelGate === undefined ? {} : { modelAllowed: modelGate }),
        },
      });
    } catch (error) {
      // A stored session model that is no longer registered (issue #148)
      // is the same terminus as an unknown selection: exit 6, named.
      if (error instanceof ModelSelectError) {
        return finished(
          id,
          'provider_probe_failed',
          error.message,
          error.message,
        );
      }
      throw error;
    }
    // The boot reconciled the selection with the session's stored model
    // (issue #148): the trajectory and the audit rows name what the lane
    // reports, the same source as the envelope and the usage rows.
    const running = await liveModel(solo, context);
    if (running !== undefined) {
      capture.model = { provider: running.provider, id: running.id };
      liveModelRef = `${running.provider}/${running.id}`;
    }
    // Issue #282: the thinking level the lane actually runs (pi-durable
    // defaults an unset level to `off`, the same answer `/thinking`
    // reports) — the §60 rows name this, not the pre-boot pick.
    liveThinkingRef =
      (await solo.conversation.agent(context)).thinkingLevel ?? 'off';
    report.model = await liveModelId(solo, context);
    // §71 (issue #208) + the turn guard: one event subscription per
    // conversation (#398) feeds the budget meter's usage half and counts the
    // run's turns for `--max-turns`. Durable retries are the harness's own
    // (they commit no assistant entry), so a turn is one committed response.
    const detachEvents = await subscribeLaneEvents(
      solo.harness,
      solo.conversation.id,
      (event) => {
        // Issue #150 (§20.6, §27.1): a retry backoff and a compaction are
        // named on the debug channel — tens of silent seconds otherwise.
        const activity = laneActivityDebugLine(event);
        if (activity !== undefined) debug?.(activity);
        if (event.type !== 'usage') return;
        budgetEnforcer?.onUsage(event.row);
        turns += 1;
        if (options.maxTurns !== undefined && turns > options.maxTurns) {
          tripGuard(new TurnBudgetError(turns - 1));
        }
      },
      context,
    );
    try {
      const beforeTurn = bootInterrupted();
      if (beforeTurn !== undefined) return beforeTurn;
      // Issue #147 (§21): a turn a dead process left open would refuse this
      // prompt. The documented policy: when the pending run carries this very
      // prompt (an orchestrator worker re-launched on its reattached session,
      // a retried script), it is resumed AS this run — never re-prompted.
      // Otherwise it is resumed first under the same guard and then this
      // prompt is admitted; a resume that cannot settle (guard fired,
      // approval with no TTY) is durably aborted. Each choice is named on
      // stderr.
      // §49.3 lane spans (§98): `accept` covers admitting this run's work —
      // the pending turn a dead process left, settled first — and `drive`
      // covers the durable turn itself (submit → wait → settlement). Tool
      // spans nest under `drive` because `startLane('drive')` is the lane
      // open when the harness runs them.
      const pending = await inspectPending(solo, context);
      const acceptSpan = spans.startLane('accept');
      let resumed: Awaited<ReturnType<typeof solo.harness.submission>>;
      try {
        if (pending.pending) {
          const pendingPrompt = await pendingInputText(solo, context);
          const placed = (await solo.harness.inspect(context)).submissions.find(
            (record) => record.type === 'input' && record.status === 'placed',
          );
          if (
            pendingPrompt !== undefined &&
            pendingPrompt === prompt &&
            placed !== undefined
          ) {
            resumed = await solo.harness.submission(placed.id, context);
            notice(
              `${pending.summary ?? 'pending work'} carries this prompt: resuming it instead of re-prompting`,
            );
          } else {
            const settlement = await settlePending(solo, 'resume', {
              context,
              kills: solo.kills,
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
      // One stable request id per invocation (README "Persist and Resume"): a
      // re-submit inside this run finds the same submission instead of
      // prompting twice, while a fresh invocation is a fresh prompt.
      const requestId = `kubic-run:${randomUUID()}`;
      let outcome: TurnOutcome;
      // Issue #209: the solo overflow-recovery decision, when the lane
      // made one — carried into the envelope on every exit path below.
      let retryDecision: RetryDecision | undefined;
      let retryRetried = false;
      const driveSpan = spans.startLane('drive');
      try {
        if (resumed !== undefined) {
          outcome = await awaitTurn(resumed, guard.context);
        } else {
          // Issue #209: a context overflow compacts (#399) and retries
          // once on the fresh context; every other outcome passes through
          // exactly as runTurn reports it.
          const recovered = await runTurnWithOverflowRecovery(solo, prompt, {
            requestId,
            context: guard.context,
            // Headless keeps today's refusal: a run that somehow finds the
            // conversation busy fails by name instead of queueing behind a
            // turn nobody is watching (#334 owns follow-up UX).
            whenBusy: 'reject',
            onRetryDecision: (decision) => {
              const text = overflowRecoveryNotice(decision);
              if (text !== undefined) notice(text);
            },
          });
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
        return finished(id, 'budget_exhausted', message, message);
      }
      // The installed policy refused an approval (issue #86). The block reaches
      // the model as a tool error, so the lane settles `completed` — but a
      // dangerous operation the user never approved did NOT happen, and
      // reporting exit 0 would be the dishonest half of this issue. Read the
      // recorded refusals directly: a run whose policy denied an approval maps
      // to the §78 approval terminus (exit 4) with the refusal named. Checked
      // BEFORE the outcome is mapped: a denial OUTRANKS a settled turn.
      //
      // Issue #129: exit 4 covers the whole approval terminus; the STATUS is
      // the honest half. A denial whose reason carries the timeout marker is
      // a bound that elapsed, everything else is a refusal — a script can
      // tell "the operator said no" from "nobody answered in time". The
      // timeout latch (#110) has not yet put a structured `code` on
      // RecordedApprovalDeny, so classification keys off the orchestrator's
      // one TIMEOUT_REASON_MARKER string (the same one classifyVerdict uses)
      // rather than a private regex that could drift from the producers.
      const denials = installed.denials();
      if (denials.length > 0) {
        const named = denials
          .map((denial) => `${denial.capability} (${denial.toolName})`)
          .join(', ');
        // Classification reads the first recorded denial's reason (the same
        // first-denial convention as before).
        const first = denials[0]?.reason ?? '';
        const message = `approval refused: ${named} — ${first}`;
        const terminus = first.includes(TIMEOUT_REASON_MARKER)
          ? 'approval_timed_out'
          : 'approval_denied';
        return finished(id, terminus, message, message);
      }
      if (outcome.kind === 'completed') {
        const items = entriesToTranscript(
          await readConversationEntries(solo.conversation, context),
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
    // Issue #109: drain in-flight work FIRST — the sweep must observe the
    // tree after orphaned tool processes are dead, or their late writes
    // land outside both the journal and the reconciliation. Runs on every
    // exit path (guard exhaustion, an abandoned turn, an unexpected throw,
    // plain completion); a completed or failed turn forgets its (dead) kill
    // handles. Failures only reach the debug channel: the mapped result
    // and the sweep both stand.
    if (solo !== undefined) {
      if (abandoned) {
        await abortAbandonedLane(solo, (message) =>
          guardedReport(debug, message),
        );
      } else {
        forgetLaneKills(solo);
      }
    }
    // In-flight work is dead: a later signal takes the default path again.
    detachSignals();
    if (deadline !== undefined) clearTimeout(deadline);
    // §42.1 mechanism 2 (issue #87): the end-of-run sweep — after the last
    // turn, on every exit path (completed, guard exhaustion, deferred wait,
    // malformed outcome, an unexpected throw). Runs BEFORE the session close
    // so a close failure cannot skip it, and never changes the mapped
    // result: a sweep failure is reported on the debug receipt only.
    try {
      reconciliation?.sweep();
    } catch (error) {
      try {
        debug?.(
          `reconcile: sweep failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      } catch {
        // A throwing debug sink must not mask the mapped result either.
      }
    }
    flushSpans();
    // Issue #325: a posture.json written after the last ask is restored to
    // the boot posture (and recorded) before the session closes.
    try {
      settlePolicy?.();
    } catch {
      // Best-effort: the mapped result stands.
    }
    // The prompt guarantee first (#247): a run that never admitted the
    // prompt still gets its one durable entry, and the transcript decides —
    // never a second copy for a prompt that is already carried. Done before
    // the capture below so the §46 trajectory carries the fallback write.
    try {
      await ensurePromptDurable(solo, session, prompt, context, (message) =>
        guardedReport(debug, message),
      );
    } catch (error) {
      guardedReport(
        debug,
        `session: prompt not persisted: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    // The §46 trajectory's entries (issue #383), read while the session is
    // still open through the shared transcript adapter (#400); a read
    // failure leaves the trajectory without actions, never the run without
    // its result.
    capture.entries = await captureEntries(solo, session, context);
    // The harness owns the storage it adopted; closing it first means the
    // handle's release only gives the lock back (and closes a storage no
    // harness took). The result is already mapped: a close failure must
    // neither escape nor mask it. An abandoned turn may still hold a stuck
    // invocation, so THAT close is bounded — the run's own result wins.
    try {
      if (solo !== undefined) {
        const closing = solo.close(context);
        if (abandoned) {
          await settledWithin(closing, LANE_ABORT_BOUND_MS);
        } else {
          await closing;
        }
      }
    } catch {
      // Intentionally swallowed — the mapped result stands.
    }
    try {
      await session.release(context);
    } catch {
      // Intentionally swallowed — the mapped result stands.
    }
  }
}

// The provider ids and model ids a run names (issue #359): the words a live
// key value must not be scrubbed out of. Empty before the catalog exists.
function catalogIdentity(models: MutableModels | undefined): string[] {
  if (models === undefined) return [];
  return models
    .getProviders()
    .flatMap((provider) => [
      provider.id,
      ...models.getModels(provider.id).map((model) => model.id),
    ]);
}

// The `provider/id` the lane actually runs (issue #148): the live
// conversation's agent model, else the boot's effective model. Tolerant of
// liveness gaps, which report nothing rather than fail.
async function liveModel(
  solo: SoloLane,
  context: Context,
): Promise<{ provider: string; id: string } | undefined> {
  const agent = await solo.conversation.agent(context);
  const live = agent.model;
  if (live !== undefined) {
    return { provider: live.provider, id: live.modelId };
  }
  return solo.model as SoloLane['model'] | undefined;
}

async function liveModelId(
  solo: SoloLane,
  context: Context,
): Promise<string | undefined> {
  const running = await liveModel(solo, context);
  return running === undefined
    ? undefined
    : `${running.provider}/${running.id}`;
}
