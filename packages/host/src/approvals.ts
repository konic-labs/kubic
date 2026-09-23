import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { createNodeFileBridge } from '../../exec/src/file-bridge.js';
// Approval triggers, policy, and durable decider service (issue #16; §41).
// The decider is the user — never a manager, never the model. There is no
// manager-approval path in solo: this module exposes no role/manager
// override, structurally, not by flag.
// Outcomes deny on timeout and never hang headless: every ask is bounded
// by maxPendingMs. First answer wins (memoOnce semantics); late attach
// discovers pending requests through the same service.
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
  | { approved: true; by: string }
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
// the host owns the decision. Capabilities with no detector today —
// credentials overreach, spawn-agents — fire only via an explicit
// `requires` entry or their future owners; that is documented, not silent.
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
  if (toolName === 'bash' && typeof args.command === 'string') {
    return `${capability}: ${args.command.slice(0, 120)}`;
  }
  if (typeof args.path === 'string') {
    return `${capability}: ${toolName} ${args.path}`;
  }
  return `${capability}: ${toolName}`;
}

// File-backed store: decisions + full-access posture live beside the
// session that scoped them, so a fresh session starts safe (no file →
// default deny posture) and audit/doctor read the same files later.
// Load is corrupt-tolerant; saves are atomic tmp+rename.
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
// C). Non-triggered calls pass immediately without touching the service;
// triggered calls need every raised capability approved. Full-access
// approves everything AND records the posture — indicated, recorded,
// and doctor-visible — never a quiet bypass.
export type ApprovalAsk = (call: {
  toolName: string;
  args: Record<string, unknown>;
  toolCallId: string;
}) => Promise<{ approved: true } | { approved: false; reason: string }>;

export function createApprovalAsk(
  service: ApprovalService,
  ctx: TriggerContext,
  store: FileApprovalStore,
): ApprovalAsk {
  return async (call) => {
    const capabilities = detectTriggers(call.toolName, call.args, ctx);
    if (capabilities.length === 0) return { approved: true };
    const posture = store.loadPosture();
    if (posture.fullAccess) {
      return { approved: true };
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
    return { approved: true };
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
  // submit for a settled key is ignored (memoOnce semantics).
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
    this.decisions.set(request.key, verdict);
    this.persist();
    this.pending.delete(request.key);
    this.waiters.get(request.key)?.(verdict);
    this.waiters.delete(request.key);
    return verdict;
  }

  async request(request: ApprovalRequest): Promise<ApprovalVerdict> {
    const existing = this.decisions.get(request.key);
    if (existing !== undefined) return existing;
    if (this.policy.autoApprove.includes(request.capability)) {
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
