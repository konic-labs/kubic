// Org audit trail (issue #57; §83 P4 engine, §60 record, §85 flow).
// Every privileged action is auditable at org scope with exactly the 14
// §60 fields. Credential material never lands here: the credential leaf
// carries a sentinel naming the ref, and any secret-shaped value in it is
// refused loudly. Sinks are syslog-first ([[audit]] order); a sink failure
// — or zero sinks — throws instead of losing records silently.
// Read-only wrt doctor (#29), broker/ScopedToken (#38), approvals (#41):
// nothing is imported from worker impl and nothing existing is modified.
// Faux-only, zero network; no node:fs (sinks are injected).

import { hostname } from 'node:os';
import type { AuditSinkKind } from './enterprise.js';
import {
  containsSecretShape,
  REDACTED_SECRET,
  redactSecretShapes,
} from './secret-shapes.js';

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

// Listed-secret inventory values are redacted literally (in addition to
// secret-shaped substrings): a sink failure echoing a listed value that has
// no secret shape must still never leak it back to the caller.
function redactListedSecrets(text: string, secrets: readonly string[]): string {
  let out = text;
  for (const secret of secrets) {
    if (secret === '') continue;
    if (out.includes(secret)) out = out.split(secret).join(REDACTED_SECRET);
  }
  return out;
}

export class AuditSinkError extends Error {
  constructor(message: string, secrets: readonly string[] = []) {
    // Fail-closed messages: secret-shaped substrings and every listed-secret
    // inventory value are redacted so a sink failure can never echo live
    // material back to the caller.
    super(redactListedSecrets(redactSecretShapes(message), secrets));
    this.name = 'AuditSinkError';
  }
}

// Shape violations (unknown top-level keys, secret-shaped smuggling) are a
// distinct fail-closed signal that still satisfies `instanceof
// AuditSinkError` for existing catch sites.
export class AuditShapeError extends AuditSinkError {
  constructor(message: string, secrets: readonly string[] = []) {
    super(message, secrets);
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

// RFC 5424 facilities (issue #286; §58): names plus local0–local7 for the
// enterprise collector. A `[[audit]] facility` that names none of these is
// refused at sink construction, never silently mapped to a wrong facility.
const SYSLOG_FACILITIES: Readonly<Record<string, number>> = {
  kern: 0,
  user: 1,
  mail: 2,
  daemon: 3,
  auth: 4,
  syslog: 5,
  lpr: 6,
  news: 7,
  uucp: 8,
  cron: 9,
  authpriv: 10,
  ftp: 11,
  ntp: 12,
  logaudit: 13,
  logalert: 14,
  cron2: 15,
  local0: 16,
  local1: 17,
  local2: 18,
  local3: 19,
  local4: 20,
  local5: 21,
  local6: 22,
  local7: 23,
};

export function resolveSyslogFacility(
  facility: string | number | undefined,
): number {
  if (facility === undefined) return SYSLOG_FACILITIES.local0 ?? 16;
  if (typeof facility === 'number') {
    if (Number.isInteger(facility) && facility >= 0 && facility <= 23) {
      return facility;
    }
    throw new AuditSinkError(`unknown syslog facility '${facility}'`);
  }
  const code = SYSLOG_FACILITIES[facility];
  if (code === undefined) {
    throw new AuditSinkError(`unknown syslog facility '${facility}'`);
  }
  return code;
}

export type SyslogTarget =
  | { kind: 'unix'; path: string }
  | { kind: 'udp'; host: string; port: number };

// The platform's syslog socket (issue #286): `/var/run/syslog` on macOS,
// `/dev/log` elsewhere. No import needed — `process.platform` is global.
export function defaultSyslogSocketPath(): string {
  return process.platform === 'darwin' ? '/var/run/syslog' : '/dev/log';
}

// A `[[audit]] target` for `sink = "syslog"`: a bare or `unix:`-prefixed
// socket path (unix datagram), otherwise a `host[:port]` UDP destination
// (port 514 when absent). Refused by name — a mistyped target must never
// route the audit trail into the void.
export function parseSyslogTarget(target: string | undefined): SyslogTarget {
  if (target !== undefined && target.trim() === '') {
    throw new AuditSinkError(`invalid syslog target ${JSON.stringify(target)}`);
  }
  if (target === undefined || target.startsWith('/')) {
    return {
      kind: 'unix',
      path: target ?? defaultSyslogSocketPath(),
    };
  }
  const rest = target.startsWith('unix:')
    ? target.slice('unix:'.length)
    : target;
  if (rest.startsWith('/')) return { kind: 'unix', path: rest };
  const match = /^(\[[^\]]+\]|[^:]+)(?::(\d+))?$/.exec(target);
  const host = match?.[1];
  const portText = match?.[2];
  if (host === undefined || host === '') {
    throw new AuditSinkError(`invalid syslog target ${JSON.stringify(target)}`);
  }
  const port = portText === undefined ? 514 : Number(portText);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new AuditSinkError(`invalid syslog target ${JSON.stringify(target)}`);
  }
  return { kind: 'udp', host, port };
}

// The injectable syslog transport (issue #286): one RFC 5424 line per
// call, synchronously (`appendAudit` refuses async sinks). Prod transports
// (unix datagram, UDP) live in `syslog-transport.ts` — this module stays
// socket-free so its tests never touch the network.
export interface SyslogTransport {
  send(line: string): void;
}

export interface SyslogSinkOptions {
  transport: SyslogTransport;
  facility?: string | number;
  appName?: string;
  hostname?: string;
}

// One record → one RFC 5424 line:
// `<PRI>1 <record.when> <host> <app> <worker.pid> - - <record JSON>`.
// The acting pid (not the sender's) rides the PID field so the line names
// who acted; severity is info for `ok`, warning for `deny`/`error`. The
// record arrives already redacted — redaction is the ledger's job, not the
// wire's — so the MSG is the record JSON verbatim.
export function createSyslogSink(options: SyslogSinkOptions): AuditSink {
  const facility = resolveSyslogFacility(options.facility);
  const appName = options.appName ?? 'kubic';
  const host = options.hostname ?? hostname();
  const name = `syslog:${options.facility ?? 'local0'}`;
  return {
    name,
    kind: 'syslog',
    write: (record: OrgAuditRecord): void => {
      const severity = record.result === 'ok' ? 6 : 4;
      const priority = facility * 8 + severity;
      options.transport.send(
        `<${priority}>1 ${record.when} ${host} ${appName} ${record.worker.pid} - - ${JSON.stringify(record)}`,
      );
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
  if (
    record.agent.parent !== undefined &&
    typeof record.agent.parent !== 'string'
  ) {
    throw new AuditSinkError(
      "audit record 'agent.parent' must be a string when present",
    );
  }
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

// Deep copy for sink fan-out: the record is JSON-safe by construction
// (validated strings and integers only), so a round-trip clone keeps sinks
// from sharing one mutable record — a sink must never rewrite what other
// sinks store or what emitAudit returns to the caller.
function cloneAuditRecord(record: OrgAuditRecord): OrgAuditRecord {
  return JSON.parse(JSON.stringify(record)) as OrgAuditRecord;
}
// Loud append: every sink must accept the record synchronously. Any failure
// — a throw, a returned thenable (async sinks are refused: records must be
// durable before emitAudit returns), or zero sinks — throws AuditSinkError
// naming the failed sinks. Records are never silently lost.
// The `secrets` inventory defaults to [] by design (not an oversight):
// direct callers that withhold it still get shape-only redaction of failure
// messages via redactSecretShapes, but unshaped listed values cannot be
// redacted from error text — pass the inventory (emitAudit forwards
// options.secrets) whenever one exists.
export function appendAudit(
  sinks: AuditSink[],
  record: OrgAuditRecord,
  secrets: readonly string[] = [],
): void {
  if (sinks.length === 0) {
    throw new AuditSinkError(
      'no audit sinks: record would be silently lost',
      secrets,
    );
  }
  const failed: string[] = [];
  for (const sink of sinks) {
    try {
      // Each sink gets its own deep copy: a sink that mutates the record
      // only rewrites its private copy, never the stored or returned one.
      const outcome: unknown = sink.write(cloneAuditRecord(record));
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
    throw new AuditSinkError(
      `audit sink failure: ${failed.join('; ')}`,
      secrets,
    );
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

// Exactly-14 holds below the top level too (fix cycle 2): every nested
// section carries a fixed section-60 shape, so unknown nested keys are
// rejected fail-closed with AuditShapeError, never kept and persisted.
const ALLOWED_NESTED_AUDIT_KEYS: Record<string, readonly string[]> = {
  agent: ['session', 'role', 'parent'],
  model: ['provider', 'id', 'thinking'],
  worker: ['pid', 'generation', 'role'],
  workspace: ['path', 'base'],
  permission: ['permission', 'approval'],
  credential: ['sentinel'],
  network: ['host', 'port', 'decision', 'bytes'],
};

function rejectUnknownNestedKeys(input: AuditInput): void {
  const sections = input as Record<string, unknown>;
  for (const [section, allowed] of Object.entries(ALLOWED_NESTED_AUDIT_KEYS)) {
    const value = sections[section];
    if (value !== undefined && typeof value === 'object' && value !== null) {
      for (const key of Object.keys(value)) {
        if (!allowed.includes(key)) {
          throw new AuditShapeError(
            `audit record has unknown nested key '${section}.${key}': refused (exact section-60 shape)`,
          );
        }
      }
    }
  }
}

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
  rejectUnknownNestedKeys(input);
  const record: OrgAuditRecord = {
    ...input,
    when: input.when ?? new Date(options.now?.() ?? Date.now()).toISOString(),
  };
  validateRecord(record, options.secrets ?? []);
  appendAudit(sinks, record, options.secrets ?? []);
  return record;
}

export interface AuditQuery {
  mode?: AuditMode;
  posture?: string;
  result?: AuditResult;
  /**
   * An ORCHESTRATION session id (issue #159; §23): matches the run's own rows
   * (`agent.session` is the run) and every worker it spawned (`agent.session`
   * is the worker's `<orch>-<agent>`, `agent.parent` is the run) — so one
   * filter reads a whole run's decisions.
   */
  session?: string;
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
      (query.result === undefined || record.result === query.result) &&
      (query.session === undefined ||
        record.agent.session === query.session ||
        record.agent.parent === query.session),
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
