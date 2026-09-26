// Live wiring for the orchestrator approval layer (issue #105; §41.1,
// §41.2, §41.4, §71). The modules beside this file (request/routing/
// budgets/skip) were implemented, tested — and unreachable: nothing on the
// delegation path constructed a router, asked the user, or gated spend. This
// module is their ONE live constructor, so `kubic orchestrate` gets:
//
//   - one router per run (createOrchestratorRouter) with a BOUNDED wait
//     (maxPendingMs) and a durable decision store under
//     <repo>/.kubic/orchestrator/approvals/, so a settled decision survives a
//     restart (§41.2 memoOnce) and a pending ask can never hang the run;
//   - the user as the decider, over a deferred channel that crosses the
//     process boundary: a worker child publishes its ask to
//     <dir>/asks/<key>.json and waits a bounded time for
//     <dir>/asks/<key>.answer.json; the manager (this module, parent process)
//     reads the ask, routes it to the user, and answers the worker. Both ends
//     are bounded, so neither a missing seat nor a dead child hangs anything;
//   - opt-in budgets per spawn (validateOrchestratorBudget): an absent budget
//     enforces nothing, a configured one blocks with BUDGET_EXHAUSTED
//     (exit 3), and a worker proposing to raise its own budget is refused by
//     applyBudgetRaise (raises are capability-proven, never string-trusted);
//   - the session-scoped full-access posture (skip.ts): grants are keyed by
//     sessionId, recorded beside the run, indicated on the surface — never
//     global, and a fresh session starts enforced;
//   - the manager's only view of an ask: buildManagerBlockedIndicator
//     (read-only). attemptManagerApprove is refused and audited.

import { join } from 'node:path';
import { createInterface } from 'node:readline';
import type { FileBridge } from '../../../../exec/src/file-bridge.js';
import { createNodeFileBridge } from '../../../../exec/src/file-bridge.js';
import {
  applyBudgetRaise,
  BUDGET_EXHAUSTED,
  type BudgetGate,
  createBudgetGate,
  type OrchestratorBudget,
  RUN_EXIT_BUDGET,
  recordToolCall,
  validateOrchestratorBudget,
} from './budgets.js';
import {
  buildOrchestratorRequest,
  type OrchestratorApprovalRequest,
  type OrchestratorRequestInput,
  orchestratorRequestKey,
} from './request.js';
import {
  attemptManagerApprove,
  buildManagerBlockedIndicator,
  createOrchestratorRouter,
  type DecisionStore,
  type ManagerBlockedIndicator,
  type OrchestratorRouter,
  type OrchestratorVerdict,
  type RouterAuditEvent,
} from './routing.js';
import {
  buildSessionSkipAuditEvent,
  enableSessionSkip,
  formatSessionSkipIndicator,
  isSessionSkipEnabled,
  type SessionSkipRecord,
} from './skip.js';
import { TIMEOUT_REASON_MARKER } from './timeout-reason.js';

// The named status a worker ask resolves to as DATA (the worker branch on
// it; the run maps it to §78 exit 4). `approval_denied` is a decider's
// refusal, `approval_timeout` is the bounded wait running out — the two are
// distinct, and neither is a crash.
export type WorkerAskCode = 'approval_denied' | 'approval_timeout';

export type WorkerAskOutcome =
  | { approved: true; key: string }
  | { approved: false; key: string; code: WorkerAskCode; reason: string };

export const APPROVAL_TIMEOUT_CODE: WorkerAskCode = 'approval_timeout';
export const APPROVAL_DENIED_CODE: WorkerAskCode = 'approval_denied';

// The bounded-wait denial names itself in the reason; classification keys off
// THIS marker so it never parses arbitrary prose. The marker lives in the
// shared timeout-reason module (issue #129) — producers interpolate it,
// classifiers read it — and is re-exported here so existing importers keep
// pointing at the single source.
export { TIMEOUT_REASON_MARKER };

export function classifyVerdict(
  key: string,
  verdict: OrchestratorVerdict,
): WorkerAskOutcome {
  if (verdict.approved) return { approved: true, key };
  return {
    approved: false,
    key,
    code: verdict.reason.includes(TIMEOUT_REASON_MARKER)
      ? APPROVAL_TIMEOUT_CODE
      : APPROVAL_DENIED_CODE,
    reason: verdict.reason,
  };
}

export interface WorkerAskInput {
  trigger: string;
  toolName: string;
  args: Record<string, unknown>;
  justification: string;
  sessionId: string;
  agentId: string;
  role: string;
  worktree: string;
  provenance: { parentSessionId: string; taskId?: string; model?: string };
}

// The key a request is bound to (session + agent + justification + worktree +
// canonical args), recomputed here so a caller can PROVE the binding without
// re-deriving it.
export function orchestratorRequestKeyFor(
  toolName: string,
  trigger: string,
  args: Record<string, unknown>,
  worktree: string,
  scope: { sessionId?: string; agentId?: string; justification?: string } = {},
): string {
  return orchestratorRequestKey(
    toolName,
    trigger as OrchestratorApprovalRequest['trigger'],
    args,
    worktree,
    scope,
  );
}

// What travels through the mailbox: the validated envelope (key recomputed,
// summary derived — never caller-supplied) plus the raw args the run needs to
// recognize a proposed budget raise (§71).
export interface PublishedWorkerAsk {
  request: OrchestratorApprovalRequest;
  args: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Durable decisions + audit, under <repo>/.kubic/orchestrator/approvals/
// ---------------------------------------------------------------------------

export const APPROVALS_DIR = 'approvals';
export const DECISIONS_FILE = 'decisions.json';
export const AUDIT_FILE = 'audit.jsonl';
export const ASKS_DIR = 'asks';
export const SKIP_RECORDS_FILE = 'skip-records.json';

// Durable decision store (§41.2 memoOnce across restarts). Load is
// corrupt-tolerant (a torn write reads as no decisions — fail closed toward
// re-asking); saves are atomic tmp+rename so a kill cannot leave a
// half-written decision file a later run would misread.
export class FileDecisionStore implements DecisionStore {
  private readonly bridge: FileBridge;
  private readonly file: string;

  constructor(dir: string) {
    this.bridge = createNodeFileBridge(dir);
    this.file = DECISIONS_FILE;
  }

  load(): Record<string, OrchestratorVerdict> {
    try {
      if (!this.bridge.exists(this.file)) return {};
      return JSON.parse(this.bridge.readTextFile(this.file)) as Record<
        string,
        OrchestratorVerdict
      >;
    } catch {
      return {};
    }
  }

  save(decisions: Record<string, OrchestratorVerdict>): void {
    const tmp = `${this.file}.${process.pid}.tmp`;
    this.bridge.writeFile(tmp, JSON.stringify(decisions));
    try {
      this.bridge.renameFile(tmp, this.file);
    } catch (error) {
      try {
        this.bridge.remove(tmp, false, true);
      } catch {
        // Best-effort temp cleanup — the original error is what matters.
      }
      throw error;
    }
  }
}

// The run's audit sink: append-only JSONL beside the decisions it explains.
// A sink failure never decides a run — the decision already happened — so it
// is swallowed here and the in-memory log still answers readers.
export class FileAuditLog {
  private readonly bridge: FileBridge;
  private readonly file: string;
  private readonly entries: RouterAuditEvent[] = [];

  constructor(dir: string) {
    this.bridge = createNodeFileBridge(dir);
    this.file = AUDIT_FILE;
  }

  append(event: RouterAuditEvent): void {
    this.entries.push(event);
    try {
      this.bridge.appendFile(this.file, `${JSON.stringify(event)}\n`);
    } catch {
      // Best-effort durability; see the class note.
    }
  }

  events(): readonly RouterAuditEvent[] {
    return [...this.entries];
  }
}

// ---------------------------------------------------------------------------
// The user's seat and the router it answers through
// ---------------------------------------------------------------------------

export type WorkerAskSeat = (
  request: OrchestratorApprovalRequest,
) => Promise<OrchestratorVerdict | undefined>;

// The user's standing answer for a run (`--yes`): the flag IS the user's own
// pre-authorization for this run, which is why the verdict is stamped
// by:'user' — never a manager grant and never a model claim.
export function createStandingAnswerSeat(): WorkerAskSeat {
  return async () => ({ approved: true, by: 'user' });
}

// The USER's seat on an interactive run: what a TTY orchestration attaches so
// a worker's challenged call is PRESENTED — the §41.2 dialog. It is the same
// primitive the shipped merge prompt uses (readline over stdio), reduced to
// one question and one yes/no. `prompt` is injectable so the contract (ask,
// parse, return) is testable without a real terminal; prod passes nothing and
// gets the readline prompt.
//
// Two properties are deliberate:
//   - the DISPLAY text is composed from the request envelope (worker, trigger,
//     justification), never from a model's own claim about what it wants;
//   - only an explicit yes approves. An empty line, a "n", EOF or an error all
//     refuse, so a mistyped Enter can never grant a dangerous capability.
export function createInteractiveSeat(
  options: { prompt?: (question: string) => Promise<string> } = {},
): WorkerAskSeat {
  const ask =
    options.prompt ??
    (async (question: string): Promise<string> => {
      const rl = createInterface({
        input: process.stdin,
        output: process.stderr,
      });
      try {
        return await new Promise<string>((resolveAnswer) => {
          rl.question(question, resolveAnswer);
        });
      } finally {
        rl.close();
      }
    });
  return async (request) => {
    const question = formatWorkerAskQuestion(request);
    let answer: string;
    try {
      answer = await ask(`${question} [y/N] `);
    } catch {
      // A prompt that cannot even be asked is not consent.
      return { approved: false, reason: 'approval prompt failed — denied' };
    }
    if (!/^y(es)?\s*$/i.test(answer.trim())) {
      return {
        approved: false,
        reason: answer.trim() === '' ? 'no answer — denied' : 'user declined',
      };
    }
    return { approved: true, by: 'user' };
  };
}

// The prod decision: does THIS run have a user to ask? A run started from a
// terminal does, and attaches the interactive seat; a headless run (CI, a
// pipe, a cron job) does not, and attaches nothing — its asks deny closed on
// the bound, which is the shipped exit-4 posture. Kept as a pure function of
// `isTTY` so the decision is testable without a terminal, and so the one place
// that decides is the same place that is asserted.
export function workerSeatForRun(
  isTTY: boolean,
  options: { prompt?: (question: string) => Promise<string> } = {},
): WorkerAskSeat | undefined {
  return isTTY ? createInteractiveSeat(options) : undefined;
}

// The question the user reads, built from the request envelope only. It names
// the worker, the capability that needs approving and the justification the
// request carries, so approving is an informed act rather than a reflex.
export function formatWorkerAskQuestion(
  request: OrchestratorApprovalRequest,
): string {
  const reason =
    request.justification === undefined || request.justification.trim() === ''
      ? 'no justification given'
      : request.justification.trim();
  return `worker '${request.agentId}' requests ${request.trigger} (${request.toolName}): ${reason} — approve?`;
}

// The worker CHILD's seat: what a spawned `kubic run` attaches so a
// challenged call it cannot answer itself reaches the user through the
// manager. It publishes the ask to the run's mailbox and waits the bounded
// time for the manager's answer; the bound expiring denies closed. This is
// the same contract `publishWorkerAsk` + `awaitWorkerAskAnswer` implement,
// wrapped in the seat shape `installSoloPolicy({ answer })` consumes.
export function createWorkerMailboxSeat(options: {
  dir: string;
  maxPendingMs: number;
  pollMs?: number;
}): (request: {
  key: string;
  capability: string;
  toolName: string;
  summary: string;
  justification?: string;
}) => Promise<OrchestratorVerdict | undefined> {
  return async (request) => {
    const published = publishWorkerAsk(options.dir, {
      trigger: request.capability,
      toolName: request.toolName,
      // The seat sees the lane's own request shape (key/capability/summary),
      // never the raw args: the ask is re-derived by the router from what the
      // lane reports, so a seat cannot smuggle args it was not given.
      args: { summary: request.summary },
      justification:
        request.justification ??
        `worker child needs ${request.capability} to complete its plan step`,
      sessionId: process.env.KUBIC_WORKER_ID ?? 'worker',
      agentId: process.env.KUBIC_WORKER_ID ?? 'worker',
      role: 'worker',
      worktree: process.cwd(),
      provenance: {
        parentSessionId:
          process.env.KUBIC_ORCHESTRATOR_SESSION ?? 'orchestrator',
      },
    });
    const outcome = await awaitWorkerAskAnswer(
      options.dir,
      published.request.key,
      {
        maxPendingMs: options.maxPendingMs,
        ...(options.pollMs === undefined ? {} : { pollMs: options.pollMs }),
      },
    );
    return outcome.approved
      ? { approved: true, by: 'user' }
      : { approved: false, reason: outcome.reason };
  };
}

export interface WorkerAskRouter {
  readonly router: OrchestratorRouter;
  ask: (
    input: WorkerAskInput,
    options?: { autoApprove?: boolean },
  ) => Promise<WorkerAskOutcome>;
  blockedIndicators: () => ManagerBlockedIndicator[];
  managerApprove: (key: string) => OrchestratorVerdict;
  decided: (key: string) => OrchestratorVerdict | undefined;
  pendingKeys: () => string[];
  audit: () => readonly RouterAuditEvent[];
}

export interface WorkerAskRouterOptions {
  /** Directory for decisions, audit and the ask mailbox. */
  dir: string;
  maxPendingMs: number;
  /** Where the user's answer comes from. Absent = no surface (denies closed). */
  seat?: WorkerAskSeat;
  /** Extra sink beside the durable audit log. */
  audit?: (event: RouterAuditEvent) => void;
}

export function createWorkerAskRouter(
  options: WorkerAskRouterOptions,
): WorkerAskRouter {
  if (!(options.maxPendingMs > 0)) {
    throw new Error('maxPendingMs must be a positive number');
  }
  // The router's dir IS the mailbox dir: decisions, audit and asks live
  // together, so "what is pending" needs no second path.
  const mailboxDir = options.dir;
  const auditLog = new FileAuditLog(options.dir);
  const audit = (event: RouterAuditEvent): void => {
    auditLog.append(event);
    options.audit?.(event);
  };
  const router = createOrchestratorRouter({
    maxPendingMs: options.maxPendingMs,
    store: new FileDecisionStore(options.dir),
    ...(options.seat === undefined ? {} : { awaitAnswer: options.seat }),
    audit,
  });
  const pendingAsks = new Map<string, OrchestratorApprovalRequest>();

  const ask = async (
    input: WorkerAskInput,
    askOptions: { autoApprove?: boolean } = {},
  ): Promise<WorkerAskOutcome> => {
    const request = buildOrchestratorRequest(
      input as unknown as OrchestratorRequestInput,
    );
    pendingAsks.set(request.key, request);
    audit({
      type: 'orchestrator-ask-raised',
      detail: `${request.key} ${request.trigger} from agent ${request.agentId}: ${request.summary}`,
    });
    try {
      const verdict =
        askOptions.autoApprove === true
          ? router.submit(request, { approved: true, by: 'user' })
          : await router.request(request);
      return classifyVerdict(request.key, verdict);
    } finally {
      pendingAsks.delete(request.key);
    }
  };

  return {
    router,
    ask,
    // The manager's whole view: a read-only projection of every ask awaiting
    // the user — the ones this process is already routing plus the ones a
    // worker published to the mailbox and has not been answered yet. It
    // carries no approval field by construction (buildManagerBlockedIndicator).
    blockedIndicators: () => {
      const byKey = new Map<string, OrchestratorApprovalRequest>();
      for (const request of router.pendingRequests()) {
        byKey.set(request.key, request);
      }
      for (const request of pendingRequestFromMailbox(mailboxDir)) {
        byKey.set(request.key, request);
      }
      return [...byKey.values()].map((request) =>
        buildManagerBlockedIndicator(request, 'pending-user'),
      );
    },
    managerApprove: (key: string) => {
      const request =
        pendingAsks.get(key) ??
        pendingRequestFromMailbox(mailboxDir).find(
          (entry) => entry.key === key,
        ) ??
        // An unknown key is still a manager approve attempt: it is refused
        // against a key-shaped envelope so the refusal is audited either way.
        ({ key } as OrchestratorApprovalRequest);
      return attemptManagerApprove(request, { audit });
    },
    decided: (key: string) => router.decided(key),
    pendingKeys: () => router.pendingRequests().map((request) => request.key),
    audit: () => auditLog.events(),
  };
}

// The router's own dir carries the mailbox it answers for.
function pendingRequestFromMailbox(dir: string): OrchestratorApprovalRequest[] {
  return readPendingWorkerAsks(dir).map((published) => published.request);
}

// ---------------------------------------------------------------------------
// Cross-process mailbox: the child publishes, the manager answers
// ---------------------------------------------------------------------------

export function askFilePath(key: string): string {
  return join(ASKS_DIR, `${key}.json`);
}

export function answerFilePath(key: string): string {
  return join(ASKS_DIR, `${key}.answer.json`);
}

// The worker child's side: publish the ask it cannot answer itself, written
// atomically (tmp+rename) so the manager never reads a torn ask.
export function publishWorkerAsk(
  dir: string,
  input: WorkerAskInput,
): PublishedWorkerAsk {
  const request = buildOrchestratorRequest(
    input as unknown as OrchestratorRequestInput,
  );
  const published: PublishedWorkerAsk = { request, args: input.args };
  const bridge = createNodeFileBridge(dir);
  const target = askFilePath(request.key);
  const tmp = `${target}.${process.pid}.tmp`;
  bridge.writeFile(tmp, JSON.stringify(published));
  bridge.renameFile(tmp, target);
  return published;
}

// The manager's side: every ask published and NOT YET ANSWERED, in key order
// (deterministic across runs). A settled ask stays on disk as evidence but is
// no longer pending — without this filter the manager would re-route an
// answered ask and ask the user twice for one operation. A torn ask is
// skipped too: it is not an ask, and the child's own bound denies it rather
// than hanging.
export function readPendingWorkerAsks(
  dir: string,
  agentId?: string,
): PublishedWorkerAsk[] {
  const bridge = createNodeFileBridge(dir);
  if (!bridge.exists(ASKS_DIR)) return [];
  const out: PublishedWorkerAsk[] = [];
  for (const entry of bridge.listDir(ASKS_DIR)) {
    if (!entry.name.endsWith('.json') || entry.name.endsWith('.answer.json')) {
      continue;
    }
    const key = entry.name.slice(0, -'.json'.length);
    if (bridge.exists(answerFilePath(key))) continue;
    let published: PublishedWorkerAsk;
    try {
      // entry.name is relative to the bridge root (the approvals dir), so the
      // ask lives under ASKS_DIR — reading the bare name would miss it and
      // silently report nothing pending.
      const raw = JSON.parse(
        bridge.readTextFile(join(ASKS_DIR, entry.name)),
      ) as PublishedWorkerAsk;
      if (
        typeof raw.request?.key !== 'string' ||
        typeof raw.request?.agentId !== 'string'
      ) {
        continue;
      }
      published = { request: raw.request, args: raw.args ?? {} };
    } catch {
      continue;
    }
    if (agentId !== undefined && published.request.agentId !== agentId) {
      continue;
    }
    out.push(published);
  }
  return out.sort((a, b) => a.request.key.localeCompare(b.request.key));
}

export function answerWorkerAsk(
  dir: string,
  key: string,
  verdict: OrchestratorVerdict,
): void {
  const bridge = createNodeFileBridge(dir);
  const target = answerFilePath(key);
  const tmp = `${target}.${process.pid}.tmp`;
  bridge.writeFile(tmp, JSON.stringify(verdict));
  bridge.renameFile(tmp, target);
}

export function readWorkerAskAnswer(
  dir: string,
  key: string,
): OrchestratorVerdict | undefined {
  const bridge = createNodeFileBridge(dir);
  try {
    if (!bridge.exists(answerFilePath(key))) return undefined;
    return JSON.parse(
      bridge.readTextFile(answerFilePath(key)),
    ) as OrchestratorVerdict;
  } catch {
    return undefined;
  }
}

// The worker child's bounded wait: poll for the manager's answer and deny
// closed with the named reason when the bound elapses. Never hangs — the
// bound is the contract, headless or not.
export async function awaitWorkerAskAnswer(
  dir: string,
  key: string,
  options: { maxPendingMs: number; pollMs?: number; clock?: () => number },
): Promise<WorkerAskOutcome> {
  const clock = options.clock ?? Date.now;
  const pollMs = options.pollMs ?? 25;
  const deadline = clock() + options.maxPendingMs;
  for (;;) {
    const answer = readWorkerAskAnswer(dir, key);
    if (answer !== undefined) return classifyVerdict(key, answer);
    if (clock() >= deadline) {
      return {
        approved: false,
        key,
        code: APPROVAL_TIMEOUT_CODE,
        reason: `approval ${TIMEOUT_REASON_MARKER} after ${options.maxPendingMs}ms with no user presentation — denied`,
      };
    }
    // NOT unref'd on purpose: the wait IS live work. A child whose only
    // pending task is waiting for its answer must stay alive until the bound
    // elapses; an unref'd timer lets node drain the loop and exit with an
    // unsettled top-level await (13) — a silent exit instead of the named
    // denial this bound promises.
    await new Promise<void>((resolve) => {
      setTimeout(resolve, pollMs);
    });
  }
}

// ---------------------------------------------------------------------------
// Opt-in budgets (§71): absent enforces nothing, configured blocks
// ---------------------------------------------------------------------------

export interface WorkerBudgetPlan {
  /** The validated budget in force; undefined = none configured. */
  budget: OrchestratorBudget | undefined;
  describe: () => string;
}

// Per-spawn budget resolution: absent input is the default and enforces
// NOTHING — budgets are opt-in per spawn, never defaults.
export function budgetForSpawn(configured: unknown): WorkerBudgetPlan {
  if (configured === undefined || configured === null) {
    return {
      budget: undefined,
      describe: () => 'no budget configured for this spawn (opt-in only)',
    };
  }
  const budget = validateOrchestratorBudget(configured);
  const dims = Object.keys(budget);
  return {
    budget,
    describe: () =>
      `budget for this spawn: ${dims.length === 0 ? 'empty (enforces nothing)' : dims.join(', ')}`,
  };
}

// ---------------------------------------------------------------------------
// The run-level seam the CLI and the composition root drive
// ---------------------------------------------------------------------------

export interface WorkerApprovalScope {
  sessionId: string;
  agentId: string;
  worktree: string;
  role?: string;
}

// The named terminus a worker's approval/budget outcome maps to on the run.
export interface WorkerApprovalTermination {
  agentId: string;
  key?: string;
  code: string;
  exitCode: number;
  message: string;
}

export interface WorkerApprovalsRun {
  beginWorker: (scope: WorkerApprovalScope) => void;
  /**
   * Route every ask this worker published and that is still unanswered to the
   * user, answer the worker, and report the first terminal outcome. Prod
   * calls it on a bounded interval while the worker runs and once more after
   * it settles (the race between the last ask and the child's exit).
   */
  pump: (
    scope: WorkerApprovalScope,
  ) => Promise<WorkerApprovalTermination | undefined>;
  /**
   * The first terminal outcome this worker produced DURING its run (recorded
   * by the interval pump, because the caller cannot await that call), taken
   * and cleared. Absent means the worker settled nothing terminal.
   */
  takeTermination: (agentId: string) => WorkerApprovalTermination | undefined;
  endWorker: (agentId: string) => void;
  /** The mailbox directory the spawned child must be told about. */
  mailboxDir: () => string;
  blockedIndicators: () => ManagerBlockedIndicator[];
  managerApprove: (key: string) => OrchestratorVerdict;
  /** A worker proposing a larger budget is refused (§71) — never applied. */
  requestBudgetRaise: (input: { agentId: string; proposed: unknown }) => {
    applied: false;
    reason: string;
  };
  /** Opt-in budget in force for this run; undefined = none. */
  budget: () => OrchestratorBudget | undefined;
  /**
   * The budget gate actually in force for ONE spawn — the per-agent override
   * when `--budget <agent>:<dims>` named it, otherwise the shared spec.
   * undefined means this spawn is unbudgeted. Reading it is the only way to
   * tell an override apart from a shared limit (both block with the same
   * code), and it is read-only: budgets are configured before the spawn.
   */
  budgetFor: (agentId: string) => OrchestratorBudget | undefined;
  /** The live session-scoped full-access grant, if the user opted in. */
  fullAccessGrant: () => SessionSkipRecord | undefined;
  audit: () => readonly RouterAuditEvent[];
  decisions: WorkerAskRouter;
}

export interface WorkerApprovalsRunOptions {
  /** Directory for approvals state — <repo>/.kubic/orchestrator. */
  dir: string;
  sessionId: string;
  maxPendingMs: number;
  /** `--yes`: the user's standing answer for this run. */
  autoApprove?: boolean;
  /** The user's seat when a surface exists (TTY); absent denies on the bound. */
  seat?: WorkerAskSeat;
  /** Opt-in budget, applied to every spawn; undefined enforces nothing. */
  budget?: unknown;
  /**
   * Per-spawn budget override. The CLI owns `--budget <agent>:<dims>`; this
   * hook lets it hand the run the spec for ONE worker without the run needing
   * to know the flag grammar. Absent means the shared `budget` applies.
   */
  budgetForAgent?: (agentId: string) => unknown;
  /** User opt-in full-access posture for THIS session (§41.4). */
  fullAccess?: boolean;
  /** Poll cadence used by beginWorker's interval. */
  pollMs?: number;
  debug?: (line: string) => void;
  audit?: (event: RouterAuditEvent) => void;
}

// One approvals run: the router, the mailbox pump, the per-spawn budget gates
// and the session-scoped full-access posture. Construction is where the four
// modules stop being dead — request/routing/budgets/skip are each consulted
// from a live path.
export function createOrchestratorApprovalsRun(
  options: WorkerApprovalsRunOptions,
): WorkerApprovalsRun {
  const dir = join(options.dir, APPROVALS_DIR);
  const bridge = createNodeFileBridge(dir);
  bridge.createDir(ASKS_DIR, true);
  const debug = options.debug ?? (() => undefined);
  // ONE audit log for the whole run: the router's decisions, this module's
  // refusals (budget self-raise) and the skip posture all land in the same
  // durable trail. A refusal written to a throwaway sink would be an audit
  // record nobody can read — which is not an audit record.
  const auditLog = new FileAuditLog(dir);
  const audit = (event: RouterAuditEvent): void => {
    auditLog.append(event);
    options.audit?.(event);
  };
  const decisions = createWorkerAskRouter({
    dir,
    maxPendingMs: options.maxPendingMs,
    ...(options.autoApprove === true
      ? { seat: createStandingAnswerSeat() }
      : options.seat === undefined
        ? {}
        : { seat: options.seat }),
    audit,
  });
  // Session-scoped full access (§41.4): the grant is keyed by sessionId, lives
  // beside the run's other approvals state, is indicated on the surface, and
  // is recorded for audit/doctor. A fresh session starts enforced; nothing
  // here can make the posture global. Only by:'user' carries authority —
  // enableSessionSkip refuses anything else.
  let skipRecords = loadSkipRecords(bridge);
  if (options.fullAccess === true) {
    const record = enableSessionSkip(
      { sessionId: options.sessionId },
      { by: 'user' },
    );
    skipRecords = [
      ...skipRecords.filter((entry) => entry.sessionId !== options.sessionId),
      record,
    ];
    saveSkipRecords(bridge, skipRecords);
    debug(formatSessionSkipIndicator(record));
    const event = buildSessionSkipAuditEvent(record, 'enabled');
    audit({
      type: event.type,
      detail: `full-access enabled for session ${event.sessionId} (scope ${event.scope}, by ${event.enabledBy ?? 'user'})`,
    });
  }
  const fullAccessLive = (): SessionSkipRecord | undefined =>
    skipRecords.find(
      (record) =>
        record.sessionId === options.sessionId &&
        isSessionSkipEnabled({ sessionId: options.sessionId }, [record]),
    );
  const sharedPlan = budgetForSpawn(options.budget);
  debug(sharedPlan.describe());
  // Per-spawn budgets (§71): a per-agent spec REPLACES the shared one for that
  // worker — it can never widen it (a raise needs the user, see refuseRaise).
  const plans = new Map<string, WorkerBudgetPlan>();
  const planFor = (agentId: string): WorkerBudgetPlan => {
    const existing = plans.get(agentId);
    if (existing !== undefined) return existing;
    const configured = options.budgetForAgent?.(agentId);
    const plan =
      configured === undefined ? sharedPlan : budgetForSpawn(configured);
    plans.set(agentId, plan);
    if (plan !== sharedPlan) debug(`${agentId}: ${plan.describe()}`);
    return plan;
  };
  const gates = new Map<string, BudgetGate>();
  const gateFor = (agentId: string): BudgetGate | undefined => {
    const plan = planFor(agentId);
    if (plan.budget === undefined) return undefined;
    const existing = gates.get(agentId);
    if (existing !== undefined) return existing;
    const gate = createBudgetGate(plan.budget);
    gates.set(agentId, gate);
    return gate;
  };
  const intervals = new Map<string, ReturnType<typeof setInterval>>();
  const terminations = new Map<string, WorkerApprovalTermination>();

  const refuseRaise = (
    agentId: string,
    proposed: unknown,
  ): { applied: false; reason: string } => {
    const refusal = applyBudgetRaise({
      approver: agentId,
      owner: agentId,
      current: planFor(agentId).budget ?? {},
      proposed: (proposed ?? {}) as OrchestratorBudget,
    });
    if (refusal.applied) {
      // Unreachable by construction: a bare worker id is never a lawful
      // approver (only a user-minted grant is). Guarded so an applied raise
      // could never slip through this path silently.
      const reason = `self-raise refused: agent ${agentId} cannot raise its own budget — above-task needs user approval`;
      audit({ type: 'budget-self-raise-refused', detail: reason });
      return { applied: false, reason };
    }
    audit({ type: 'budget-self-raise-refused', detail: refusal.reason });
    debug(`budget: ${refusal.reason}`);
    return { applied: false, reason: refusal.reason };
  };

  const answerOne = async (
    published: PublishedWorkerAsk,
    scope: WorkerApprovalScope,
  ): Promise<WorkerApprovalTermination | undefined> => {
    const { request, args } = published;
    // §71: a worker proposing to raise its own budget is refused, never
    // applied — and answered immediately so its bounded wait cannot hang.
    const proposed = args.budgetRaise;
    if (typeof proposed === 'object' && proposed !== null) {
      const refusal = refuseRaise(scope.agentId, proposed);
      answerWorkerAsk(dir, request.key, {
        approved: false,
        reason: refusal.reason,
      });
      return {
        agentId: scope.agentId,
        key: request.key,
        code: APPROVAL_DENIED_CODE,
        exitCode: 4,
        message: `budget raise refused for worker '${scope.agentId}': ${refusal.reason}`,
      };
    }
    // The budget gate is consulted BEFORE the user is prompted: a worker that
    // already exhausted a configured budget never costs the user a dialog.
    const gate = gateFor(scope.agentId);
    if (gate !== undefined) {
      const hit = gate({ toolCallId: request.key, toolName: request.toolName });
      if (hit !== undefined) {
        answerWorkerAsk(dir, request.key, {
          approved: false,
          reason: hit.block.reason,
        });
        return {
          agentId: scope.agentId,
          key: request.key,
          code: BUDGET_EXHAUSTED,
          exitCode: RUN_EXIT_BUDGET,
          message: hit.block.reason,
        };
      }
    }
    const live = fullAccessLive();
    let outcome: WorkerAskOutcome;
    if (live !== undefined) {
      // Full access for THIS session only: indicated, recorded, never quiet.
      debug(formatSessionSkipIndicator(live));
      outcome = await decisions.ask(inputFromRequest(published, scope), {
        autoApprove: true,
      });
    } else {
      outcome = await decisions.ask(inputFromRequest(published, scope));
    }
    // The answer is durable and travels back to the worker, whose own bounded
    // wait would otherwise deny on the bound.
    answerWorkerAsk(
      dir,
      request.key,
      outcome.approved
        ? { approved: true, by: 'user' }
        : { approved: false, reason: outcome.reason },
    );
    if (outcome.approved && gate !== undefined) {
      // The delegation path's observable spend: one brokered dangerous call.
      // Token/cost/runtime spend lives in the CHILD's ledger and is not
      // visible here — it is not invented; maxToolCalls is the live dimension.
      recordToolCall(gate, {});
    }
    if (outcome.approved) return undefined;
    return {
      agentId: scope.agentId,
      key: request.key,
      code: outcome.code,
      exitCode: 4,
      message: `approval denied for worker '${scope.agentId}' (${request.trigger}): ${outcome.reason}`,
    };
  };

  // Keys currently being routed by this run. The interval pump and the
  // settle-time pump can overlap (the interval cannot be awaited), and an
  // overlapping pass would count one ask's spend twice; the guard makes the
  // routing of a key single-writer within the run. The router's own inflight
  // memo already collapses the duplicate PROMPT, so this only protects the
  // bookkeeping around it.
  const routing = new Set<string>();
  const pump = async (
    scope: WorkerApprovalScope,
  ): Promise<WorkerApprovalTermination | undefined> => {
    for (const published of readPendingWorkerAsks(dir, scope.agentId)) {
      const key = published.request.key;
      if (routing.has(key)) continue;
      routing.add(key);
      try {
        const termination = await answerOne(published, scope);
        if (termination !== undefined) return termination;
      } finally {
        routing.delete(key);
      }
    }
    return undefined;
  };

  return {
    beginWorker: (scope) => {
      if (intervals.has(scope.agentId)) return;
      const timer = setInterval(() => {
        void pump(scope)
          .then((termination) => {
            // The interval's outcome cannot be awaited by the caller, so it is
            // recorded here and taken after the child settles. FIRST terminal
            // outcome wins: a later ask in the same worker cannot overwrite
            // the code that ended it.
            if (termination !== undefined && !terminations.has(scope.agentId)) {
              terminations.set(scope.agentId, termination);
            }
          })
          .catch((error: unknown) => {
            debug(
              `approvals: pump failed for '${scope.agentId}': ${error instanceof Error ? error.message : String(error)}`,
            );
          });
      }, options.pollMs ?? 100);
      timer.unref?.();
      intervals.set(scope.agentId, timer);
    },
    pump,
    takeTermination: (agentId) => {
      const termination = terminations.get(agentId);
      terminations.delete(agentId);
      return termination;
    },
    endWorker: (agentId) => {
      const timer = intervals.get(agentId);
      if (timer !== undefined) {
        clearInterval(timer);
        intervals.delete(agentId);
      }
    },
    mailboxDir: () => dir,
    blockedIndicators: () => decisions.blockedIndicators(),
    managerApprove: (key) => decisions.managerApprove(key),
    requestBudgetRaise: (input) => refuseRaise(input.agentId, input.proposed),
    budget: () => sharedPlan.budget,
    budgetFor: (agentId) => planFor(agentId).budget,
    fullAccessGrant: () => fullAccessLive(),
    audit: () => auditLog.events(),
    decisions,
  };
}

// The ask the router decides is the envelope the CHILD published, rebuilt
// field-for-field from that envelope (identity and justification included) so
// the key recomputed here is the key the child is waiting on. Rebinding the
// identity from the manager's own scope would settle a DIFFERENT key: the
// child would time out on its own bound while the user's answer sat under a
// key nobody reads, and the unanswered ask would be re-routed forever.
function inputFromRequest(
  published: PublishedWorkerAsk,
  scope: WorkerApprovalScope,
): WorkerAskInput {
  const { request, args } = published;
  return {
    trigger: request.trigger,
    toolName: request.toolName,
    args,
    justification: request.justification,
    sessionId: request.sessionId,
    agentId: request.agentId,
    role: request.role || scope.role || 'worker',
    worktree: request.worktree,
    provenance: request.provenance,
  };
}

function loadSkipRecords(bridge: FileBridge): SessionSkipRecord[] {
  try {
    if (!bridge.exists(SKIP_RECORDS_FILE)) return [];
    return JSON.parse(
      bridge.readTextFile(SKIP_RECORDS_FILE),
    ) as SessionSkipRecord[];
  } catch {
    return [];
  }
}

function saveSkipRecords(
  bridge: FileBridge,
  records: readonly SessionSkipRecord[],
): void {
  const tmp = `${SKIP_RECORDS_FILE}.${process.pid}.tmp`;
  bridge.writeFile(tmp, JSON.stringify(records));
  bridge.renameFile(tmp, SKIP_RECORDS_FILE);
}
