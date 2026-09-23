// Org audit trail (issue #57; §83 P4 engine, §60 record, §85 flow).
// Every privileged action is auditable at org scope with exactly the 14
// §60 fields. Credential material never lands here: the credential leaf
// carries a sentinel naming the ref, and any secret-shaped value in it is
// refused loudly. Sinks are syslog-first ([[audit]] order); a sink failure
// — or zero sinks — throws instead of losing records silently.
// Read-only wrt doctor (#29), broker/ScopedToken (#38), approvals (#41):
// nothing is imported from worker impl and nothing existing is modified.
// Faux-only, zero network; no node:fs (sinks are injected).

import type { AuditSinkKind } from './enterprise.js';
import { containsSecretShape, redactSecretShapes } from './secret-shapes.js';

export const AUDIT_FIELDS = [
  'who',
  'what',
  'when',
  'agent',
  'model',
  'worker',
  'workspace',
  'permission',
  'credential',
  'network',
  'mode',
  'posture',
  'result',
  'reason',
] as const;

export type AuditField = (typeof AUDIT_FIELDS)[number];

export type AuditMode = 'solo' | 'orchestrator';

export type AuditDecision = 'allow' | 'deny';

export type AuditResult = 'ok' | 'deny' | 'error';

// Exactly 14 top-level fields (§60): who/what/when; agent session/role/
// parent; model provider/id/thinking; worker pid/gen/role; workspace
// path+base; permission/approval; credential sentinel (never secret);
// network host/port/decision/bytes; mode; posture; result+reason.
export interface OrgAuditRecord {
  who: string;
  what: string;
  when: string;
  agent: { session: string; role: string; parent?: string };
  model: { provider: string; id: string; thinking: string };
  worker: { pid: number; generation: number; role: string };
  workspace: { path: string; base: string };
  permission: { permission: string; approval: string };
  credential: { sentinel: string };
  network: {
    host: string;
    port: number;
    decision: AuditDecision;
    bytes: number;
  };
  mode: AuditMode;
  posture: string;
  result: AuditResult;
  reason: string;
}

export class AuditSinkError extends Error {
  constructor(message: string) {
    // Fail-closed messages: secret-shaped substrings are redacted so a
    // sink failure can never echo live material back to the caller.
    super(redactSecretShapes(message));
    this.name = 'AuditSinkError';
  }
}

// Shape violations (unknown top-level keys, secret-shaped smuggling) are a
// distinct fail-closed signal that still satisfies `instanceof
// AuditSinkError` for existing catch sites.
export class AuditShapeError extends AuditSinkError {
  constructor(message: string) {
    super(message);
    this.name = 'AuditShapeError';
  }
}

export interface AuditSink {
  name: string;
  kind: AuditSinkKind | 'syslog' | 'file' | 'memory';
  write: (record: OrgAuditRecord) => void;
}

export interface MemoryAuditSink extends AuditSink {
  kind: 'memory';
  records: OrgAuditRecord[];
}

export function createMemorySink(name = 'memory'): MemoryAuditSink {
  const records: OrgAuditRecord[] = [];
  return {
    name,
    kind: 'memory',
    records,
    write: (record: OrgAuditRecord): void => {
      records.push(record);
    },
  };
}

// [[audit]] order is syslog-first: syslog sinks always lead, stably.
export function sortAuditSinksSyslogFirst(sinks: AuditSink[]): AuditSink[] {
  const rank = (sink: AuditSink): number =>
    sink.kind === 'syslog' ? 0 : sink.kind === 'file' ? 1 : 2;
  return [...sinks]
    .map((sink, index) => ({ sink, index }))
    .sort((a, b) => rank(a.sink) - rank(b.sink) || a.index - b.index)
    .map((entry) => entry.sink);
}

// A sentinel names the credential ref without carrying material:
// `sentinel:$API_KEY`, never the value behind it.
export function toCredentialSentinel(ref: string): string {
  return `sentinel:${ref}`;
}

function assertSentinelClean(
  sentinel: string,
  secrets: readonly string[],
): void {
  for (const secret of secrets) {
    if (secret === '') continue;
    if (sentinel.includes(secret)) {
      throw new AuditSinkError(
        'audit credential sentinel carries secret material: refused',
      );
    }
  }
}

function requireText(value: unknown, path: string): string {
  if (typeof value !== 'string' || value === '') {
    throw new AuditSinkError(
      `audit record '${path}' must be a non-empty string`,
    );
  }
  return value;
}

function validateRecord(
  record: OrgAuditRecord,
  secrets: readonly string[],
): void {
  requireText(record.who, 'who');
  requireText(record.what, 'what');
  requireText(record.when, 'when');
  requireText(record.agent.session, 'agent.session');
  requireText(record.agent.role, 'agent.role');
  requireText(record.model.provider, 'model.provider');
  requireText(record.model.id, 'model.id');
  requireText(record.model.thinking, 'model.thinking');
  requireText(record.workspace.path, 'workspace.path');
  requireText(record.workspace.base, 'workspace.base');
  requireText(record.permission.permission, 'permission.permission');
  requireText(record.permission.approval, 'permission.approval');
  requireText(record.credential.sentinel, 'credential.sentinel');
  requireText(record.network.host, 'network.host');
  requireText(record.posture, 'posture');
  requireText(record.reason, 'reason');
  if (!Number.isInteger(record.worker.pid) || record.worker.pid < 0) {
    throw new AuditSinkError(
      "audit record 'worker.pid' must be a non-negative integer",
    );
  }
  if (
    !Number.isInteger(record.worker.generation) ||
    record.worker.generation < 0
  ) {
    throw new AuditSinkError(
      "audit record 'worker.generation' must be a non-negative integer",
    );
  }
  requireText(record.worker.role, 'worker.role');
  if (!Number.isInteger(record.network.port) || record.network.port < 0) {
    throw new AuditSinkError(
      "audit record 'network.port' must be a non-negative integer",
    );
  }
  if (
    record.network.decision !== 'allow' &&
    record.network.decision !== 'deny'
  ) {
    throw new AuditSinkError(
      "audit record 'network.decision' must be allow|deny",
    );
  }
  if (!Number.isInteger(record.network.bytes) || record.network.bytes < 0) {
    throw new AuditSinkError(
      "audit record 'network.bytes' must be a non-negative integer",
    );
  }
  if (record.mode !== 'solo' && record.mode !== 'orchestrator') {
    throw new AuditSinkError("audit record 'mode' must be solo|orchestrator");
  }
  if (
    record.result !== 'ok' &&
    record.result !== 'deny' &&
    record.result !== 'error'
  ) {
    throw new AuditSinkError("audit record 'result' must be ok|deny|error");
  }
  // The whole serialized record must be free of secret material — the
  // sentinel rule is enforced on the wire form, not just the leaf.
  const text = JSON.stringify(record);
  for (const secret of secrets) {
    if (secret === '') continue;
    if (text.includes(secret)) {
      throw new AuditShapeError(
        'audit record carries secret material: refused (sentinel only)',
      );
    }
  }
  // Shape backstop: the listed-secrets inventory is not the only refusal
  // signal. Any secret-shaped value anywhere in the wire form is refused
  // even when the caller omits `secrets` entirely — no fail-open default.
  if (containsSecretShape(text)) {
    throw new AuditShapeError(
      'audit record carries secret-shaped material: refused (sentinel only)',
    );
  }
  assertSentinelClean(record.credential.sentinel, secrets);
}

// Loud append: every sink must accept the record synchronously. Any failure
// — a throw, a returned thenable (async sinks are refused: records must be
// durable before emitAudit returns), or zero sinks — throws AuditSinkError
// naming the failed sinks. Records are never silently lost.
export function appendAudit(sinks: AuditSink[], record: OrgAuditRecord): void {
  if (sinks.length === 0) {
    throw new AuditSinkError('no audit sinks: record would be silently lost');
  }
  const failed: string[] = [];
  for (const sink of sinks) {
    try {
      const outcome: unknown = sink.write(record);
      if (
        outcome !== undefined &&
        outcome !== null &&
        typeof (outcome as { then?: unknown }).then === 'function'
      ) {
        throw new Error(
          `async audit sink '${sink.name}' returned a thenable: refused`,
        );
      }
    } catch (error) {
      failed.push(
        `${sink.name} (${error instanceof Error ? error.message : String(error)})`,
      );
    }
  }
  if (failed.length > 0) {
    throw new AuditSinkError(`audit sink failure: ${failed.join('; ')}`);
  }
}

export type AuditInput = Omit<OrgAuditRecord, 'when'> & { when?: string };

export interface EmitAuditOptions {
  now?: () => number;
  secrets?: string[];
}

// Build, validate, and loudly append one org audit record. Mode and
// posture are required on every record — there is no default posture. The
// input spreads onto exactly the 14 §60 fields: any unknown top-level key
// is rejected fail-closed with AuditShapeError, never kept.
const ALLOWED_AUDIT_INPUT_KEYS = new Set<string>([...AUDIT_FIELDS, 'when']);

export function emitAudit(
  sinks: AuditSink[],
  input: AuditInput,
  options: EmitAuditOptions = {},
): OrgAuditRecord {
  for (const key of Object.keys(input)) {
    if (!ALLOWED_AUDIT_INPUT_KEYS.has(key)) {
      throw new AuditShapeError(
        `audit record has unknown top-level key '${key}': refused (exactly 14 section-60 fields)`,
      );
    }
  }
  const record: OrgAuditRecord = {
    ...input,
    when: input.when ?? new Date(options.now?.() ?? Date.now()).toISOString(),
  };
  validateRecord(record, options.secrets ?? []);
  appendAudit(sinks, record);
  return record;
}

export interface AuditQuery {
  mode?: AuditMode;
  posture?: string;
  result?: AuditResult;
}

// Full-access (and any other posture/mode slice) is queryable: exact match
// on each supplied dimension.
export function queryAudits(
  records: readonly OrgAuditRecord[],
  query: AuditQuery,
): OrgAuditRecord[] {
  return records.filter(
    (record) =>
      (query.mode === undefined || record.mode === query.mode) &&
      (query.posture === undefined || record.posture === query.posture) &&
      (query.result === undefined || record.result === query.result),
  );
}

// §85 flow fixture: the canonical privileged-action record. Its JSON must
// match WORKED_EXAMPLE_JSON (§60 worked example) byte-for-byte.
export const FLOW_AUDIT_FIXTURE: OrgAuditRecord = {
  who: 'ege@example.com',
  what: 'tool.call',
  when: '2023-11-14T22:13:20.000Z',
  agent: { session: 'sess-1', role: 'implementer', parent: 'sess-0' },
  model: { provider: 'local', id: 'llama3', thinking: 'medium' },
  worker: { pid: 1234, generation: 2, role: 'implementer' },
  workspace: { path: '/repo/wt/57', base: '/repo' },
  permission: { permission: 'write', approval: 'approved:tester' },
  credential: { sentinel: 'sentinel:$API_KEY' },
  network: { host: 'example.com', port: 443, decision: 'allow', bytes: 512 },
  mode: 'orchestrator',
  posture: 'restricted',
  result: 'ok',
  reason: 'policy allow',
};

export const WORKED_EXAMPLE_JSON =
  '{"who":"ege@example.com","what":"tool.call","when":"2023-11-14T22:13:20.000Z","agent":{"session":"sess-1","role":"implementer","parent":"sess-0"},"model":{"provider":"local","id":"llama3","thinking":"medium"},"worker":{"pid":1234,"generation":2,"role":"implementer"},"workspace":{"path":"/repo/wt/57","base":"/repo"},"permission":{"permission":"write","approval":"approved:tester"},"credential":{"sentinel":"sentinel:$API_KEY"},"network":{"host":"example.com","port":443,"decision":"allow","bytes":512},"mode":"orchestrator","posture":"restricted","result":"ok","reason":"policy allow"}';
