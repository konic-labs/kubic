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

import { createHash, randomBytes } from 'node:crypto';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join } from 'node:path';
import { createInterface } from 'node:readline';
import type { FileBridge } from '../../../../exec/src/file-bridge.js';
import { createNodeFileBridge } from '../../../../exec/src/file-bridge.js';
import {
  appendToLedger,
  droppedStateAudit,
  orchestratorDecisionAudit,
} from '../../policy/audit-ledger.js';
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
  type DecisionLoad,
  type DecisionStore,
  type ManagerBlockedIndicator,
  type OrchestratorRouter,
  type OrchestratorVerdict,
  type RouterAuditEvent,
} from './routing.js';
import {
  type ApprovalSigner,
  createApprovalSigner,
  type SealedValue,
  verifySealed,
} from './seal.js';
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
// recognize a proposed budget raise (§71), plus the ask's OWN nonce.
export interface PublishedWorkerAsk {
  request: OrchestratorApprovalRequest;
  args: Record<string, unknown>;
  /**
   * Minted by the asker (issue #149): the manager echoes it inside the sealed
   * answer and the asker checks it, so an answer is bound to THIS ask. A file
   * left behind for an earlier ask of the same key names a different nonce and
   * is refused as stale instead of settling the new ask.
   */
  nonce: string;
}

// The ask's own nonce: random per publication, never derived from the args
// (two identical asks must not share one).
function newAskNonce(): string {
  return randomBytes(16).toString('hex');
}

// ---------------------------------------------------------------------------
// Durable decisions + audit, under <repo>/.kubic/orchestrator/approvals/
// ---------------------------------------------------------------------------

export const APPROVALS_DIR = 'approvals';
// §60 posture values on ledger records.
export const POSTURE_APPROVALS = 'approvals';
export const POSTURE_FULL_ACCESS = 'full-access';
export const DECISIONS_FILE = 'decisions.json';
// The §60 ledger file (policy/audit-ledger.ts) in this approvals dir.
export { AUDIT_LEDGER_FILE as AUDIT_FILE } from '../../policy/audit-ledger.js';
export const ASKS_DIR = 'asks';
export const SKIP_RECORDS_FILE = 'skip-records.json';

// Durable decision store (§41.2 memoOnce across restarts). Load is
// corrupt-tolerant (a torn write reads as no decisions — fail closed toward
// re-asking); saves are atomic tmp+rename so a kill cannot leave a
// half-written decision file a later run would misread.
//
// Every entry is SEALED with the run's signer (issue #149): this is the file a
// worker would plant a `{approved:true,by:'user'}` into, so an entry the
// current manager did not sign loads as a DROP (reported to the router, which
// audits it) rather than as a decision.
export class FileDecisionStore implements DecisionStore {
  private readonly bridge: FileBridge;
  private readonly file: string;
  private readonly signer: ApprovalSigner;

  constructor(dir: string, signer: ApprovalSigner) {
    this.bridge = createNodeFileBridge(dir);
    this.file = DECISIONS_FILE;
    this.signer = signer;
  }

  load(): DecisionLoad {
    const decisions: Record<string, OrchestratorVerdict> = {};
    const dropped: Array<{ key: string; reason: string }> = [];
    let raw: Record<string, unknown>;
    try {
      if (!this.bridge.exists(this.file)) return { decisions, dropped };
      raw = JSON.parse(this.bridge.readTextFile(this.file)) as Record<
        string,
        unknown
      >;
    } catch {
      // A torn or unreadable file reads as no decisions: fail closed toward
      // re-asking.
      return { decisions: {}, dropped };
    }
    for (const [key, value] of Object.entries(raw)) {
      const sealed = verifySealed<OrchestratorVerdict>(
        this.signer.verifyKey,
        value,
      );
      if (sealed === undefined) {
        dropped.push({
          key,
          reason:
            'unauthenticated decision (no MAC from this run\u2019s manager)',
        });
        continue;
      }
      decisions[key] = sealed.payload;
    }
    return { decisions, dropped };
  }

  save(decisions: Record<string, OrchestratorVerdict>): void {
    const sealed: Record<string, SealedValue<OrchestratorVerdict>> = {};
    for (const [key, verdict] of Object.entries(decisions)) {
      sealed[key] = this.signer.seal(verdict);
    }
    const tmp = `${this.file}.${process.pid}.tmp`;
    this.bridge.writeFile(tmp, JSON.stringify(sealed));
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

// The run's in-process router trace (typed events for the live surfaces and
// tests). It is NOT the durable audit: decisions are persisted as §60
// OrgAuditRecords in the repo ledger (policy/audit-ledger.ts).
export class RouterAuditTrace {
  private readonly entries: RouterAuditEvent[] = [];

  append(event: RouterAuditEvent): void {
    // In-process trace only. The durable trail is the §60 ledger
    // (policy/audit-ledger.ts): decisions land there as OrgAuditRecords, so
    // the file holds ONE record format that `kubic audit` reads back.
    this.entries.push(event);
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
  // Issue #316: the full command, on its own lines, so a padded prefix
  // cannot hide the tail the approval actually covers.
  const head = `worker '${request.agentId}' requests ${request.trigger} (${request.toolName}): ${reason}`;
  if (request.command === undefined) return `${head} — approve?`;
  const command = request.command.split('\n').join('\n           ');
  return `${head}\n  command: ${command}\napprove?`;
}

// The worker child's identity as its manager set it (issue #159; §23): the
// worker's OWN session (`<orch>-<agent>`) travels in KUBIC_WORKER_SESSION, its
// id in KUBIC_WORKER_ID, and the run that spawned it in
// KUBIC_ORCHESTRATOR_SESSION — the two session ids were the SAME value before
// this issue, which is what made the ledger unattributable. A process without
// the session var is not an orchestrated child that knows one, so its own id
// is the best label it has.
export function workerAskIdentity(
  env: Readonly<Record<string, string | undefined>> = process.env,
): { sessionId: string; agentId: string; parentSessionId: string } {
  const agentId = env.KUBIC_WORKER_ID ?? 'worker';
  return {
    sessionId: env.KUBIC_WORKER_SESSION ?? agentId,
    agentId,
    parentSessionId: env.KUBIC_ORCHESTRATOR_SESSION ?? 'orchestrator',
  };
}

// The worker CHILD's seat: what a spawned `kubic run` attaches so a
// challenged call it cannot answer itself reaches the user through the
// manager. It publishes the ask to the run's mailbox and waits the bounded
// time for the manager's answer; the bound expiring denies closed. This is
// the same contract `publishWorkerAsk` + `awaitWorkerAskAnswer` implement,
// wrapped in the seat shape `installSoloPolicy({ answer })` consumes.
//
// `verifyKey` is the manager's public verification key (issue #149): without
// the matching MAC the answer is bytes, not a verdict. `onRefused` names a
// refused answer on the child's own surface, so a forgery attempt is
// observable rather than a silent denial. `role` is the §12 role this worker
// was booted as (`--role`), recorded on the ask so `kubic audit` can tell who
// asked (issue #159); absent means the shipped default label, `worker`.
export function createWorkerMailboxSeat(options: {
  dir: string;
  maxPendingMs: number;
  verifyKey: string;
  role?: string;
  pollMs?: number;
  onRefused?: (detail: string) => void;
}): (
  request: {
    key: string;
    capability: string;
    toolName: string;
    summary: string;
    command?: string;
    justification?: string;
  },
  // Issue #232: the service's AbortSignal. When the bound that denies the call
  // expires, the seat stops polling and withdraws the ask it published.
  signal?: AbortSignal,
) => Promise<OrchestratorVerdict | undefined> {
  return async (request, signal) => {
    const identity = workerAskIdentity();
    const published = publishWorkerAsk(options.dir, {
      trigger: request.capability,
      toolName: request.toolName,
      // The seat sees the lane's own request shape (key/capability/summary/
      // command), never the raw args: the ask is re-derived by the router
      // from what the lane reports, so a seat cannot smuggle args it was not
      // given. Issue #316: a bash call forwards its FULL command, so the
      // manager's seat shows what will run instead of a cut summary.
      args:
        request.command === undefined
          ? { summary: request.summary }
          : { command: request.command },
      justification:
        request.justification ??
        `worker child needs ${request.capability} to complete its plan step`,
      sessionId: identity.sessionId,
      agentId: identity.agentId,
      role: options.role ?? 'worker',
      worktree: process.cwd(),
      provenance: { parentSessionId: identity.parentSessionId },
    });
    const outcome = await awaitWorkerAskAnswer(
      options.dir,
      published.request.key,
      {
        maxPendingMs: options.maxPendingMs,
        verifyKey: options.verifyKey,
        nonce: published.nonce,
        ...(options.pollMs === undefined ? {} : { pollMs: options.pollMs }),
        ...(options.onRefused === undefined
          ? {}
          : { onRefused: options.onRefused }),
        ...(signal === undefined ? {} : { signal }),
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
  /**
   * The public key this manager's sealed answers and decisions carry — what a
   * worker child must be launched with (issue #149). Safe to hand out.
   */
  verifyKey: () => string;
  /** Seal and write this manager's answer for one published ask. */
  answer: (published: PublishedWorkerAsk, verdict: OrchestratorVerdict) => void;
}

export interface WorkerAskRouterOptions {
  /** Directory for decisions, audit and the ask mailbox. */
  dir: string;
  /**
   * Where the §60 ledger records land, when that differs from `dir`
   * (issue #279): the approvals run keeps its mailbox and decisions per
   * session but the repo's ledger in ONE place. Absent means `dir`.
   */
  ledgerDir?: string;
  maxPendingMs: number;
  /** Where the user's answer comes from. Absent = no surface (denies closed). */
  seat?: WorkerAskSeat;
  /** Extra sink beside the durable audit log. */
  audit?: (event: RouterAuditEvent) => void;
  /** §60 posture stamped on ledger records (default: approvals enabled). */
  posture?: () => string;
  /** Where a failed ledger append is reported (never decides the ask). */
  debug?: (line: string) => void;
  /**
   * The run's signing authority (issue #149). Absent mints a fresh one for
   * this router — which is exactly why state another process sealed is never
   * trusted.
   */
  signer?: ApprovalSigner;
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
  // ONE signing authority per router (issue #149): it seals this manager's
  // decisions and answers, and its public key is what the children verify with.
  const signer = options.signer ?? createApprovalSigner();
  const auditLog = new RouterAuditTrace();
  const audit = (event: RouterAuditEvent): void => {
    auditLog.append(event);
    options.audit?.(event);
  };
  // A refused answer or a tampered ask is reported ONCE per distinct reason:
  // the pending read runs on every pump, and a forged file must not turn into
  // an unbounded audit stream.
  const noteRefused = refusalNote(audit, (line) => options.debug?.(line));
  const mailbox = (agentId?: string): PublishedWorkerAsk[] =>
    readPendingWorkerAsks(mailboxDir, {
      verifyKey: signer.verifyKey,
      onRefused: noteRefused,
      ...(agentId === undefined ? {} : { agentId }),
    });
  const router = createOrchestratorRouter({
    maxPendingMs: options.maxPendingMs,
    store: new FileDecisionStore(options.dir, signer),
    ...(options.seat === undefined ? {} : { awaitAnswer: options.seat }),
    audit,
  });
  const pendingAsks = new Map<string, OrchestratorApprovalRequest>();
  // §60: every decision (approve, deny, timeout, manager refusal) becomes
  // one OrgAuditRecord in the repo ledger beside the decisions it explains.
  const ledger = (
    request: OrchestratorApprovalRequest,
    verdict: OrchestratorVerdict,
  ): void => {
    appendToLedger(
      options.ledgerDir ?? mailboxDir,
      orchestratorDecisionAudit(request, verdict, {
        posture: options.posture?.() ?? POSTURE_APPROVALS,
      }),
      (message) => options.debug?.(`audit: ledger append failed: ${message}`),
    );
  };

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
      ledger(request, verdict);
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
      for (const entry of mailbox()) {
        byKey.set(entry.request.key, entry.request);
      }
      return [...byKey.values()].map((request) =>
        buildManagerBlockedIndicator(request, 'pending-user'),
      );
    },
    managerApprove: (key: string) => {
      const request =
        pendingAsks.get(key) ??
        mailbox().find((entry) => entry.request.key === key)?.request ??
        // An unknown key is still a manager approve attempt: it is refused
        // against a key-shaped envelope so the refusal is audited either way.
        ({ key } as OrchestratorApprovalRequest);
      const verdict = attemptManagerApprove(request, { audit });
      ledger(request, verdict);
      return verdict;
    },
    decided: (key: string) => router.decided(key),
    pendingKeys: () => router.pendingRequests().map((request) => request.key),
    audit: () => auditLog.events(),
    verifyKey: () => signer.verifyKey,
    answer: (published, verdict) => {
      // Issue #232 (review): the asker may have WITHDRAWN the ask while the
      // user was deciding (its own bound expired and its seat removed the ask
      // files). The decision still stands and is memoized — but writing an
      // answer for a question nobody is waiting on would leave an orphan file
      // behind, so it is skipped and named on the debug channel instead.
      if (!askStillPublished(mailboxDir, published.request.key)) {
        options.debug?.(
          `approvals: answer for ${published.request.key} not written — the asker withdrew the ask`,
        );
        return;
      }
      answerWorkerAsk(mailboxDir, published, verdict, signer);
    },
  };
}

// Whether the ask is still on disk: the withdrawal of issue #232 removes both
// the ask and its answer, so a missing ask file means the question is gone.
function askStillPublished(dir: string, key: string): boolean {
  try {
    return createNodeFileBridge(dir).exists(askFilePath(key));
  } catch {
    // An unreadable mailbox is not an answer surface: fail closed, no write.
    return false;
  }
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

// Removes one ask's files — the ask and its answer, if any (issue #232). Used
// when the question is WITHDRAWN (the asker's bound expired, or its caller
// aborted): nobody will read an answer, and the manager must not route a
// question whose asker is gone. The §60 ledger keeps the durable record.
export function removeAskFiles(dir: string, key: string): void {
  const bridge = createNodeFileBridge(dir);
  bridge.remove(askFilePath(key), false, true);
  bridge.remove(answerFilePath(key), false, true);
}

// Removes the mailbox files of ONE settled worker (issue #152): its ask and
// its answer, together, so a finished worker's files cannot accumulate in a
// long run's mailbox. An ask that was never answered goes too — the worker it
// belonged to is gone, so nobody can consume it — while a sibling's files stay
// (they are still live). A torn ask cannot be attributed to a worker and is
// left for the run's own mailbox retirement; the §60 ledger is the durable
// record of every decision, so nothing auditable lives only here.
export function sweepWorkerAsks(dir: string, agentId: string): number {
  const bridge = createNodeFileBridge(dir);
  if (!bridge.exists(ASKS_DIR)) return 0;
  let removed = 0;
  for (const entry of bridge.listDir(ASKS_DIR)) {
    if (!entry.name.endsWith('.json') || entry.name.endsWith('.answer.json')) {
      continue;
    }
    const key = entry.name.slice(0, -'.json'.length);
    let owner: unknown;
    try {
      owner = (
        JSON.parse(
          bridge.readTextFile(join(ASKS_DIR, entry.name)),
        ) as Partial<PublishedWorkerAsk>
      ).request?.agentId;
    } catch {
      continue;
    }
    if (owner !== agentId) continue;
    bridge.remove(join(ASKS_DIR, entry.name), false, true);
    bridge.remove(answerFilePath(key), false, true);
    removed += 1;
  }
  return removed;
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
  const published: PublishedWorkerAsk = {
    request,
    args: input.args,
    nonce: newAskNonce(),
  };
  const bridge = createNodeFileBridge(dir);
  const target = askFilePath(request.key);
  const tmp = `${target}.${process.pid}.tmp`;
  bridge.writeFile(tmp, JSON.stringify(published));
  bridge.renameFile(tmp, target);
  return published;
}

// The key an ask's OWN content produces. The manager answers by the DECLARED
// key, so an ask that declares a key its fields do not produce would hand the
// user's verdict for one operation to another (issue #149).
export function recomputedAskKey(published: PublishedWorkerAsk): string {
  const { request, args } = published;
  return orchestratorRequestKey(
    request.toolName,
    request.trigger,
    args,
    request.worktree,
    {
      sessionId: request.sessionId,
      agentId: request.agentId,
      justification: request.justification,
    },
  );
}

// The manager's side: every ask published and NOT YET ANSWERED BY THIS RUN,
// in key order (deterministic across runs). A settled ask stays on disk as
// evidence but is no longer pending — without this filter the manager would
// re-route an answered ask and ask the user twice for one operation. Three
// things never count as an answer (issue #149), and each is reported rather
// than silently absorbed:
//
//   - an answer with no MAC from this run's signer (the forgery this issue is
//     about), or one sealed for another ask's nonce (stale);
//   - an ask whose declared key its own content does not produce — routing it
//     would answer the operation the fields describe under the key the worker
//     is actually waiting on;
//   - a torn ask, which is not an ask at all (the child's own bound denies it
//     rather than hanging).
// A refused answer leaves the ask PENDING on purpose: a planted file must not
// be able to deny a worker's call either.
export function readPendingWorkerAsks(
  dir: string,
  options: {
    verifyKey: string;
    agentId?: string;
    onRefused?: (detail: string) => void;
  },
): PublishedWorkerAsk[] {
  const bridge = createNodeFileBridge(dir);
  if (!bridge.exists(ASKS_DIR)) return [];
  const out: PublishedWorkerAsk[] = [];
  for (const entry of bridge.listDir(ASKS_DIR)) {
    if (!entry.name.endsWith('.json') || entry.name.endsWith('.answer.json')) {
      continue;
    }
    const key = entry.name.slice(0, -'.json'.length);
    let published: PublishedWorkerAsk;
    try {
      // entry.name is relative to the bridge root (the approvals dir), so the
      // ask lives under ASKS_DIR — reading the bare name would miss it and
      // silently report nothing pending.
      const raw = JSON.parse(
        bridge.readTextFile(join(ASKS_DIR, entry.name)),
      ) as Partial<PublishedWorkerAsk>;
      if (
        typeof raw.request?.key !== 'string' ||
        typeof raw.request?.agentId !== 'string'
      ) {
        continue;
      }
      if (typeof raw.nonce !== 'string' || raw.nonce === '') {
        options.onRefused?.(
          `ask ${key} refused: no nonce, so no answer can be bound to it`,
        );
        continue;
      }
      published = {
        request: raw.request,
        args: raw.args ?? {},
        nonce: raw.nonce,
      };
    } catch {
      continue;
    }
    if (recomputedAskKey(published) !== published.request.key) {
      options.onRefused?.(
        `ask ${published.request.key} refused: its declared key does not match its own content`,
      );
      continue;
    }
    const answer = readWorkerAskAnswer(dir, published.request.key, {
      verifyKey: options.verifyKey,
      nonce: published.nonce,
    });
    if (answer.state === 'verified') continue;
    if (
      options.agentId !== undefined &&
      published.request.agentId !== options.agentId
    ) {
      // Another worker's ask: not this pump's business to report (#149 review
      // finding 2) — its own run's pump reports it.
      continue;
    }
    if (answer.state === 'refused') options.onRefused?.(answer.detail);
    out.push(published);
  }
  return out.sort((a, b) => a.request.key.localeCompare(b.request.key));
}

// The manager's answer: the verdict SEALED together with the ask's key and
// nonce, written atomically (tmp+rename) so the child never reads a torn
// answer. `signer` is the run's authority — the only thing that can produce an
// answer a child will accept.
export function answerWorkerAsk(
  dir: string,
  published: { request: { key: string }; nonce: string },
  verdict: OrchestratorVerdict,
  signer: ApprovalSigner,
): void {
  const bridge = createNodeFileBridge(dir);
  const key = published.request.key;
  const target = answerFilePath(key);
  const sealed = signer.seal<WorkerAskAnswerPayload>({
    key,
    nonce: published.nonce,
    verdict,
  });
  const tmp = `${target}.${process.pid}.tmp`;
  bridge.writeFile(tmp, JSON.stringify(sealed));
  bridge.renameFile(tmp, target);
}

// What a sealed answer binds: WHICH ask (key) of WHICH publication (nonce) was
// decided, and how. The manager writes it; the child checks every field.
export interface WorkerAskAnswerPayload {
  key: string;
  nonce: string;
  verdict: OrchestratorVerdict;
}

export interface WorkerAskAnswerExpectation {
  verifyKey: string;
  nonce: string;
}

export type WorkerAskAnswerRead =
  | { state: 'missing' }
  | { state: 'verified'; verdict: OrchestratorVerdict }
  | { state: 'refused'; detail: string };

// Only the user approves (§41.2), and the manager seals only what the router
// settled — a seal naming any other decider is refused here too, so a bug in
// one path cannot become a grant.
function isVerdict(value: unknown): value is OrchestratorVerdict {
  if (typeof value !== 'object' || value === null) return false;
  const verdict = value as {
    approved?: unknown;
    by?: unknown;
    reason?: unknown;
  };
  if (verdict.approved === true) return verdict.by === 'user';
  if (verdict.approved === false) return typeof verdict.reason === 'string';
  return false;
}

export function readWorkerAskAnswer(
  dir: string,
  key: string,
  expected: WorkerAskAnswerExpectation,
): WorkerAskAnswerRead {
  const bridge = createNodeFileBridge(dir);
  let raw: unknown;
  try {
    if (!bridge.exists(answerFilePath(key))) return { state: 'missing' };
    raw = JSON.parse(bridge.readTextFile(answerFilePath(key)));
  } catch {
    return {
      state: 'refused',
      detail: `answer for ${key} refused: unreadable`,
    };
  }
  const sealed = verifySealed<WorkerAskAnswerPayload>(expected.verifyKey, raw);
  if (sealed === undefined) {
    return {
      state: 'refused',
      detail: `answer for ${key} refused: no MAC from this run's manager`,
    };
  }
  const payload = sealed.payload;
  if (typeof payload !== 'object' || payload === null) {
    return {
      state: 'refused',
      detail: `answer for ${key} refused: malformed payload`,
    };
  }
  if (payload.key !== key) {
    return {
      state: 'refused',
      detail: `answer for ${key} refused: sealed for ${String(payload.key)}`,
    };
  }
  if (payload.nonce !== expected.nonce) {
    return {
      state: 'refused',
      detail: `answer for ${key} refused: stale (nonce mismatch)`,
    };
  }
  if (!isVerdict(payload.verdict)) {
    return {
      state: 'refused',
      detail: `answer for ${key} refused: malformed verdict`,
    };
  }
  return { state: 'verified', verdict: payload.verdict };
}

// The worker child's bounded wait: poll for the manager's answer and deny
// closed with the named reason when the bound elapses. Never hangs — the
// bound is the contract, headless or not. An answer that does not verify is
// NOT an answer (it is reported once per distinct reason and the wait
// continues), so a planted file cannot settle the ask in either direction.
export async function awaitWorkerAskAnswer(
  dir: string,
  key: string,
  options: {
    maxPendingMs: number;
    verifyKey: string;
    nonce: string;
    pollMs?: number;
    clock?: () => number;
    onRefused?: (detail: string) => void;
    signal?: AbortSignal;
  },
): Promise<WorkerAskOutcome> {
  const clock = options.clock ?? Date.now;
  const pollMs = options.pollMs ?? 25;
  const deadline = clock() + options.maxPendingMs;
  const refused = new Set<string>();
  const signal = options.signal;
  // ONE listener for the whole wait (an abort listener per poll iteration
  // would pile up on a long bound and trip Node's listener warning).
  let onAbort: (() => void) | undefined;
  const aborted = new Promise<void>((resolve) => {
    if (signal === undefined) return;
    if (signal.aborted) {
      resolve();
      return;
    }
    onAbort = () => resolve();
    signal.addEventListener('abort', onAbort, { once: true });
  });
  try {
    for (;;) {
      const answer = readWorkerAskAnswer(dir, key, {
        verifyKey: options.verifyKey,
        nonce: options.nonce,
      });
      if (answer.state === 'verified')
        return classifyVerdict(key, answer.verdict);
      if (
        answer.state === 'refused' &&
        refused.size < 8 &&
        !refused.has(answer.detail)
      ) {
        refused.add(answer.detail);
        options.onRefused?.(answer.detail);
      }
      if (signal?.aborted === true) {
        removeAskFiles(dir, key);
        return {
          approved: false,
          key,
          code: APPROVAL_DENIED_CODE,
          reason: `approval withdrawn ${TIMEOUT_REASON_MARKER} — the waiting turn ended without an answer`,
        };
      }
      if (clock() >= deadline) {
        // The child's own bound expired first: the same withdrawal, so the
        // manager stops presenting a question nobody is waiting for.
        removeAskFiles(dir, key);
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
      // denial this bound promises. The abort clears it, so a withdrawal
      // leaves no timer behind.
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, pollMs);
        void aborted.then(() => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
  } finally {
    if (onAbort !== undefined) signal?.removeEventListener('abort', onAbort);
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
  /**
   * The public verification key this run's answers carry (issue #149): the
   * spawned child is told it (KUBIC_APPROVALS_VERIFY_KEY) and refuses any
   * answer without a matching MAC.
   */
  verifyKey: () => string;
}

export interface WorkerApprovalsRunOptions {
  /**
   * The repo's orchestrator directory — `<repo>/.kubic/orchestrator`. It holds
   * the §60 ledger (`approvals/audit.jsonl`) and NOTHING a worker may write;
   * the run's own state (mailbox, decisions, posture records) lives under the
   * user's home, keyed by this path (issue #149).
   */
  dir: string;
  sessionId: string;
  maxPendingMs: number;
  /**
   * The user's seat when a surface exists (TTY); absent denies on the bound.
   * There is deliberately no `--yes` knob here (issue #323): the run's
   * standing answer covers the MERGE gate only, so a worker's dangerous call
   * always reaches the real seat or denies closed — never an inferred grant.
   */
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
  /**
   * A FRESH (non-`--resume`) run of this session id: discards the approvals
   * state an earlier run of the same id left in the session's state directory
   * (the full-access record, memoized decisions, the ask mailbox) so the run
   * starts enforced with no inherited grant. A resume leaves it unset and
   * continues that state — though state sealed by a previous PROCESS is
   * dropped either way (issue #149: only this run's manager can authenticate
   * an approval). The repo-wide ledger is never touched.
   */
  fresh?: boolean;
  /** Poll cadence used by beginWorker's interval. */
  pollMs?: number;
  debug?: (line: string) => void;
  audit?: (event: RouterAuditEvent) => void;
  /**
   * The home directory the run's own state is keyed under (issue #149);
   * default `os.homedir()`. Injectable so tests never touch a real home, and
   * never the repo or a worktree.
   */
  home?: string;
  /**
   * The run's signing authority; absent mints a fresh one. Injected only so
   * tests can drive two runs that share (or deliberately do not share) one
   * authority — production always mints per run.
   */
  signer?: ApprovalSigner;
}

// ---------------------------------------------------------------------------
// Where a run's approval state lives (issue #149)
// ---------------------------------------------------------------------------
//
// Under the USER's home, keyed by the repo runtime root — never under the repo
// and never under a worker worktree:
//
//   <home>/.kubic/orchestrator/<repoKey>/<session>/   mailbox, decisions, skip
//   <repo>/.kubic/orchestrator/approvals/audit.jsonl  the §60 ledger
//
// A worker runs with bash and the user's own authority, so it can reach any
// path on the machine; what the location buys is that no relative path from a
// worktree (a `cd` and a `../../` redirect) names control state, and that a
// poisoned file cannot sit beside the code a later `git add` ships upstream.
// What actually stops the forgery is the seal (seal.ts) — see
// docs/architecture/orchestrator.md.

// The one repo's state root: a hash of the repo runtime root's orchestrator
// dir, so two repos never share decisions and the SAME repo's runs (in one
// checkout or in linked worktrees, issue #279) do.
export function approvalsStateKey(orchestratorDir: string): string {
  return createHash('sha256')
    .update(orchestratorDir)
    .digest('hex')
    .slice(0, 16);
}

export function orchestratorStateRoot(
  orchestratorDir: string,
  home: string = approvalHome(),
): string {
  return join(
    requireAbsoluteHome(home),
    '.kubic',
    'orchestrator',
    approvalsStateKey(orchestratorDir),
  );
}

// The user home the approval state is keyed under. `process.env.HOME` (and
// USERPROFILE) come FIRST on purpose: that is the view a test — or a caller's
// stub — sets, while `os.homedir()` reads the C environment, which a worker
// thread cannot see (a mutation-sandbox thread would otherwise read the real
// user's home and write state there). A relative or empty value is ignored
// rather than resolved against the process cwd: approval state must never
// land inside the repository it gates.
function approvalHome(
  env: Readonly<Record<string, string | undefined>> = process.env,
): string {
  for (const candidate of [env.HOME, env.USERPROFILE]) {
    if (candidate !== undefined && candidate !== '' && isAbsolute(candidate)) {
      return candidate;
    }
  }
  return homedir();
}

// Fails closed rather than resolving a relative home against the process cwd,
// which would put the state inside the very repository it must stay out of.
function requireAbsoluteHome(home: string): string {
  if (home === '' || !isAbsolute(home)) {
    throw new Error(
      `orchestrator approval state needs an absolute home directory, got ${JSON.stringify(home)} — the state cannot live inside the repository it gates`,
    );
  }
  return home;
}

// `<state root>/<session>/`: one session's approvals state (ask mailbox,
// decision store, full-access record), outside the repo-wide ledger.
export function approvalsSessionDir(
  orchestratorDir: string,
  sessionId: string,
  home: string = approvalHome(),
): string {
  return join(
    orchestratorStateRoot(orchestratorDir, home),
    sessionId.replace(/[^A-Za-z0-9_-]/g, '_') || '_',
  );
}

// Removes exactly one session's approvals state — never the ledger
// (`<repo>/.kubic/orchestrator/approvals/audit.jsonl`) or a sibling session. A
// missing directory is fine. Used when a session's state is retired
// (`kubic clean --session`) and when a fresh run reuses the id.
export function removeSessionApprovalsState(
  orchestratorDir: string,
  sessionId: string,
  home: string = approvalHome(),
): void {
  const target = approvalsSessionDir(orchestratorDir, sessionId, home);
  createNodeFileBridge(dirname(target)).remove(basename(target), true, true);
}

// One approvals run: the router, the mailbox pump, the per-spawn budget gates
// and the session-scoped full-access posture. Construction is where the four
// modules stop being dead — request/routing/budgets/skip are each consulted
// from a live path.
export function createOrchestratorApprovalsRun(
  options: WorkerApprovalsRunOptions,
): WorkerApprovalsRun {
  // The §60 ledger is the repo's ONE trail (`<dir>/approvals/audit.jsonl`,
  // what `kubic audit` reads). The ask mailbox, the decision store and the
  // full-access record are THIS run's own — one directory per session, under
  // the USER's home and keyed by the repo runtime root (issue #149), so a
  // worker's relative path never names them. Two runs share a repo runtime
  // root — in one checkout or across linked worktrees (issue #279) — and their
  // default worker ids collide (`worker-1`), so a shared mailbox would let one
  // run answer another's asks (a `--full-access` run would approve them). The
  // children are told this directory, so nothing else needs to know the
  // layout.
  const ledgerDir = join(options.dir, APPROVALS_DIR);
  const dir = approvalsSessionDir(
    options.dir,
    options.sessionId,
    options.home ?? approvalHome(),
  );
  if (options.fresh === true) {
    removeSessionApprovalsState(
      options.dir,
      options.sessionId,
      options.home ?? approvalHome(),
    );
  }
  // ONE signing authority per run (issue #149): it seals this manager's
  // answers, decisions and posture records, and its public half travels to the
  // children as KUBIC_APPROVALS_VERIFY_KEY. The private half never leaves this
  // process and is never written anywhere.
  const signer = options.signer ?? createApprovalSigner();
  // ONE approvals run owns a session's state directory per process (and per
  // machine, via the session lock): the construction prune below assumes it,
  // and a second run of the same session id constructed concurrently here
  // would wipe the first's mailbox (#149 review finding 3).
  const bridge = createNodeFileBridge(dir);
  // The mailbox is THIS process's: an ask another process read can never be
  // answered by this one (its answer would not carry this run's MAC), so asks
  // left behind by an earlier run are retired rather than re-routed at a
  // worker that never asked them. Decisions and posture records stay — they
  // are dropped by their own authentication, and the §60 ledger is the durable
  // record of what was decided.
  bridge.remove(ASKS_DIR, true, true);
  bridge.createDir(ASKS_DIR, true);
  const debug = options.debug ?? (() => undefined);
  // ONE router trace for the whole run: the router's events, this module's
  // refusals (budget self-raise) and the skip posture all land in it. The
  // durable §60 trail is the repo ledger the router writes each decision to —
  // a DROPPED (unauthenticated) state file is written there too, so a forgery
  // attempt is never silent.
  const auditLog = new RouterAuditTrace();
  const audit = (event: RouterAuditEvent): void => {
    auditLog.append(event);
    // A planted/foreign/stale ANSWER is the attack this issue is about, so its
    // refusal is durable too — not only the in-memory trace and the debug sink
    // (#149 review finding 1). The refusal note is already deduped/capped.
    if (event.type === 'orchestrator-decision-seed-dropped') {
      appendToLedger(
        ledgerDir,
        droppedStateAudit({
          sessionId: options.sessionId,
          what: 'decision',
          detail: event.detail,
        }),
        (message) => debug(`audit: ledger append failed: ${message}`),
      );
    } else if (event.type === 'orchestrator-ask-refused') {
      appendToLedger(
        ledgerDir,
        droppedStateAudit({
          sessionId: options.sessionId,
          what: 'answer',
          detail: event.detail,
        }),
        (message) => debug(`audit: ledger append failed: ${message}`),
      );
    }
    options.audit?.(event);
  };
  const decisions = createWorkerAskRouter({
    dir,
    ledgerDir,
    maxPendingMs: options.maxPendingMs,
    posture: () =>
      fullAccessLive() === undefined ? POSTURE_APPROVALS : POSTURE_FULL_ACCESS,
    debug,
    signer,
    ...(options.seat === undefined ? {} : { seat: options.seat }),
    audit,
  });
  // Session-scoped full access (§41.4): the grant is keyed by sessionId, lives
  // outside the repo with the run's other approvals state, is indicated on the
  // surface, and is recorded for audit/doctor. A fresh session starts
  // enforced; nothing here can make the posture global. Only by:'user' carries
  // authority — enableSessionSkip refuses anything else — and only a record
  // THIS manager sealed is honoured, so a planted file grants nothing.
  const loadedSkip = loadSkipRecords(bridge, signer);
  let skipRecords = loadedSkip.records;
  for (const reason of loadedSkip.dropped) {
    const detail = `full-access record refused: ${reason}`;
    audit({ type: 'session-skip-record-dropped', detail });
    appendToLedger(
      ledgerDir,
      droppedStateAudit({
        sessionId: options.sessionId,
        what: 'full-access record',
        detail,
      }),
      (message) => debug(`audit: ledger append failed: ${message}`),
    );
  }
  if (options.fullAccess === true) {
    const record = enableSessionSkip(
      { sessionId: options.sessionId },
      { by: 'user' },
    );
    skipRecords = [
      ...skipRecords.filter((entry) => entry.sessionId !== options.sessionId),
      record,
    ];
    saveSkipRecords(bridge, skipRecords, signer);
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
      decisions.answer(published, {
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
        decisions.answer(published, {
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
    // A write into Kubic's control plane ALWAYS asks (issue #324): the
    // full-access posture never answers it.
    if (live !== undefined && request.trigger !== 'kubic-state-write') {
      // Full access for THIS session only: indicated, recorded, never quiet.
      debug(formatSessionSkipIndicator(live));
      outcome = await decisions.ask(inputFromRequest(published, scope), {
        autoApprove: true,
      });
    } else {
      outcome = await decisions.ask(inputFromRequest(published, scope));
    }
    // The answer is durable and travels back to the worker, whose own bounded
    // wait would otherwise deny on the bound. It is SEALED (issue #149): the
    // worker accepts it only if the MAC matches the key the run handed it.
    decisions.answer(
      published,
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
  const noteRefused = refusalNote(audit, debug);
  const pump = async (
    scope: WorkerApprovalScope,
  ): Promise<WorkerApprovalTermination | undefined> => {
    for (const published of readPendingWorkerAsks(dir, {
      verifyKey: signer.verifyKey,
      agentId: scope.agentId,
      onRefused: noteRefused,
    })) {
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
      // The worker settled, so its mailbox files are consumed (issue #152)
      // whether or not its last ask was routed first: the success path pumps
      // the ask that raced the exit before calling this, the crash path does
      // not (the worker is gone, so nobody could consume the answer anyway).
      // A long run's mailbox therefore holds only live asks.
      const swept = sweepWorkerAsks(dir, agentId);
      if (swept > 0) {
        debug(`approvals: swept ${swept} settled ask(s) for '${agentId}'`);
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
    verifyKey: () => signer.verifyKey,
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

// A refused answer or a tampered ask leaves the ask pending (issue #149) and
// is reported and audited ONCE per distinct reason: the pump runs this read on
// every tick, and a forged file must not become an unbounded audit stream.
function refusalNote(
  audit: (event: RouterAuditEvent) => void,
  debug: (line: string) => void,
): (detail: string) => void {
  const seen = new Set<string>();
  return (detail) => {
    if (seen.size >= 16 || seen.has(detail)) return;
    seen.add(detail);
    audit({ type: 'orchestrator-ask-refused', detail });
    debug(`approvals: ${detail}`);
  };
}

function loadSkipRecords(
  bridge: FileBridge,
  signer: ApprovalSigner,
): { records: SessionSkipRecord[]; dropped: string[] } {
  const records: SessionSkipRecord[] = [];
  const dropped: string[] = [];
  let raw: unknown;
  try {
    if (!bridge.exists(SKIP_RECORDS_FILE)) return { records, dropped };
    raw = JSON.parse(bridge.readTextFile(SKIP_RECORDS_FILE));
  } catch {
    // A torn file reads as no records (fail closed toward enforcement).
    return { records, dropped };
  }
  if (!Array.isArray(raw)) {
    return { records, dropped: ['unreadable file (not a record list)'] };
  }
  for (const entry of raw) {
    const sealed = verifySealed<SessionSkipRecord>(signer.verifyKey, entry);
    if (sealed === undefined || typeof sealed.payload?.sessionId !== 'string') {
      dropped.push("no MAC from this run's manager");
      continue;
    }
    records.push(sealed.payload);
  }
  return { records, dropped };
}

function saveSkipRecords(
  bridge: FileBridge,
  records: readonly SessionSkipRecord[],
  signer: ApprovalSigner,
): void {
  const tmp = `${SKIP_RECORDS_FILE}.${process.pid}.tmp`;
  bridge.writeFile(
    tmp,
    JSON.stringify(records.map((record) => signer.seal(record))),
  );
  bridge.renameFile(tmp, SKIP_RECORDS_FILE);
}
