// The durable §60 audit ledger: ONE record format (OrgAuditRecord, the 14
// section-60 fields) in ONE append-only JSONL file per repo, written through
// emitAudit's validation and read back by `kubic audit`.
//
// Location: <repo>/.kubic/orchestrator/approvals/audit.jsonl — the path the
// orchestrator's approval layer already owned, and one the shipped runtime
// ignore rules (`.kubic/orchestrator/`) keep out of the user's commit path.
// Solo approval decisions append to the same ledger (same file, same shape),
// so `kubic audit --mode solo|orchestrator` slices one trail.
//
// File access goes through the exec FileBridge (I/O confinement, §9).

import { basename, dirname, join, resolve } from 'node:path';
import { createNodeFileBridge } from '../../../exec/src/file-bridge.js';
import { matchableSecrets } from '../config/secrets.js';
import type { OrchestratorApprovalRequest } from '../orchestrator/approvals/request.js';
import type { OrchestratorVerdict } from '../orchestrator/approvals/routing.js';
import {
  type AuditInput,
  type AuditSink,
  emitAudit,
  type OrgAuditRecord,
  toCredentialSentinel,
} from './audit.js';
import { redactSecretShapes } from './secret-shapes.js';

export const AUDIT_LEDGER_FILE = 'audit.jsonl';

// The ledger's directory for a repo root (the orchestrator approvals dir).
export function auditLedgerDir(repoRoot: string): string {
  return join(repoRoot, '.kubic', 'orchestrator', 'approvals');
}

// The repo runtime root for a working directory (issue #279): the MAIN
// checkout's toplevel — what `git rev-parse --path-format=absolute
// --git-common-dir` names the parent of — so a run from a subdirectory and a
// worker child in a linked worktree both resolve to the one directory
// `kubic audit` reads. Resolved from the filesystem (no git spawn): the
// nearest ancestor holding `.git`; a `.git` FILE (linked worktree) is
// followed to its gitdir and that gitdir's `commondir`. Outside a repository,
// the directory itself.
export function resolveRepoRuntimeRoot(cwd: string): string {
  const bridge = createNodeFileBridge('/');
  const start = resolve(cwd);
  let dir = start;
  for (;;) {
    const dotGit = join(dir, '.git');
    let found = false;
    try {
      found = bridge.exists(dotGit);
    } catch {
      // Unreadable ancestor: keep walking.
    }
    if (found) return mainCheckoutFor(dir, dotGit);
    const parent = dirname(dir);
    if (parent === dir) return start;
    dir = parent;
  }
}

function mainCheckoutFor(top: string, dotGit: string): string {
  const bridge = createNodeFileBridge('/');
  let text: string;
  try {
    // A directory `.git` makes this the main checkout; reading it as a file
    // throws, which lands here.
    text = bridge.readTextFile(dotGit);
  } catch {
    return top;
  }
  const match = /^gitdir:\s*(.+)$/m.exec(text);
  if (match?.[1] === undefined) return top;
  const gitDir = resolve(top, match[1].trim());
  let common: string;
  try {
    common = resolve(
      gitDir,
      bridge.readTextFile(join(gitDir, 'commondir')).trim(),
    );
  } catch {
    // No commondir (a submodule's gitdir): the checkout holding the `.git`
    // file is its own main checkout.
    return top;
  }
  return basename(common) === '.git' ? dirname(common) : top;
}

// The ledger dir for a working directory: the repo runtime root's ledger
// (resolveRepoRuntimeRoot) — the one the solo writer and `kubic audit` share.
export function auditLedgerDirFor(cwd: string): string {
  return auditLedgerDir(resolveRepoRuntimeRoot(cwd));
}

// A synchronous file sink: one validated record per line. appendAudit
// refuses async sinks, so the append completes before emitAudit returns.
export function createLedgerSink(dir: string): AuditSink {
  const bridge = createNodeFileBridge(dir);
  return {
    name: `file:${join(dir, AUDIT_LEDGER_FILE)}`,
    kind: 'file',
    write: (record: OrgAuditRecord): void => {
      if (!bridge.exists('.')) bridge.createDir('.', true);
      const line = `${JSON.stringify(record)}\n`;
      // Durable append (fsync) where the bridge offers it — the journal's
      // own primitive — so a crash cannot lose an acknowledged record.
      if (bridge.appendDurably !== undefined) {
        bridge.appendDurably(AUDIT_LEDGER_FILE, line);
      } else {
        bridge.appendFile(AUDIT_LEDGER_FILE, line);
      }
    },
  };
}

function isOrgAuditRecord(value: unknown): value is OrgAuditRecord {
  if (value === null || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.who === 'string' &&
    typeof record.what === 'string' &&
    typeof record.when === 'string' &&
    (record.mode === 'solo' || record.mode === 'orchestrator') &&
    typeof record.posture === 'string' &&
    (record.result === 'ok' ||
      record.result === 'deny' ||
      record.result === 'error')
  );
}

// A ledger that exists but cannot be read (permission denied, a directory in
// its place, an I/O error) — named, so `kubic audit` never reports it as an
// empty trail (issue #279).
export class AuditLedgerReadError extends Error {
  readonly path: string;
  constructor(path: string, cause: unknown) {
    super(
      `cannot read the audit ledger ${path}: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
    this.name = 'AuditLedgerReadError';
    this.path = path;
  }
}

// Every §60 record in the ledger, oldest first. A missing ledger (ENOENT) is
// an empty trail; any other read failure throws AuditLedgerReadError. A torn
// or foreign line (e.g. a pre-unification router event) is skipped, never
// guessed into a record.
export function readAuditLedger(dir: string): OrgAuditRecord[] {
  const bridge = createNodeFileBridge(dir);
  let text: string;
  try {
    text = bridge.readTextFile(AUDIT_LEDGER_FILE);
  } catch (error) {
    if ((error as { code?: unknown }).code === 'ENOENT') return [];
    throw new AuditLedgerReadError(join(dir, AUDIT_LEDGER_FILE), error);
  }
  const records: OrgAuditRecord[] = [];
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue;
    try {
      const parsed: unknown = JSON.parse(line);
      if (isOrgAuditRecord(parsed)) records.push(parsed);
    } catch {
      // Torn line: skipped.
    }
  }
  return records;
}

// Placeholder for a §60 field the recording site genuinely does not know.
// The record stays honest: it says "unknown", it never invents a value.
const UNKNOWN = 'unknown';

// No network, no credential: an approval decision is not a network action.
const NO_NETWORK = {
  host: 'none',
  port: 0,
  decision: 'deny',
  bytes: 0,
} as const;

function parseModel(model: string | undefined): {
  provider: string;
  id: string;
} {
  if (model === undefined || model === '') {
    return { provider: UNKNOWN, id: UNKNOWN };
  }
  const slash = model.indexOf('/');
  return slash > 0
    ? { provider: model.slice(0, slash), id: model.slice(slash + 1) }
    : { provider: UNKNOWN, id: model };
}

function verdictFields(verdict: OrchestratorVerdict): {
  approval: string;
  result: 'ok' | 'deny';
  reason: string;
} {
  return verdict.approved
    ? {
        approval: `approved by ${verdict.by}`,
        result: 'ok',
        reason: 'approved',
      }
    : {
        approval: 'denied',
        result: 'deny',
        reason: verdict.reason || 'denied',
      };
}

// §60 record for an orchestrator worker's approval decision.
export function orchestratorDecisionAudit(
  request: OrchestratorApprovalRequest,
  verdict: OrchestratorVerdict,
  options: { posture: string; pid?: number; generation?: number },
): AuditInput {
  const { approval, result, reason } = verdictFields(verdict);
  return {
    who: `agent:${request.agentId || UNKNOWN}`,
    what: `tool:${request.toolName || UNKNOWN}`,
    agent: {
      session: request.sessionId || UNKNOWN,
      role: request.role || UNKNOWN,
      ...(request.provenance?.parentSessionId
        ? { parent: request.provenance.parentSessionId }
        : {}),
    },
    model: { ...parseModel(request.provenance?.model), thinking: UNKNOWN },
    worker: {
      pid: options.pid ?? 0,
      generation: options.generation ?? 0,
      role: request.role || UNKNOWN,
    },
    workspace: { path: request.worktree || UNKNOWN, base: UNKNOWN },
    permission: { permission: `trigger:${request.trigger}`, approval },
    credential: { sentinel: 'none' },
    network: { ...NO_NETWORK },
    mode: 'orchestrator',
    posture: options.posture,
    result,
    reason,
  };
}

// §60 record for a solo approval decision (the in-process lane's ask).
export interface SoloDecisionInput {
  sessionId: string;
  toolName: string;
  trigger: string;
  workspace: string;
  model?: string;
  thinking?: string;
  approved: boolean;
  by?: string;
  reason?: string;
  posture: string;
  /**
   * Set when this lane is an orchestrator-managed worker child (issue #279):
   * the record is then an orchestrator record for that worker, carrying the
   * orchestration's session as its parent — never a mislabelled solo one.
   */
  worker?: { id: string; orchestratorSession: string; generation?: number };
}

// The generation the lifecycle layer stamped on this worker child
// (KUBIC_WORKER_GENERATION, the §3.8 allowlist): a non-negative integer, else
// 0 — the same reading the §46 trajectory's provenance uses.
export function workerGenerationFromEnv(
  env: Record<string, string | undefined>,
): number {
  const raw = env.KUBIC_WORKER_GENERATION;
  const parsed = raw === undefined || raw === '' ? Number.NaN : Number(raw);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : 0;
}

export function soloDecisionAudit(
  input: SoloDecisionInput,
  env: Record<string, string | undefined> = process.env,
): AuditInput {
  const { approval, result, reason } = verdictFields(
    input.approved
      ? { approved: true, by: input.by ?? 'user' }
      : { approved: false, reason: input.reason ?? 'denied' },
  );
  const worker = input.worker;
  const role = worker === undefined ? 'root' : 'worker';
  return {
    who: `agent:${worker === undefined ? 'root' : worker.id || UNKNOWN}`,
    what: `tool:${input.toolName || UNKNOWN}`,
    agent: {
      session: input.sessionId || UNKNOWN,
      role,
      ...(worker === undefined || worker.orchestratorSession === ''
        ? {}
        : { parent: worker.orchestratorSession }),
    },
    model: { ...parseModel(input.model), thinking: input.thinking || UNKNOWN },
    // A worker child's generation comes from the env its lifecycle layer set
    // (issue #279) unless the caller supplies one; a solo run is generation 0.
    worker: {
      pid: process.pid,
      generation:
        worker === undefined
          ? 0
          : (worker.generation ?? workerGenerationFromEnv(env)),
      role,
    },
    workspace: { path: input.workspace || UNKNOWN, base: UNKNOWN },
    permission: { permission: `trigger:${input.trigger || UNKNOWN}`, approval },
    credential: { sentinel: 'none' },
    network: { ...NO_NETWORK },
    mode: worker === undefined ? 'solo' : 'orchestrator',
    posture: input.posture,
    result,
    reason,
  };
}

// §60 record for one orchestrator MERGE-gate decision (issue #323). The
// approval names who decided: `--yes` (the run's standing answer, which
// covers merges only) or `user` (a decider answered, or none existed and
// the gate denied closed) — never an inferred approval dressed as a user's.
export interface MergeDecisionInput {
  sessionId: string;
  agentId: string;
  branch: string;
  workspace: string;
  approved: boolean;
  by: '--yes' | 'user';
  reason?: string;
  posture: string;
}

export function mergeDecisionAudit(input: MergeDecisionInput): AuditInput {
  const { approval, result, reason } = verdictFields(
    input.approved
      ? { approved: true, by: input.by }
      : { approved: false, reason: input.reason ?? 'denied' },
  );
  return {
    who: `agent:${input.agentId || UNKNOWN}`,
    what: `merge:${input.branch || UNKNOWN}`,
    agent: { session: input.sessionId || UNKNOWN, role: 'manager' },
    model: { provider: UNKNOWN, id: UNKNOWN, thinking: UNKNOWN },
    worker: { pid: process.pid, generation: 0, role: 'manager' },
    workspace: { path: input.workspace || UNKNOWN, base: UNKNOWN },
    permission: { permission: 'gate:merge', approval },
    credential: { sentinel: 'none' },
    network: { ...NO_NETWORK },
    mode: 'orchestrator',
    posture: input.posture,
    result,
    reason,
  };
}

// §60 record for one credential use (issue #359; §36.1 rule 4): the ref
// (as a sentinel), the role and the purpose — never the value.
export interface CredentialUseInput {
  sessionId: string;
  role: string;
  provider: string;
  ref: string;
  purpose: string;
  workspace: string;
  mode?: 'solo' | 'orchestrator';
  when?: string;
}

export function credentialUseAudit(input: CredentialUseInput): AuditInput {
  return {
    who: `agent:${input.role || UNKNOWN}`,
    what: `credential:${input.provider || UNKNOWN}`,
    ...(input.when === undefined ? {} : { when: input.when }),
    agent: { session: input.sessionId || UNKNOWN, role: input.role || UNKNOWN },
    model: {
      provider: input.provider || UNKNOWN,
      id: UNKNOWN,
      thinking: UNKNOWN,
    },
    worker: { pid: process.pid, generation: 0, role: input.role || UNKNOWN },
    workspace: { path: input.workspace || UNKNOWN, base: UNKNOWN },
    permission: {
      permission: 'credential:use',
      approval: 'resolved at request time',
    },
    credential: { sentinel: toCredentialSentinel(input.ref) },
    network: { ...NO_NETWORK },
    mode: input.mode ?? 'solo',
    posture: 'credentials',
    result: 'ok',
    reason: input.purpose,
  };
}

// §60 record for switching a session to full access (issue #308, §41.4):
// who enabled it (the user, through the CLI), when, for which session, and
// through which command. One row per enable; the per-ask rows that follow
// carry posture 'full-access' on their own.
export interface FullAccessEnabledInput {
  sessionId: string;
  /** The originating command line, e.g. `kubic run --dangerously-skip-approvals`. */
  command: string;
  workspace: string;
  mode: 'solo' | 'orchestrator';
}

export function fullAccessEnabledAudit(
  input: FullAccessEnabledInput,
): AuditInput {
  return {
    who: 'user:cli',
    what: 'posture:full-access',
    agent: { session: input.sessionId || UNKNOWN, role: 'user' },
    model: { provider: UNKNOWN, id: UNKNOWN, thinking: UNKNOWN },
    worker: { pid: process.pid, generation: 0, role: 'user' },
    workspace: { path: input.workspace || UNKNOWN, base: UNKNOWN },
    permission: {
      permission: 'posture:full-access',
      approval: `enabled by ${input.command}`,
    },
    credential: { sentinel: 'none' },
    network: { ...NO_NETWORK },
    mode: input.mode,
    posture: 'full-access',
    result: 'ok',
    reason: `full access enabled for session ${input.sessionId || UNKNOWN} by ${input.command}`,
  };
}

// §60 record for a posture.json change made DURING a session (issue #325):
// the change is refused — the boot posture stays in force and the file is
// restored — and recorded once, so a model-written grant is never mistaken
// for the user's.
export interface PostureChangedInput {
  sessionId: string;
  workspace: string;
  bootFullAccess: boolean;
  observedFullAccess: boolean;
}

export function postureChangedAudit(input: PostureChangedInput): AuditInput {
  const boot = input.bootFullAccess ? 'full-access' : 'approvals';
  const seen = input.observedFullAccess ? 'full-access' : 'approvals';
  return {
    who: 'agent:root',
    what: 'posture:changed-mid-session',
    agent: { session: input.sessionId || UNKNOWN, role: 'root' },
    model: { provider: UNKNOWN, id: UNKNOWN, thinking: UNKNOWN },
    worker: { pid: process.pid, generation: 0, role: 'root' },
    workspace: { path: input.workspace || UNKNOWN, base: UNKNOWN },
    permission: { permission: 'posture:change', approval: 'denied' },
    credential: { sentinel: 'none' },
    network: { ...NO_NETWORK },
    mode: 'solo',
    posture: boot,
    result: 'deny',
    reason: `posture.json changed during the session (${boot} -> ${seen}); ignored and restored — the posture decided at boot stays in force`,
  };
}

function redactLeaves(value: unknown): unknown {
  if (typeof value === 'string') return redactSecretShapes(value);
  if (Array.isArray(value)) return value.map(redactLeaves);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, leaf]) => [key, redactLeaves(leaf)]),
    );
  }
  return value;
}

function redactInput(input: AuditInput): AuditInput {
  return redactLeaves(input) as AuditInput;
}

// Emit one record to the repo ledger. An audit failure never decides the
// action (the decision already happened); it is reported on `onError`.
export function appendToLedger(
  dir: string,
  input: AuditInput,
  onError: (message: string) => void = () => undefined,
  secrets: readonly string[] = [],
): OrgAuditRecord | undefined {
  try {
    // emitAudit refuses a record carrying secret-shaped material. A decision
    // must not vanish because a free-text field (a deny reason echoing a
    // command) looked like a secret, so every string leaf is redacted first:
    // the record survives, the material never reaches the ledger.
    // `secrets` (live values) make emitAudit refuse a record carrying one —
    // but only values long enough to be matched as a substring: a short or
    // dummy key (`gw`, `ollama` for provider `ollama`) is a word the record
    // legitimately carries, and refusing over it silently dropped the
    // credential-use row (issue #359).
    return emitAudit([createLedgerSink(dir)], redactInput(input), {
      secrets: matchableSecrets(secrets),
    });
  } catch (error) {
    onError(error instanceof Error ? error.message : String(error));
    return undefined;
  }
}
