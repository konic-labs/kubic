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
import type { ExecutionEnv } from '../../../packages/exec/src/env.js';
import { NodeExecutionEnv } from '../../../packages/exec/src/env.js';
import { createNodeFileBridge } from '../../../packages/exec/src/file-bridge.js';
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
import { redactSecretValues } from '../../../packages/host/src/config/secrets.js';
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
  attachToolSpans,
  RunSpans,
  serializeSpanArtifact,
  type ToolHookRegistry,
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
} from '../../../packages/host/src/orchestrator/approvals/worker-asks.js';
import {
  type EffectivePolicy,
  hasToolPolicy,
  isToolAllowedByEnterprise,
} from '../../../packages/host/src/policy/enterprise.js';
import type {
  ResolvedRole,
  RoleLayerInput,
} from '../../../packages/host/src/roles/resolver.js';
import {
  roleDocPath,
  rolePromptFor,
  type SelectedRole,
  selectRole,
} from '../../../packages/host/src/roles/roles-boot.js';
import {
  DEFAULT_RUN_TIMEOUT_MS,
  type HeadlessRunResult,
  MAX_RUN_TIMEOUT_MS,
  mapCaughtErrorToTerminus,
  mapLaneOutcomeToTerminus,
  SESSION_ID_PATTERN,
} from '../../../packages/host/src/run-cli.js';
import { defaultSessionsRoot } from '../../../packages/host/src/sessions-cli.js';
import { bootSkills } from '../../../packages/host/src/skills-boot.js';
import type { DebugSink } from '../../../packages/host/src/spans.js';
import type { RunOutcome } from '../../../packages/host/src/trajectory/run-trajectory.js';
import { drainOperation } from '../../../packages/worker/src/lane/abort.js';
import {
  describeSettlement,
  lastUserPromptText,
  pendingHead,
  settlePendingOperation,
} from '../../../packages/worker/src/lane/pending.js';

import {
  attachSession,
  createSession,
  openSessionStore,
  sessionsTouchingWorkspace,
} from '../../../packages/worker/src/lane/session-store.js';
import {
  bootSoloLane,
  driveToSettled,
  type LaneDriver,
  type SettledDrive,
  type SoloLane,
} from '../../../packages/worker/src/lane/solo.js';
import { withRoleGrant } from '../../../packages/worker/src/lifecycle/env.js';
import { readyMarker } from '../../../packages/worker/src/lifecycle/spawn.js';
import {
  ModelSelectError,
  type ModelSelection,
  type selectModel,
} from '../../../packages/worker/src/model-select.js';
import {
  BACKGROUND_CONTEXT,
  type Context,
  type Hooks,
  type MutableModels,
  type OperationResultRecord,
  type Session,
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
  };
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
// caught below and mapped to budget_exhausted with the ref triple intact.
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

// An interrupt (SIGINT/SIGTERM/SIGHUP) ends the drive like a guard does: control
// flow, mapped to `failed` (exit 1) after the drain — §78 has no separate
// interrupt code.
class InterruptedError extends Error {
  constructor(signal: string) {
    super(`run interrupted by ${signal}`);
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

function finished(
  id: string,
  terminus: HeadlessRunResult['terminus'],
  summary: string,
  errorMessage?: string,
): HeadlessRunResult {
  return {
    terminus,
    summary,
    sessionId: id,
    ...refs(id),
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
  const ref = sessionId ?? 'unassigned';
  return {
    terminus,
    summary: message,
    sessionId: ref,
    ...refs(ref),
    error: { kind: terminus, message },
  };
}

// Lane outcomes arrive as unknown at the composition root: the drive loop
// hands back whatever the lane settled with. Validate the record shape
// explicitly so a malformed outcome maps to failed with a clear message
// instead of throwing an incidental TypeError mid-map.
const TERMINAL_STATUSES: ReadonlySet<string> = new Set([
  'completed',
  'declined',
  'aborted',
  'failed',
]);

function isRecordError(
  value: unknown,
): value is { code: string; message: string } {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as { code?: unknown; message?: unknown };
  return typeof record.code === 'string' && typeof record.message === 'string';
}

function asResultRecord(outcome: unknown): OperationResultRecord | null {
  if (typeof outcome !== 'object' || outcome === null) return null;
  const record = outcome as { status?: unknown; error?: unknown };
  if (
    typeof record.status !== 'string' ||
    !TERMINAL_STATUSES.has(record.status)
  )
    return null;
  if (record.error !== undefined && !isRecordError(record.error)) return null;
  return record as OperationResultRecord;
}

// Guarded drive (issue #84): the lane's turn loop runs under a wall-clock
// bound and a turn bound. Exhaustion throws a guard error (caught below,
// mapped to budget_exhausted with the ref triple intact) — never a lane
// failure, never a hang. The pending drive promise is abandoned on
// timeout; the session close in the caller's finally still runs.
async function driveWithGuard(
  lane: LaneDriver,
  operationId: string,
  context: Context,
  boundMs: number,
  maxTurns: number | undefined,
  interrupted: Promise<never>,
  budgetExceeded: Promise<never>,
): Promise<SettledDrive> {
  let turns = 0;
  const counting: LaneDriver = {
    drive: async (driveOptions, driveContext) => {
      turns += 1;
      if (maxTurns !== undefined && turns > maxTurns) {
        throw new TurnBudgetError(turns - 1);
      }
      return lane.drive(driveOptions, driveContext);
    },
  };
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      driveToSettled(counting, operationId, context),
      interrupted,
      // An exhausted KUBIC_BUDGET (issue #208): the drive is abandoned and
      // the caller maps the rejection to budget_exhausted, exactly like the
      // wall-clock guard below.
      budgetExceeded,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new WallClockError(boundMs)), boundMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function tipId(entries: readonly unknown[]): string | null {
  // The store makes no order promise: take the max-seq entry's id.
  let best: string | null = null;
  let bestSeq = -1;
  for (const entry of entries) {
    const record = entry as { id?: unknown; seq?: unknown };
    if (typeof record?.id !== 'string') continue;
    const seq = typeof record.seq === 'number' ? record.seq : -1;
    if (seq >= bestSeq) {
      bestSeq = seq;
      best = record.id;
    }
  }
  return best;
}

// The named non-answer a completed run with no assistant text reports
// (issue #129): the summary is the model's own output or this sentence —
// never the operator's prompt echoed back as if it were a result.
export const NO_ASSISTANT_TEXT_SUMMARY =
  '(no assistant text — the run settled without output)';

// Final assistant text of the settled run for the result summary. A lane
// that left no assistant text yields undefined; the caller reports the
// named non-answer (NO_ASSISTANT_TEXT_SUMMARY) instead of the prompt.
export function assistantSummary(
  entries: readonly unknown[],
): string | undefined {
  let best: string | undefined;
  let bestSeq = -1;
  for (const entry of entries) {
    const record = entry as {
      seq?: unknown;
      type?: unknown;
      message?: { role?: unknown; content?: unknown };
    };
    if (record?.type !== 'message') continue;
    if (record.message?.role !== 'assistant') continue;
    if (!Array.isArray(record.message.content)) continue;
    const text = record.message.content
      .filter(
        (part) =>
          (part as { type?: unknown }).type === 'text' &&
          typeof (part as { text?: unknown }).text === 'string',
      )
      .map((part) => (part as { text: string }).text)
      .join('\n')
      .trim();
    if (text === '') continue;
    const seq = typeof record.seq === 'number' ? record.seq : -1;
    if (seq >= bestSeq) {
      bestSeq = seq;
      best = text.slice(0, 500);
    }
  }
  return best;
}

async function recordPrompt(
  session: Session,
  prompt: string,
  context: Context,
): Promise<void> {
  const existing = await session.findEntries(undefined, context);
  const parentId = tipId(existing);
  const entryId = randomUUID();
  await session.mutate(async (mutator) => {
    await mutator.commit(
      [
        {
          kind: 'entry',
          entry: {
            id: entryId,
            parentId,
            type: 'message',
            message: {
              role: 'user',
              content: [{ type: 'text', text: prompt }],
              timestamp: Date.now(),
            },
          },
        },
      ],
      context,
    );
  }, context);
}

// Issue #185 (§39, §68): the finished run reports its OWN usage — the
// session's usage rollup (what `kubic cost` reads), the tool calls it
// executed and the model that answered — so an orchestrator building a
// worker's §68 metrics reads real numbers from the child's report. Read
// after the session is closed; a run that never created a session, or a
// read that fails, keeps the refs-only report (never invented numbers).

// What the settled run leaves for its §46 trajectory (issue #383): filled
// as the run boots, read once after it settles.
interface RunCapture {
  startedAt: number;
  sessionsRoot?: string;
  sessionId?: string;
  cwd?: string;
  model?: { provider: string; id: string };
  role?: string;
  skills: string[];
  entries: unknown[];
  lane?: RunOutcome['lane'];
  interrupted: boolean;
}

// kubic run -p (issue #28) plus its §46 trajectory (issue #383): every run
// that attached a session writes <sessions-root>/<id>/trajectory.json when
// it settles — completed or not — and the result's trajectory ref names
// that file. A trajectory that cannot be written is reported on the warning
// channel; it never changes the run's own result.

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
  };
  // Issue #148/#308: the live lane model and the approval posture the lane
  // was installed with travel on the result (and so the --json envelope),
  // whatever path the run ends on.
  const report: {
    model?: string;
    posture?: 'approvals' | 'full-access';
  } = {};
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
  // kubic run -p plus its §46 trajectory (issue #383): every run that
  // attached a session writes <sessions-root>/<id>/trajectory.json when it
  // settles — completed or not — and the result's trajectory ref names that
  // file. A trajectory that cannot be written is reported on the warning
  // channel; it never changes the run's own result.
  if (capture.sessionId === undefined || capture.sessionsRoot === undefined) {
    return settled;
  }
  try {
    const path = persistRunTrajectory({
      sessionsRoot: capture.sessionsRoot,
      sessionId: capture.sessionId,
      agentId: deps.agentId ?? 'root',
      role: capture.role ?? 'solo',
      prompt,
      entries: capture.entries,
      ...(capture.model === undefined ? {} : { model: capture.model }),
      cwd: capture.cwd ?? deps.env?.cwd ?? process.cwd(),
      skills: capture.skills,
      startedAt: capture.startedAt,
      endedAt: Date.now(),
      outcome: {
        terminus: settled.terminus,
        summary: settled.summary,
        ...(capture.lane === undefined ? {} : { lane: capture.lane }),
        interrupted: capture.interrupted,
      },
    });
    return { ...settled, trajectoryRef: path };
  } catch (error) {
    (deps.warn ?? ((line: string) => process.stderr.write(`${line}\n`)))(
      `trajectory not written for session ${capture.sessionId}: ${error instanceof Error ? error.message : String(error)}`,
    );
    return settled;
  }
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
  let liveSecrets: () => string[] = () => [];
  const rawDebug: ((line: string) => void) | undefined =
    deps.debug ??
    (debugSink === undefined
      ? undefined
      : (line: string) =>
          debugSink(/^\[[a-z]+\]/.test(line) ? line : `[session] ${line}`));
  const debug: ((line: string) => void) | undefined =
    rawDebug === undefined
      ? undefined
      : (line: string) =>
          rawDebug(String(redactSecretValues(line, liveSecrets())));
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
  const bridge = createNodeFileBridge(root);
  const store = openSessionStore(root, bridge);
  let session: Session;
  try {
    session =
      options.sessionId === undefined
        ? await createSession(store, deps.env?.cwd ?? process.cwd(), context)
        : await attachSession(store, options.sessionId, context);
  } catch (error) {
    return storeFailure(options.sessionId, error);
  }
  const id = session.metadata.id;
  capture.sessionId = id;
  capture.sessionsRoot = root;
  // Declared outside the try so the `finally` sweep below can reach it
  // (issue #87): assigned once the lane's env (the workspace root) exists.
  let reconciliation: RunReconciliation | undefined;
  // Issue #325: the installed policy's end-of-session posture check.
  let settlePolicy: (() => void) | undefined;
  // Issue #109: the booted lane and the admitted operation are hoisted the
  // same way, so every exit path can drain in-flight work — a guard
  // firing mid-drive must not abandon the tool processes it interrupted.
  // solo stays undefined until boot succeeds; activeOperationId until an
  // admission succeeded (a refused admission has nothing to abort).
  let solo: SoloLane | undefined;
  let activeOperationId: string | undefined;
  // Abort request first (durable: the harness records operation_abort
  // in-session, §20.4), then the kill drain (detached process groups, so
  // grandchildren die with them), each failure swallowed to the debug
  // channel — the backstop is the drain, and a refusal must not skip it.
  const drainInFlight = async (): Promise<void> => {
    if (solo === undefined || activeOperationId === undefined) return;
    await drainOperation(
      solo.lane,
      solo.kills,
      activeOperationId,
      context,
      (message) => debug?.(`guard: ${message}`),
    );
  };
  // Interrupts (SIGINT/SIGTERM/SIGHUP): installed from here until the finally has
  // drained, so the default handler can no longer kill the run past its own
  // cleanup. The first signal kills the admitted operation's children
  // synchronously (they sit in their own process groups and never saw the
  // signal) and ends the drive; the listeners detach at once, so a second
  // Ctrl-C force-quits through the default handler.
  const signals = deps.signals ?? process;
  let rejectInterrupt: ((error: Error) => void) | undefined;
  const interrupted = new Promise<never>((_resolve, reject) => {
    rejectInterrupt = reject;
  });
  // Observed here so a signal outside the drive race is not an unhandled
  // rejection; the race still sees the rejected promise.
  interrupted.catch(() => undefined);
  let signalsAttached = false;
  // Set by the first signal. Boot checks it before each expensive step (and
  // before admission), so a pre-admission Ctrl-C cancels the boot instead
  // of letting it run on unseen.
  let interruptedBy: string | undefined;
  const detachSignals = (): void => {
    if (!signalsAttached) return;
    signalsAttached = false;
    for (const name of INTERRUPT_SIGNALS) signals.off(name, onSignal);
  };
  function onSignal(signal: string): void {
    detachSignals();
    interruptedBy ??= signal;
    if (solo !== undefined && activeOperationId !== undefined) {
      for (const kill of solo.kills.drain(activeOperationId)) {
        try {
          kill();
        } catch {
          // Already exited.
        }
      }
    }
    rejectInterrupt?.(new InterruptedError(signal));
  }
  const attachSignals = (): void => {
    signalsAttached = true;
    for (const name of INTERRUPT_SIGNALS) signals.on(name, onSignal);
  };
  const bootInterrupted = (): HeadlessRunResult | undefined => {
    if (interruptedBy === undefined) return undefined;
    capture.interrupted = true;
    const message = new InterruptedError(interruptedBy).message;
    return finished(id, 'failed', message, message);
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
    await recordPrompt(session, prompt, context);
    const afterPrompt = bootInterrupted();
    if (afterPrompt !== undefined) return afterPrompt;
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
    // §58 enterprise gates (issue #288): one local view of the resolved
    // policy, so the role resolution, the model selection and the lane tool
    // set all read the same object.
    const enterprisePolicy = deps.modelPolicy;
    const toolGate =
      enterprisePolicy !== undefined && hasToolPolicy(enterprisePolicy)
        ? (tool: string): boolean =>
            isToolAllowedByEnterprise(enterprisePolicy, tool)
        : undefined;
    if (options.role !== undefined) {
      const rolesBridge = createNodeFileBridge(
        deps.roles?.cwd ?? process.cwd(),
      );
      const rolesCwd = deps.roles?.cwd ?? process.cwd();
      let selected: SelectedRole;
      try {
        selected = selectRole({
          bridge: rolesBridge,
          cwd: rolesCwd,
          role: options.role,
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
        const path = roleDocPath(rolesCwd, selected.doc.name);
        promptText = rolePromptFor(
          selected.doc,
          rolesBridge.readTextFile(path),
        );
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
      const keyResolver = createLedgerModelKeyResolver({
        workspace: deps.env?.cwd ?? process.cwd(),
        role:
          role?.resolved.name ??
          (worker === undefined || worker === '' ? 'root' : `worker:${worker}`),
        sessionId: () => id,
        mode: worker === undefined || worker === '' ? 'solo' : 'orchestrator',
        onError: (message) =>
          debug?.(`[session] credential use not audited: ${message}`),
      });
      liveSecrets = keyResolver.live;
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
        { resolveApiKey: keyResolver.resolve },
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
    // Issue #230: the manager hands its child a bound below its own config
    // maxPendingMs; absent or malformed keeps the shipped child default.
    const workerBoundRaw = process.env.KUBIC_APPROVALS_BOUND_MS;
    const workerBoundMs =
      workerBoundRaw !== undefined && /^[1-9]\d*$/.test(workerBoundRaw)
        ? Number(workerBoundRaw)
        : DEFAULT_WORKER_APPROVAL_BOUND_MS;
    const approvalsSeat =
      approvalMailboxDir === undefined || approvalMailboxDir.trim() === ''
        ? undefined
        : createWorkerMailboxSeat({
            dir: approvalMailboxDir,
            // The child's own bound. It sits BELOW the orchestration's bound on
            // purpose: the child denies closed with the named status rather
            // than outliving the run that would answer it.
            maxPendingMs: workerBoundMs,
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
        model: `${model.provider}/${model.id}`,
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
    const skills = bootSkills({
      bridge,
      cwd: deps.skills?.cwd ?? process.cwd(),
      homeDir: deps.skills?.homeDir ?? homedir(),
      trusted:
        deps.skills?.trusted ??
        (process.env.KUBIC_TRUST_PROJECT === '1' ||
          process.env.KUBIC_TRUST_PROJECT === 'true'),
      ...(options.noSkills === undefined ? {} : { noSkills: options.noSkills }),
      ...(options.skills === undefined ? {} : { cliSkills: options.skills }),
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
    // BEFORE the lane so its before_tool gate can subscribe BEFORE the
    // policy interceptors — Pi's before_tool chain stops at the first block,
    // so a later subscriber would never count a blocked/denied attempt. A
    // breach rejects the drive race, so the run ends BUDGET_EXHAUSTED
    // (exit 3) with the dimension named — never a silent overspend.
    const budgetPlan = runBudget;
    let rejectBudget: ((error: Error) => void) | undefined;
    const budgetExceeded = new Promise<never>((_resolve, reject) => {
      rejectBudget = reject;
    });
    const budgetEnforcer =
      budgetPlan === undefined
        ? undefined
        : createRunBudgetEnforcer(budgetPlan, (termination) => {
            rejectBudget?.(new BudgetExceededError(termination.limit));
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
        ...(skills.block === undefined
          ? {}
          : { promptSections: [skills.block] }),
        // Issue #173: the advertised skills outside the cwd stay readable.
        ...(skills.readRoots.length === 0
          ? {}
          : { skillReadRoots: skills.readRoots }),
        ...(role === undefined
          ? {}
          : {
              rolePrompt: role.prompt,
              ...(role.resolved.tools.length === 0
                ? {}
                : { toolAllowlist: role.resolved.tools }),
            }),
        // One policy object carrying all three mechanisms (#86 + #90 + #93):
        // the classes come from the config layer when it supplies them and
        // from the documented safe default otherwise, the interceptors are
        // always installed, and the extension facet composes as a tool-wrap
        // contribution on the same stack. SoloPolicyOptions has three
        // independent fields, so this is a union, not a choice.
        policy: {
          classes: installed.classes,
          interceptors: installed.interceptors,
          ...(contributions.length === 0 ? {} : { contributions }),
          // §71 (issue #208): the budget meter goes FIRST. The chain stops
          // at the first block, so this is what makes a destructive or
          // network-denied call still count against maxToolCalls.
          ...(budgetEnforcer === undefined
            ? {}
            : {
                beforePolicyHooks: (hooks: Hooks) =>
                  hooks.on('before_tool', budgetEnforcer.onToolAttempt),
              }),
          // §58 enterprise tool gate (issue #288): the same predicate drives
          // the active tool set and the prompt tools line.
          ...(toolGate === undefined ? {} : { toolAllowed: toolGate }),
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
    const { harness, lane } = solo;
    report.model = await liveModelId(solo, context);
    // Tool spans come from the harness's own hook registry, so they cover
    // every tool the lane actually executes (issue #98). Detached in the
    // finally below. A lane booted without a harness (unit stubs, future
    // lanes) yields no registry: telemetry degrades to lane/run spans and
    // never fails the run.
    const detachToolSpans = attachToolSpans(toolHooksOf(harness), spans);
    // §71 child-side enforcement (issue #208): the usage half of the meter.
    // Usage is an event, not a hook, so it has no ordering constraint; it
    // shares the meter the before_tool gate already registered.
    const detachBudgetUsage =
      budgetEnforcer === undefined
        ? undefined
        : harness.events.on('usage', budgetEnforcer.onUsage);
    const detachBudgetHooks = solo.detachBeforePolicyHooks;
    try {
      const beforeAccept = bootInterrupted();
      if (beforeAccept !== undefined) return beforeAccept;
      const boundMs = options.timeoutMs ?? DEFAULT_RUN_TIMEOUT_MS;
      // Issue #147 (§21): a turn a dead process left open would refuse this
      // prompt with LaneBusy. The documented policy: when the pending run
      // carries this very prompt (an orchestrator worker re-launched on its
      // reattached session, a retried script), it is resumed AS this run —
      // never re-prompted. Otherwise it is resumed first under the same
      // guards and then this prompt is accepted; a resume that cannot
      // settle (guard fired, approval with no TTY) is durably aborted. Each
      // choice is named on stderr.
      let resumedOperationId: string | undefined;
      const open = solo.open ?? [];
      if (open.length > 0) {
        const pendingPrompt = lastUserPromptText(
          await lane.findEntries(undefined, context),
        );
        for (const op of open) {
          if (
            resumedOperationId === undefined &&
            op.kind === 'run' &&
            op.aborting !== true &&
            pendingPrompt === prompt
          ) {
            resumedOperationId = op.operationId;
            notice(
              `${pendingHead(op)} carries this prompt: resuming it instead of re-prompting`,
            );
            continue;
          }
          const settled = await settlePendingOperation(
            solo,
            op,
            'resume',
            context,
            (operationId) =>
              driveWithGuard(
                lane,
                operationId,
                context,
                boundMs,
                options.maxTurns,
                interrupted,
                budgetExceeded,
              ),
          );
          notice(describeSettlement(settled));
        }
      }
      let operationId: string;
      if (resumedOperationId !== undefined) {
        operationId = resumedOperationId;
      } else {
        const acceptSpan = spans.startLane('accept');
        const admission = await lane.accept(
          { kind: 'prompt', prompt },
          context,
        );
        if (!admission.ok) {
          const message = `lane refused the prompt: ${JSON.stringify(admission.error)}`;
          spans.endLane(acceptSpan, message);
          return finished(id, 'failed', message, message);
        }
        spans.endLane(acceptSpan);
        operationId = admission.value.operationId;
      }
      // Issue #109: record the admitted operation for the finally drain — a
      // guard firing mid-drive (or any later exit path) aborts and kills
      // exactly this operation's in-flight work before the sweep.
      activeOperationId = operationId;
      let driven: SettledDrive;
      const driveSpan = spans.startLane('drive');
      try {
        driven = await driveWithGuard(
          lane,
          operationId,
          context,
          boundMs,
          options.maxTurns,
          interrupted,
          budgetExceeded,
        );
      } catch (error) {
        // Guard exhaustion or an interrupt only: any other throw re-enters
        // the outer storeFailure path below.
        if (error instanceof InterruptedError) {
          capture.interrupted = true;
          spans.endLane(driveSpan, error.message);
          return finished(id, 'failed', error.message, error.message);
        }
        if (
          error instanceof TurnBudgetError ||
          error instanceof WallClockError ||
          error instanceof BudgetExceededError
        ) {
          const message = error.message;
          spans.endLane(driveSpan, message);
          return finished(id, 'budget_exhausted', message, message);
        }
        throw error;
      }
      spans.endLane(driveSpan);
      if (driven.kind === 'waiting-deferred') {
        const message =
          'headless run suspended waiting on an approval that cannot arrive without a TTY';
        return finished(id, 'approval_timed_out', message, message);
      }
      // The installed policy refused an approval (issue #86). The block reaches
      // the model as a tool error, so the lane settles `completed` — but a
      // dangerous operation the user never approved did NOT happen, and
      // reporting exit 0 would be the dishonest half of this issue. Read the
      // recorded refusals directly: a run whose policy denied an approval maps
      // to the §78 approval terminus (exit 4) with the refusal named.
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
      const record = asResultRecord(driven.outcome);
      if (record === null) {
        const detail =
          JSON.stringify(driven.outcome)?.slice(0, 500) ??
          String(driven.outcome);
        const malformed = `lane yielded a malformed outcome: ${detail}`;
        return finished(id, 'failed', malformed, malformed);
      }
      capture.lane = {
        status: record.status,
        ...(record.error === undefined ? {} : { error: record.error }),
      };
      const terminus = mapLaneOutcomeToTerminus(record.status, record.error);
      if (terminus === 'completed') {
        const entries = await lane.findEntries(undefined, context);
        return finished(
          id,
          terminus,
          assistantSummary(entries) ?? NO_ASSISTANT_TEXT_SUMMARY,
        );
      }
      const summary =
        record.error === undefined
          ? `lane ${record.status} without detail`
          : `${record.error.code}: ${record.error.message}`;
      return finished(id, terminus, summary, summary);
    } finally {
      detachBudgetHooks?.();
      detachBudgetUsage?.();
      detachToolSpans();
    }
  } catch (error) {
    return storeFailure(id, error);
  } finally {
    // Issue #109: drain in-flight work FIRST — the sweep must observe the
    // tree after orphaned tool processes are dead, or their late writes
    // land outside both the journal and the reconciliation. Runs on every
    // exit path (guard exhaustion, deferred wait, malformed outcome, an
    // unexpected throw, plain completion); no-ops when nothing was
    // admitted. Failures only reach the debug channel: the mapped result
    // and the sweep both stand.
    try {
      await drainInFlight();
    } catch (error) {
      try {
        debug?.(
          `guard: drain failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      } catch {
        // A throwing debug sink must not mask the mapped result either.
      }
    }
    // In-flight work is dead: a later signal takes the default path again.
    detachSignals();
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
    // The §46 trajectory's entries (issue #383), read while the session is
    // still open; a read failure leaves the trajectory without actions,
    // never the run without its result.
    try {
      capture.entries = await session.findEntries(undefined, context);
    } catch {
      capture.entries = [];
    }
    // The result is already mapped: a close failure must neither escape
    // nor mask it.
    try {
      await session.close(context);
    } catch {
      // Intentionally swallowed — the mapped result stands.
    }
  }
}

// The `provider/id` the lane actually runs (issue #148): the live lane
// model, else the boot's effective model. Tolerant of stub lanes (unit
// boots without getModel/model), which report nothing rather than fail.
async function liveModelId(
  solo: SoloLane,
  context: Context,
): Promise<string | undefined> {
  const live =
    typeof solo.lane.getModel === 'function'
      ? await solo.lane.getModel(context)
      : undefined;
  const running = live ?? (solo.model as SoloLane['model'] | undefined);
  return running === undefined
    ? undefined
    : `${running.provider}/${running.id}`;
}

// The harness hook registry for tool spans, tolerant of a harness-less lane
// (issue #98): unit stubs and future lane boots return only `{ lane }`, and
// telemetry must degrade rather than fail the run. The returned registry
// swallows subscriptions, so every caller stays branch-free.
function toolHooksOf(
  harness: { hooks?: unknown } | undefined,
): ToolHookRegistry {
  const hooks = harness?.hooks;
  if (hooks === undefined || hooks === null) return NO_HOOKS;
  return hooks as ToolHookRegistry;
}

const NO_HOOKS: ToolHookRegistry = { on: () => () => undefined };
