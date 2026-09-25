import { createHash } from 'node:crypto';
import { join } from 'node:path';
import type { PermissionClasses } from '../../agents/src/policy.js';
import {
  checkAgreement,
  SOLO_DEFAULTS,
  toolsForClasses,
  validateClasses,
} from '../../agents/src/policy.js';
import { createNodeFileBridge } from '../../exec/src/file-bridge.js';
import type {
  PolicyInterceptorOptions,
  PolicyTrigger,
} from '../../worker/src/lane/interceptors.js';
import {
  confinePath,
  defaultIsDestructive,
  isNetworkCommand,
  redactReason,
} from '../../worker/src/lane/interceptors.js';
import type { ToolContribution } from '../../worker/src/lane/wrap.js';
import { withTelemetry } from '../../worker/src/lane/wrap.js';
// Approval triggers, policy, and durable decider service (issue #16; §41).
// The decider is the user — never a manager, never the model. There is no
// manager-approval path in solo: this module exposes no role/manager
// override, structurally, not by flag.
// Outcomes deny on timeout and never hang headless: every ask is bounded
// by maxPendingMs. First answer wins (first-wins latch, the memoOnce
// semantic — the harness primitive itself is not involved). Same-process
// late attach discovers pending asks via pendingRequests(); across a
// restart, pending asks time out to deny by design — only settled
// decisions persist (approvals.json), never open questions.
// sessionScoped is enforced by store placement, selected by the host:
// a per-session FileApprovalStore scopes decisions to one session,
// a shared store shares them. The flag documents the intent the host
// must honor when wiring the store.
export const CAPABILITIES = [
  'network',
  'credentials',
  'git-push',
  'destructive-shell',
  'install',
  'deploy',
  'outside-write',
  'budget-overrun',
  'spawn-agents',
] as const;

export type Capability = (typeof CAPABILITIES)[number] | string;

export interface ApprovalPolicy {
  route: 'ask-user' | 'deny';
  autoApprove: Capability[];
  sessionScoped: boolean;
  maxPendingMs: number;
  requireJustification: boolean;
}

export class PolicyValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PolicyValidationError';
  }
}

// autoApprove is explicit-only: it defaults to empty and must arrive as an
// explicit array. A model cannot infer or inject it because nothing on the
// tool path can supply policy — it comes from config alone.
export function validatePolicy(input: unknown): ApprovalPolicy {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new PolicyValidationError('approval policy must be an object');
  }
  const record = input as Record<string, unknown>;
  const route = record.route ?? 'ask-user';
  if (route !== 'ask-user' && route !== 'deny') {
    throw new PolicyValidationError(`invalid route: ${JSON.stringify(route)}`);
  }
  const autoApprove = record.autoApprove ?? [];
  if (
    !Array.isArray(autoApprove) ||
    !autoApprove.every((entry) => typeof entry === 'string')
  ) {
    throw new PolicyValidationError(
      'autoApprove must be an explicit string array',
    );
  }
  const maxPendingMs = record.maxPendingMs ?? 60_000;
  if (typeof maxPendingMs !== 'number' || !(maxPendingMs > 0)) {
    throw new PolicyValidationError('maxPendingMs must be a positive number');
  }
  return {
    route,
    autoApprove: [...autoApprove],
    sessionScoped:
      typeof record.sessionScoped === 'boolean' ? record.sessionScoped : true,
    maxPendingMs,
    requireJustification:
      typeof record.requireJustification === 'boolean'
        ? record.requireJustification
        : false,
  };
}

export interface ApprovalRequest {
  key: string;
  capability: Capability;
  toolName: string;
  summary: string;
  justification?: string;
}

export type ApprovalVerdict =
  | { approved: true; by: string; justified?: boolean }
  | { approved: false; reason: string };

export interface ApprovalStore {
  load(): Record<string, ApprovalVerdict>;
  save(decisions: Record<string, ApprovalVerdict>): void;
}

export class MemoryApprovalStore implements ApprovalStore {
  private decisions: Record<string, ApprovalVerdict> = {};
  load(): Record<string, ApprovalVerdict> {
    return { ...this.decisions };
  }
  save(decisions: Record<string, ApprovalVerdict>): void {
    this.decisions = { ...decisions };
  }
}

// Trigger detection (§41.1). Predicates are injected so this module stays
// free of shell parsing: the worker owns the classifiers (issue #15) and
// the host owns the decision. Detector ownership for the rest:
//   credentials overreach, spawn-agents — no detector: fire only via an
//     explicit `requires` entry, or via their owners (credentials with
//     issue #19 git/credential tools, spawn-agents with the orchestrator).
//   budget/concurrency overrun — the `budgetOverrun` flag; no live
//     producer yet (orchestrator opt-in budgets #48, worker perf budgets
//     #55). Until one wires up, the flag is test-only: documented, silent
//     nowhere.
//   network under allowlist/full — fires nothing by design (issue #15:
//     no network tool exists to remove; the flag is advisory for #16).
//   sensitive reads — deliberately not a trigger: §41.1 governs writes,
//     the filesystem read class governs reads.
export interface TriggerContext {
  workspace: string;
  network: 'none' | 'allowlist' | 'full';
  isDestructive: (command: string, workspace: string) => boolean;
  isNetworkCommand: (command: string) => boolean;
  isOutsideWorkspace: (path: string) => boolean;
  requires?: string[];
  budgetOverrun?: boolean;
}

const GIT_PUSH = /^\s*git\s+push\b/i;
const GIT_REMOTE_MUTATION = /^\s*git\s+remote\s+(add|set-url|remove|rename)\b/i;
const INSTALL =
  /(^|[|;&\s])(npm\s+(i|install|add|clean-install)|pip(3)?\s+install|brew\s+install|apt(-get)?\s+install|cargo\s+(install|add)|go\s+install)\b/i;
const DEPLOY =
  /(^|[|;&\s])(kubectl\s+(apply|create|delete|rollout)|docker\s+push|terraform\s+apply|gh\s+release\s+create)\b/i;
// Shell redirection into an absolute target is a write by another name —
// `echo x > /etc/cron.d/x` must raise outside-write like the write tool.
const REDIRECT = /(^|[|;&\s])[^|;&]*>{1,2}\s*(\S+)/;

export function detectTriggers(
  toolName: string,
  args: Record<string, unknown>,
  ctx: TriggerContext,
): Capability[] {
  const found: Capability[] = [];
  if (ctx.requires?.includes(toolName) === true) {
    found.push(`requires:${toolName}`);
  }
  if (ctx.budgetOverrun === true) {
    found.push('budget-overrun');
  }
  if (toolName === 'bash' && typeof args.command === 'string') {
    const command = args.command;
    if (ctx.isDestructive(command, ctx.workspace))
      found.push('destructive-shell');
    if (ctx.network === 'none' && ctx.isNetworkCommand(command))
      found.push('network');
    if (GIT_PUSH.test(command) || GIT_REMOTE_MUTATION.test(command))
      found.push('git-push');
    if (INSTALL.test(command)) found.push('install');
    if (DEPLOY.test(command)) found.push('deploy');
    const redirect = REDIRECT.exec(command);
    if (redirect !== null && redirect[2] !== undefined) {
      // Targets arrive raw: strip surrounding quotes and trailing
      // delimiters so `> "/etc/cron.d/x"` cannot dodge the outside check.
      const target = redirect[2].replace(/^['"]+|['";,]+$/g, '');
      if (target !== '' && ctx.isOutsideWorkspace(target)) {
        found.push('outside-write');
      }
    }
  }
  if (
    (toolName === 'write' || toolName === 'edit') &&
    typeof args.path === 'string'
  ) {
    if (ctx.isOutsideWorkspace(args.path)) found.push('outside-write');
  }
  return [...new Set(found)];
}

// Stable across restarts: the same dangerous op re-proposed after a crash
// maps to the same key, so a stored decision applies and the user is not
// re-asked. Tool-call ids are deliberately excluded — they change per run.
export function approvalKey(
  toolName: string,
  capability: Capability,
  args: Record<string, unknown>,
): string {
  const canonical = JSON.stringify(sortKeys(args));
  return createHash('sha256')
    .update(`${toolName}|${capability}|${canonical}`)
    .digest('hex')
    .slice(0, 16);
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (typeof value === 'object' && value !== null) {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      out[key] = sortKeys((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}

export function summarizeRequest(
  toolName: string,
  capability: Capability,
  args: Record<string, unknown>,
): string {
  // Summaries reach the TUI and the trajectory: secret-shaped values are
  // redacted exactly like block reasons (issue #15).
  if (toolName === 'bash' && typeof args.command === 'string') {
    return redactReason(`${capability}: ${args.command.slice(0, 120)}`);
  }
  if (typeof args.path === 'string') {
    return redactReason(`${capability}: ${toolName} ${args.path}`);
  }
  return `${capability}: ${toolName}`;
}

// File-backed store: decisions + full-access posture live beside the
// session that scoped them, so a fresh session starts safe (no file →
// default deny posture). posture.json sits beside the session for the
// audit/doctor readers coming in #57/#29. Load is corrupt-tolerant;
// saves are atomic tmp+rename (races fail safe to deny on load).
export interface AccessPosture {
  fullAccess: boolean;
  enabledAt?: number;
  enabledBy?: string;
}

export class FileApprovalStore implements ApprovalStore {
  private readonly file: string;
  private readonly postureFile: string;

  constructor(dir: string) {
    this.file = join(dir, 'approvals.json');
    this.postureFile = join(dir, 'posture.json');
  }

  load(): Record<string, ApprovalVerdict> {
    const bridge = createNodeFileBridge('/');
    if (!bridge.exists(this.file)) return {};
    try {
      return JSON.parse(bridge.readTextFile(this.file)) as Record<
        string,
        ApprovalVerdict
      >;
    } catch {
      return {};
    }
  }

  save(decisions: Record<string, ApprovalVerdict>): void {
    const bridge = createNodeFileBridge('/');
    const tmp = `${this.file}.${process.pid}.tmp`;
    bridge.writeFile(tmp, JSON.stringify(decisions));
    try {
      bridge.renameFile(tmp, this.file);
    } catch (error) {
      try {
        bridge.remove(tmp, false, true);
      } catch {
        // Best-effort tmp cleanup; the original error is what matters.
      }
      throw error;
    }
  }

  loadPosture(): AccessPosture {
    const bridge = createNodeFileBridge('/');
    if (!bridge.exists(this.postureFile)) return { fullAccess: false };
    try {
      return JSON.parse(bridge.readTextFile(this.postureFile)) as AccessPosture;
    } catch {
      return { fullAccess: false };
    }
  }

  savePosture(posture: AccessPosture): void {
    const bridge = createNodeFileBridge('/');
    const tmp = `${this.postureFile}.${process.pid}.tmp`;
    bridge.writeFile(tmp, JSON.stringify(posture));
    bridge.renameFile(tmp, this.postureFile);
  }
}

// Adapter from the service to the worker's approve hook (issue #15 slice
// C). Non-triggered calls pass immediately WITHOUT challenging — the
// worker keeps every #15 guard up for them. Triggered calls need every
// raised capability approved and return challenged=true so the worker
// stands down the guards for exactly that call. Full-access approves
// everything as challenged AND records the posture — indicated, recorded
// beside the session for audit/doctor readers (#57, #29) — never quiet.
export type ApprovalAsk = (call: {
  toolName: string;
  args: Record<string, unknown>;
  toolCallId: string;
}) => Promise<
  { approved: true; challenged: boolean } | { approved: false; reason: string }
>;

export function createApprovalAsk(
  service: ApprovalService,
  ctx: TriggerContext,
  store: FileApprovalStore,
): ApprovalAsk {
  return async (call) => {
    const capabilities = detectTriggers(call.toolName, call.args, ctx);
    if (capabilities.length === 0) return { approved: true, challenged: false };
    const posture = store.loadPosture();
    if (posture.fullAccess) {
      return { approved: true, challenged: true };
    }
    for (const capability of capabilities) {
      const verdict = await service.request({
        key: approvalKey(call.toolName, capability, call.args),
        capability,
        toolName: call.toolName,
        summary: summarizeRequest(call.toolName, capability, call.args),
      });
      if (!verdict.approved) {
        return { approved: false, reason: verdict.reason };
      }
    }
    return { approved: true, challenged: true };
  };
}

export function enableFullAccess(
  store: FileApprovalStore,
  by: string,
  clock: () => number = Date.now,
): AccessPosture {
  const posture: AccessPosture = {
    fullAccess: true,
    enabledAt: clock(),
    enabledBy: by,
  };
  store.savePosture(posture);
  return posture;
}

// The INSTALLED solo policy (issue #86; §40, §41, §59.1). This is the
// single derivation both the lane boot and `kubic doctor` read, so §40.3
// agreement between what doctor prints and what the lane enforces holds by
// construction instead of by two hand-kept copies.
//
// Deny-by-default doctrine, stated once here:
//   - classes: the explicit, documented safe default is SOLO_DEFAULTS
//     (§12.1) — filesystem workspace-write, shell true, network none,
//     git workspace, credentials none. Config-sourced classes REPLACE the
//     default when the config layer supplies them; the restrictive tail
//     (network none, credentials none) is what makes the default safe.
//   - interceptors: destructive + network + confinement guards are ALWAYS
//     installed, with the approval ask wired, so a destructive command in a
//     non-interactive run is refused rather than executed. `workspace` is
//     the confinement root: the lane cannot invent one, so it is explicit.
//   - contributions: the telemetry wrapper is appended LAST, which makes it
//     outermost — it therefore times (and records) a DENIED attempt too.
//     The permission wrapper is composed by the lane itself, innermost, from
//     the same classes (solo.ts withPolicyContributions) — never duplicated
//     here.
export interface SoloPolicyInput {
  workspace: string;
  /** Config-sourced classes; absent means the documented SOLO_DEFAULTS. */
  classes?: PermissionClasses;
  /**
   * Where the classes came from, as the CONFIG LAYER recorded it. Absent
   * falls back to the shape rule (classes present ⇒ 'config'), which is what
   * legacy callers mean; the composition root always passes the layer's own
   * answer, so a config-less install is never printed as 'config'.
   */
  source?: 'config' | 'default';
  /** Extension/facet contributions; telemetry composes outermost of them. */
  contributions?: ToolContribution[];
  /** Telemetry sink (issue #15 slice D); absent means no telemetry wrapper. */
  telemetry?: (record: { toolName: string; durationMs: number }) => void;
  /** Bounded approval wait (headless never answers; it denies on timeout). */
  maxPendingMs?: number;
  /** The approval route the shipped default runs on. */
  route?: 'ask-user' | 'deny';
  /** Stored decisions are scoped to one session (the shipped default). */
  sessionScoped?: boolean;
  /** Session dir carrying posture.json (session-scoped full access). */
  sessionDir?: string;
  /** Trigger sink (debug/trajectory), never consulted for the decision. */
  onTrigger?: (trigger: PolicyTrigger) => void;
  clock?: () => number;
}

// What the lane installed and what doctor must print, in ONE object.
export interface InstalledPolicyPosture {
  source: 'config' | 'default';
  route: 'ask-user' | 'deny';
  classes: PermissionClasses;
  allowlist: string[];
  interceptors: string[];
  sessionScoped: boolean;
  maxPendingMs: number;
  fullAccess: boolean;
}

export interface RecordedApprovalDeny {
  capability: string;
  toolName: string;
  reason: string;
}

// The named reason a challenged call is refused with while no surface can
// collect a verdict. Named once, here, so the block reason, the doctor line
// and the headless terminus all say the same sentence.
export const NO_ANSWER_SURFACE_REASON =
  'approval required, but no approval surface is installed on this command (headless has no TTY; the TUI overlay has not landed) — refusing the operation instead of running it unapproved';

export interface InstalledSoloPolicy {
  classes: PermissionClasses;
  interceptors: PolicyInterceptorOptions;
  contributions: ToolContribution[];
  posture: InstalledPolicyPosture;
  // Approvals this policy refused, in order. The composition root reads this
  // after a drive: a headless run that hit an unanswerable approval must end
  // as approval_timed_out (exit 4), never as a silent success.
  denials: () => RecordedApprovalDeny[];
  // The decider, exposed so a caller (or a test) can drive it directly.
  ask: ApprovalAsk;
}

export function installedPolicyPosture(
  input: SoloPolicyInput,
): InstalledPolicyPosture {
  const classes = validateClasses({ ...(input.classes ?? {}) });
  const allowlist = toolsForClasses(classes);
  // §40.3: the derived allowlist must agree with the classes it came from —
  // a contradictory pair is refused by name here, never printed green.
  const agreement = checkAgreement(classes, allowlist);
  if (!agreement.agree) {
    throw new PolicyValidationError(
      `installed policy contradicts itself: ${agreement.reason}`,
    );
  }
  const route = input.route ?? 'ask-user';
  const sessionScoped = input.sessionScoped ?? true;
  const fullAccess =
    input.sessionDir === undefined
      ? false
      : new FileApprovalStore(input.sessionDir).loadPosture().fullAccess;
  return {
    // The layer's own answer when the caller supplies it (the composition
    // root does); the shape rule only as the legacy fallback, so the printed
    // source is never a guess about a config-less install.
    source:
      input.source ?? (input.classes === undefined ? 'default' : 'config'),
    route,
    classes: { ...classes },
    allowlist: [...allowlist],
    // Named mechanisms, not adjectives: this is exactly what the lane
    // registers (registerPolicyInterceptors) plus the execute-time wrapper
    // the lane composes from `classes`.
    interceptors: [
      'permission-wrapper',
      'destructive-guard',
      'network-guard',
      'confine-guard',
      'approval',
    ],
    sessionScoped,
    maxPendingMs: input.maxPendingMs ?? 60_000,
    fullAccess,
  };
}

export function installSoloPolicy(input: SoloPolicyInput): InstalledSoloPolicy {
  const posture = installedPolicyPosture(input);
  const denials: RecordedApprovalDeny[] = [];
  const store =
    input.sessionDir === undefined
      ? undefined
      : new FileApprovalStore(input.sessionDir);
  const service = new ApprovalService({
    policy: validatePolicy({
      route: posture.route,
      sessionScoped: posture.sessionScoped,
      maxPendingMs: posture.maxPendingMs,
    }),
    ...(store === undefined ? {} : { store }),
    ...(input.clock === undefined ? {} : { clock: input.clock }),
  });
  const ask: ApprovalAsk = async (call) => {
    if (
      store !== undefined &&
      store.loadPosture().fullAccess &&
      posture.route === 'ask-user'
    ) {
      // Explicit, session-scoped full access — recorded, never implied.
      return { approved: true, challenged: true };
    }
    const capabilities = detectTriggers(
      call.toolName,
      call.args,
      triggerContextFor(posture.classes, input.workspace),
    );
    if (capabilities.length === 0) return { approved: true, challenged: false };
    for (const capability of capabilities) {
      const key = approvalKey(call.toolName, capability, call.args);
      // A stored decision (a real answer, from a surface that has one) wins:
      // first-answer-latched, exactly like every other approval path.
      const decided = service.decided(key);
      if (decided !== undefined) {
        if (!decided.approved) {
          denials.push({
            capability,
            toolName: call.toolName,
            reason: decided.reason,
          });
          return { approved: false, reason: decided.reason };
        }
        continue;
      }
      if (posture.route === 'deny') {
        // Configured refusal: named as the route, never as a timeout.
        const reason = `denied by policy route (capability: ${capability})`;
        denials.push({ capability, toolName: call.toolName, reason });
        return { approved: false, reason };
      }
      // NO ANSWER SURFACE IS INSTALLED YET — neither `kubic run` (no TTY) nor
      // `kubic tui` (the approval overlay is its own interaction surface,
      // explicitly out of scope for #86) can collect a verdict. Waiting
      // maxPendingMs for an answer that cannot arrive would be a silent hang
      // and a 60s stall per dangerous call; the honest default is to refuse
      // immediately and RECORD the refusal, so the composition root ends the
      // run as approval_timed_out (exit 4, §78) instead of reporting a
      // success the user never approved. The refusal is deliberately NOT
      // persisted: it is a missing surface, not a user decision, and a later
      // overlay must still be able to ask about the same operation.
      const reason = `${NO_ANSWER_SURFACE_REASON} (capability: ${capability})`;
      denials.push({ capability, toolName: call.toolName, reason });
      return { approved: false, reason };
    }
    return { approved: true, challenged: true };
  };
  const contributions = [...(input.contributions ?? [])];
  if (input.telemetry !== undefined) {
    // Outermost by construction: appended last, so it wraps whatever the
    // caller contributed and the lane's own permission(core) stack.
    contributions.push(withTelemetry(input.telemetry));
  }
  return {
    classes: posture.classes,
    interceptors: {
      workspace: input.workspace,
      shell: posture.classes.shell,
      network: posture.classes.network,
      approve: ask,
      ...(input.onTrigger === undefined ? {} : { onTrigger: input.onTrigger }),
    },
    contributions,
    posture,
    denials: () => [...denials],
    ask,
  };
}

// The trigger context the shipped default evaluates capabilities with: the
// same classifiers the worker guards use (issue #15), so the approval
// decision and the guard that blocks the call can never disagree.
export function triggerContextFor(
  classes: PermissionClasses,
  workspace: string,
): TriggerContext {
  return {
    workspace,
    network: classes.network,
    isDestructive: defaultIsDestructive,
    isNetworkCommand,
    isOutsideWorkspace: (path: string) =>
      confinePath(workspace, path).rewritten,
  };
}

export interface ApprovalServiceOptions {
  policy: ApprovalPolicy;
  store?: ApprovalStore;
  // Resolves the pending request when a user answers. Never resolves on
  // its own in headless runs — the wait below times out into a denial.
  awaitAnswer?: (
    request: ApprovalRequest,
  ) => Promise<ApprovalVerdict | undefined>;
  clock?: () => number;
}

export class ApprovalService {
  private readonly policy: ApprovalPolicy;
  private readonly store: ApprovalStore;
  private readonly awaitAnswer?: (
    request: ApprovalRequest,
  ) => Promise<ApprovalVerdict | undefined>;
  private readonly decisions: Map<string, ApprovalVerdict>;
  private readonly pending = new Map<string, ApprovalRequest>();
  private readonly waiters = new Map<
    string,
    (verdict: ApprovalVerdict | undefined) => void
  >();

  constructor(options: ApprovalServiceOptions) {
    this.policy = options.policy;
    this.store = options.store ?? new MemoryApprovalStore();
    this.awaitAnswer = options.awaitAnswer;
    this.decisions = new Map(Object.entries(this.store.load()));
  }

  pendingRequests(): ApprovalRequest[] {
    return [...this.pending.values()];
  }

  decided(key: string): ApprovalVerdict | undefined {
    return this.decisions.get(key);
  }

  // First answer wins: a stored decision is returned untouched and a late
  // submit for a settled key is ignored (memoOnce semantics) — EXCEPT a
  // stored approval that predates a tightened policy: an approval granted
  // without justification does not survive requireJustification being
  // enabled later. It re-enters the policy path (and denies headless).
  submit(request: ApprovalRequest, verdict: ApprovalVerdict): ApprovalVerdict {
    const existing = this.decisions.get(request.key);
    if (existing !== undefined) return existing;
    if (
      this.policy.requireJustification &&
      verdict.approved &&
      request.justification === undefined
    ) {
      return { approved: false, reason: 'approval requires justification' };
    }
    const stamped: ApprovalVerdict = verdict.approved
      ? { ...verdict, justified: request.justification !== undefined }
      : verdict;
    this.decisions.set(request.key, stamped);
    this.persist();
    this.pending.delete(request.key);
    this.waiters.get(request.key)?.(stamped);
    this.waiters.delete(request.key);
    return stamped;
  }

  async request(request: ApprovalRequest): Promise<ApprovalVerdict> {
    const existing = this.decisions.get(request.key);
    if (existing !== undefined) {
      const stale =
        existing.approved &&
        this.policy.requireJustification &&
        existing.justified !== true;
      if (!stale) return existing;
      // Evict: the stored approval predates the tightened policy and must
      // re-enter the policy path (submit's first-wins latch would otherwise
      // hand it straight back). Every path below ends in submit, which
      // persists — so the eviction is durable and the denial is recorded.
      this.decisions.delete(request.key);
    }
    if (this.policy.autoApprove.includes(request.capability)) {
      if (
        this.policy.requireJustification &&
        request.justification === undefined
      ) {
        return this.submit(request, {
          approved: false,
          reason: 'approval requires justification',
        });
      }
      return this.submit(request, { approved: true, by: 'autoApprove' });
    }
    if (this.policy.route === 'deny') {
      return this.submit(request, {
        approved: false,
        reason: `denied by policy route (capability: ${request.capability})`,
      });
    }
    this.pending.set(request.key, request);
    try {
      const answer = await this.waitForAnswer(request);
      if (answer === undefined) {
        return this.submit(request, {
          approved: false,
          reason: `approval timed out after ${this.policy.maxPendingMs}ms`,
        });
      }
      return this.submit(request, answer);
    } finally {
      this.pending.delete(request.key);
    }
  }

  private waitForAnswer(
    request: ApprovalRequest,
  ): Promise<ApprovalVerdict | undefined> {
    const answer = this.awaitAnswer?.(request);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<undefined>((resolve) => {
      timer = setTimeout(() => resolve(undefined), this.policy.maxPendingMs);
      timer.unref?.();
    });
    const notified = new Promise<ApprovalVerdict | undefined>((resolve) => {
      this.waiters.set(request.key, resolve);
    });
    const done = (
      value: ApprovalVerdict | undefined,
    ): ApprovalVerdict | undefined => {
      if (timer !== undefined) clearTimeout(timer);
      this.waiters.delete(request.key);
      return value;
    };
    if (answer === undefined) return timeout.then(done);
    return Promise.race([answer, timeout, notified]).then(done);
  }

  private persist(): void {
    this.store.save(Object.fromEntries(this.decisions));
  }
}
