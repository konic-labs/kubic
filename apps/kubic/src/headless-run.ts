// Prod `kubic run -p` runner (issue #28): the composition root drives the
// real solo lane headless and derives the §78 terminus from the lane's own
// settled outcome (E1). Everything durable lands under
// <sessionsRoot>/<id>/ (E3): the transcript and usage rows in the session
// store, file effects in <id>/journal/ via lane interception, and the
// entry chain itself is the trajectory record — so every ref resolves to
// a real location. Resume keeps one chain: the -p prompt commits
// parent-linked to the last existing entry under a random id (E4).

import { randomUUID } from 'node:crypto';
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
  type InstalledSoloPolicy,
  installSoloPolicy,
} from '../../../packages/host/src/approvals.js';
import {
  emitSoloWarning,
  shouldEmitSoloNotice,
} from '../../../packages/host/src/limits/solo-warning.js';
import { assembleModels } from '../../../packages/host/src/models-cli.js';
import {
  attachToolSpans,
  RunSpans,
  serializeSpanArtifact,
  type ToolHookRegistry,
} from '../../../packages/host/src/ops/perf/run-spans.js';
import {
  DEFAULT_RUN_TIMEOUT_MS,
  type HeadlessRunResult,
  MAX_RUN_TIMEOUT_MS,
  mapCaughtErrorToTerminus,
  mapLaneOutcomeToTerminus,
  SESSION_ID_PATTERN,
} from '../../../packages/host/src/run-cli.js';
import { defaultSessionsRoot } from '../../../packages/host/src/sessions-cli.js';
import type { DebugSink } from '../../../packages/host/src/spans.js';
import {
  attachSession,
  createSession,
  openSessionStore,
} from '../../../packages/worker/src/lane/session-store.js';
import {
  bootSoloLane,
  driveToSettled,
  type LaneDriver,
  type SettledDrive,
} from '../../../packages/worker/src/lane/solo.js';
import { readyMarker } from '../../../packages/worker/src/lifecycle/spawn.js';
import {
  ModelSelectError,
  type ModelSelection,
  selectModel,
} from '../../../packages/worker/src/model-select.js';
import {
  BACKGROUND_CONTEXT,
  type Context,
  type MutableModels,
  type OperationResultRecord,
  type Session,
} from '../../../packages/worker/src/pi-boundary.js';
import { loadExtensionStartup } from './extension-startup.js';

export interface HeadlessRunOptions {
  sessionId?: string;
  timeoutMs?: number;
  maxTurns?: number;
  // §50 debug channel (issue #98): when set, the run emits its lane/tool
  // debug lines to the injected sink (stderr in prod). The span artifact is
  // written either way — spans are the durable half.
  debug?: boolean;
}

export interface HeadlessRunDeps {
  sessionsRoot?: string;
  models?: MutableModels;
  model?: ModelSelection;
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
  journalRetention?: JournalRetention;
  // The installed-policy seat (issue #86). Absent means the shipped
  // DEFAULT: the documented SOLO_DEFAULTS classes plus the destructive/
  // network/confine guards and the approval ask, all derived by
  // installSoloPolicy. Tests inject a variant here; nothing else may skip
  // the install, which is why the default is not an opt-in.
  policy?: InstalledSoloPolicy;
  // Declared out-of-scope paths for the §42.5 baseline (issue #87). Nothing
  // in the shipped config populates this yet, so it stays absent by default —
  // the mechanism already excludes `.git/`, `.kubic/` and `.gitignore` hits
  // on its own.
  reconcileOutOfScope?: string[];
  // Debug sink for the §50 lines (issue #98). Defaults to stderr so a live
  // `kubic run --debug` emits without the composition root wiring anything;
  // tests inject an array collector instead.
  debugSink?: DebugSink;
}

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

// Final assistant text of the settled run for the result summary;
// falls back to the prompt when the lane left no assistant text.
function assistantSummary(entries: readonly unknown[]): string | undefined {
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

export async function runHeadlessPrompt(
  prompt: string,
  options: HeadlessRunOptions,
  deps: HeadlessRunDeps = {},
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
  const root = deps.sessionsRoot ?? defaultSessionsRoot();
  const context = deps.context ?? BACKGROUND_CONTEXT;
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
        receipt: (line) => deps.debug?.(line),
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
  const spans = new RunSpans(
    Date.now,
    options.debug === true
      ? (deps.debugSink ?? ((line: string) => console.error(line)))
      : undefined,
  );
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
  // Declared outside the try so the `finally` sweep below can reach it
  // (issue #87): assigned once the lane's env (the workspace root) exists.
  let reconciliation: RunReconciliation | undefined;
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
    bridge.createDir(join(id, 'journal'));
    await recordPrompt(session, prompt, context);
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
    const assembled = assembleModels(process.cwd());
    const models = deps.models ?? assembled.models;
    let model: ReturnType<typeof selectModel>;
    try {
      // An explicit pin (replay re-execution at the declared model) wins
      // over default selection; `kubic run` passes none and keeps the
      // default first-registered-provider pick.
      model = selectModel(models, deps.model);
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
    const env = deps.env ?? new NodeExecutionEnv(process.cwd());
    // Installed policy (issue #86; §40, §41): the composition root derives
    // the classes and interceptor options the lane runs on, ONCE, from the
    // same function doctor reads (host/approvals.installSoloPolicy). Config-
    // sourced classes (issue #90) replace the documented SOLO_DEFAULTS; the
    // destructive/network/confine guards and the approval ask are installed
    // either way, so a run with no config is no longer a run with no policy.
    // The workspace root is explicit — the lane cannot invent one.
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
        sessionDir: join(root, id),
      });
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
        agentId: 'root',
        ...(deps.reconcileOutOfScope === undefined
          ? {}
          : { outOfScope: deps.reconcileOutOfScope }),
      });
    } catch (error) {
      deps.debug?.(
        `reconcile: baseline capture failed: ${error instanceof Error ? error.message : String(error)}`,
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
    const { harness, lane } = await bootSoloLane({
      session,
      models,
      model,
      env,
      sessionId: id,
      agentId: 'root',
      journal,
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
      },
    });
    // Tool spans come from the harness's own hook registry, so they cover
    // every tool the lane actually executes (issue #98). Detached in the
    // finally below. A lane booted without a harness (unit stubs, future
    // lanes) yields no registry: telemetry degrades to lane/run spans and
    // never fails the run.
    const detachToolSpans = attachToolSpans(toolHooksOf(harness), spans);
    try {
      const acceptSpan = spans.startLane('accept');
      const admission = await lane.accept({ kind: 'prompt', prompt }, context);
      if (!admission.ok) {
        const message = `lane refused the prompt: ${JSON.stringify(admission.error)}`;
        spans.endLane(acceptSpan, message);
        return finished(id, 'failed', message, message);
      }
      spans.endLane(acceptSpan);
      let driven: SettledDrive;
      const driveSpan = spans.startLane('drive');
      try {
        driven = await driveWithGuard(
          lane,
          admission.value.operationId,
          context,
          options.timeoutMs ?? DEFAULT_RUN_TIMEOUT_MS,
          options.maxTurns,
        );
      } catch (error) {
        // Guard exhaustion only: any other throw re-enters the outer
        // storeFailure path below.
        if (
          error instanceof TurnBudgetError ||
          error instanceof WallClockError
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
      const denials = installed.denials();
      if (denials.length > 0) {
        const named = denials
          .map((denial) => `${denial.capability} (${denial.toolName})`)
          .join(', ');
        const message = `approval refused: ${named} — ${denials[0]?.reason ?? ''}`;
        return finished(id, 'approval_timed_out', message, message);
      }
      const record = asResultRecord(driven.outcome);
      if (record === null) {
        const detail =
          JSON.stringify(driven.outcome)?.slice(0, 500) ??
          String(driven.outcome);
        const malformed = `lane yielded a malformed outcome: ${detail}`;
        return finished(id, 'failed', malformed, malformed);
      }
      const terminus = mapLaneOutcomeToTerminus(record.status, record.error);
      if (terminus === 'completed') {
        const entries = await lane.findEntries(undefined, context);
        return finished(id, terminus, assistantSummary(entries) ?? prompt);
      }
      const summary =
        record.error === undefined
          ? `lane ${record.status} without detail`
          : `${record.error.code}: ${record.error.message}`;
      return finished(id, terminus, summary, summary);
    } finally {
      detachToolSpans();
    }
  } catch (error) {
    return storeFailure(id, error);
  } finally {
    // §42.1 mechanism 2 (issue #87): the end-of-run sweep — after the last
    // turn, on every exit path (completed, guard exhaustion, deferred wait,
    // malformed outcome, an unexpected throw). Runs BEFORE the session close
    // so a close failure cannot skip it, and never changes the mapped
    // result: a sweep failure is reported on the debug receipt only.
    try {
      reconciliation?.sweep();
    } catch (error) {
      try {
        deps.debug?.(
          `reconcile: sweep failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      } catch {
        // A throwing debug sink must not mask the mapped result either.
      }
    }
    flushSpans();
    // The result is already mapped: a close failure must neither escape
    // nor mask it.
    try {
      await session.close(context);
    } catch {
      // Intentionally swallowed — the mapped result stands.
    }
  }
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
