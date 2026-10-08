// The durable audit ledger: ONE record format (OrgAuditRecord, 13 fields) in
// ONE append-only JSONL file per repo, written through emitAudit's
// validation and read back by `kubic audit`.
//
// Location: <repo>/.kubic/audit/audit.jsonl, which the shipped runtime
// ignore rules (`.kubic/audit/`) keep out of the user's commit path.
//
// File access goes through the exec FileBridge (I/O confinement).

import { basename, dirname, join, resolve } from 'node:path';
import type { RunMode } from '../../../agents/src/policy.js';
import { redactSecretShapes } from '../../../core/src/secret-shapes.js';
import { createNodeFileBridge } from '../../../exec/src/file-bridge.js';
import type { AuditTableConfig } from '../config/config.js';
import { matchableSecrets } from '../config/secrets.js';
import {
  type AuditInput,
  type AuditSink,
  createMemorySink,
  createSyslogSink,
  emitAudit,
  type OrgAuditRecord,
  parseSyslogTarget,
  type SyslogTarget,
  type SyslogTransport,
  toCredentialSentinel,
} from './audit.js';
import {
  createUdpSyslogTransport,
  createUnixSyslogTransport,
} from './syslog-transport.js';

export const AUDIT_LEDGER_FILE = 'audit.jsonl';

// The ledger's directory for a repo root.
export function auditLedgerDir(repoRoot: string): string {
  return join(repoRoot, '.kubic', 'audit');
}

// The repo runtime root for a working directory: the MAIN
// checkout's toplevel — what `git rev-parse --path-format=absolute
// --git-common-dir` names the parent of — so a run from a subdirectory or a
// linked worktree resolves to the one directory `kubic audit` reads. Resolved from the filesystem (no git spawn): the
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

// The base revision a solo run started from: `git rev-parse
// HEAD` in the WORKSPACE, captured ONCE at run start — `none` outside git
// or when git cannot run. Best-effort by contract: a failed probe is never a
// run failure, and the record then honestly says `none`. The workspace
// travels as `git -C`, never as the spawn's own cwd: the composition root's
// shell is pinned to its env dir, which is not necessarily this run's
// workspace. The runner is that shell spawn, waited: `((cmd, args) =>
// env.shell.spawn(cmd, args, { provenance }).wait())`.
export async function resolveRunBaseRevision(
  workspace: string,
  run: (
    cmd: string,
    args: string[],
  ) => Promise<{
    exitCode: number;
    stdout: string;
  }>,
): Promise<string> {
  try {
    const done = await run('git', ['-C', workspace, 'rev-parse', 'HEAD']);
    const sha = done.stdout.trim();
    if (done.exitCode === 0 && sha !== '') return sha;
  } catch {
    // Not a repo, no git binary, or a spawn failure: `none` below.
  }
  return 'none';
}

// A synchronous file sink: one validated record per line. appendAudit
// refuses async sinks, so the append completes before emitAudit returns.
function createLedgerSink(dir: string): AuditSink {
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
    typeof record.posture === 'string' &&
    (record.result === 'ok' ||
      record.result === 'deny' ||
      record.result === 'error')
  );
}

// A ledger that exists but cannot be read (permission denied, a directory in
// its place, an I/O error) — named, so `kubic audit` never reports it as an
// empty trail.
class AuditLedgerReadError extends Error {
  readonly path: string;
  constructor(path: string, cause: unknown) {
    super(
      `cannot read the audit ledger ${path}: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
    this.name = 'AuditLedgerReadError';
    this.path = path;
  }
}

// Every audit record in the ledger, oldest first. A missing ledger (ENOENT) is
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

// Placeholder for a field the recording site genuinely does not know.
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

type Verdict =
  | { approved: true; by: string }
  | { approved: false; reason: string };

function verdictFields(verdict: Verdict): {
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

// Audit record for a solo approval decision (the in-process lane's ask).
export interface SoloDecisionInput {
  sessionId: string;
  toolName: string;
  trigger: string;
  workspace: string;
  model?: string;
  thinking?: string;
  /**
   * The base revision the run started from: `git rev-parse
   * HEAD` captured once at run start, `none` outside git. Absent keeps the
   * honest `unknown`.
   */
  base?: string;
  approved: boolean;
  by?: string;
  reason?: string;
  /** An approval's recorded note (an edited command). */
  note?: string;
  posture: string;
}

export function soloDecisionAudit(input: SoloDecisionInput): AuditInput {
  const { approval, result, reason } = verdictFields(
    input.approved
      ? { approved: true, by: input.by ?? 'user' }
      : { approved: false, reason: input.reason ?? 'denied' },
  );
  // An approval's own note (an edited command names both) is
  // its recorded reason.
  const recorded =
    input.approved && input.note !== undefined ? input.note : reason;
  return {
    who: 'agent:root',
    what: `tool:${input.toolName || UNKNOWN}`,
    agent: { session: input.sessionId || UNKNOWN, role: 'root' },
    model: { ...parseModel(input.model), thinking: input.thinking || UNKNOWN },
    worker: { pid: process.pid, generation: 0, role: 'root' },
    workspace: {
      path: input.workspace || UNKNOWN,
      base: input.base ?? UNKNOWN,
    },
    permission: { permission: `trigger:${input.trigger || UNKNOWN}`, approval },
    credential: { sentinel: 'none' },
    network: { ...NO_NETWORK },
    posture: input.posture,
    result,
    reason: recorded,
  };
}

// The privileged actions: the closed set of user-level
// operations beyond approval decisions that each emit one OrgAuditRecord
// with the same provenance block as decisions. full-access-grant writes
// `posture:full-access` (fullAccessEnabledAudit); undo-restore writes
// `undo-restore` (undoRestoreAudit).
export const PRIVILEGED_ACTION_KINDS = [
  'full-access-grant',
  'undo-restore',
] as const;

// The `level = "privileged"` filter: a `[[audit]]` sink
// at the privileged level keeps approval decisions (`tool:<name>`) and the
// privileged-action whats, and drops the rest (`credential:<provider>`).
// The repo ledger always keeps everything — the level only gates
// configured sinks.
export function isPrivilegedAuditWhat(what: string): boolean {
  return (
    what.startsWith('tool:') ||
    // The run-start row is a decision-grade record (it names
    // the autonomous combination), not a privileged ACTION — the action
    // kinds stay closed.
    what === 'run:start' ||
    what === 'posture:full-access' ||
    // Review finding: the revoke half of a privileged
    // posture change reaches privileged sinks too — the disable half of
    // a grant must never vanish while the grant is kept.
    what === 'posture:approvals' ||
    what === 'undo-restore'
  );
}

export type AuditSinkLevel = 'privileged' | 'all';

export interface ConfiguredAuditSink {
  sink: AuditSink;
  level: AuditSinkLevel;
  // The `[[audit]]` table this sink was built from (`audit[1]`), naming
  // the source in sink-failure notes and the doctor report.
  source: string;
  failures: string[];
  stderrNoted: boolean;
}

// The process's configured `[[audit]]` sinks: empty means the
// repo ledger only (current behavior). The composition root sets them once
// per process from the loaded config; tests reset with `setAuditSinks([])`.
let configuredAuditSinks: ConfiguredAuditSink[] = [];

export function setAuditSinks(sinks: ConfiguredAuditSink[]): void {
  configuredAuditSinks = [...sinks];
}

// A read-only snapshot for the doctor probe: the configured sources and
// the failures they recorded this process.
export function auditSinkSnapshot(): ReadonlyArray<{
  source: string;
  kind: string;
  name: string;
  level: AuditSinkLevel;
  failures: readonly string[];
}> {
  return configuredAuditSinks.map((entry) => ({
    source: entry.source,
    kind: entry.sink.kind,
    name: entry.sink.name,
    level: entry.level,
    failures: [...entry.failures],
  }));
}

export interface BuiltAuditSinks {
  sinks: ConfiguredAuditSink[];
  // Invalid tables are never built and never throw here: each problem names
  // its table, so `kubic doctor` can report it instead of the process
  // dying before doctor runs.
  problems: string[];
}

// Build the process's configured sinks from parsed `[[audit]]` tables.
// `syslogTransport` injects the syslog wire for tests — prod builds real
// transports from the target (unix socket path, defaulting per platform, or
// `host[:port]` UDP defaulting to 514).
export function buildConfiguredSinks(
  tables: readonly AuditTableConfig[],
  overrides: { syslogTransport?: SyslogTransport } = {},
): BuiltAuditSinks {
  const sinks: ConfiguredAuditSink[] = [];
  const problems: string[] = [];
  tables.forEach((table, index) => {
    const source = `audit[${index + 1}]`;
    const level = table.level;
    if (level !== 'privileged' && level !== 'all') {
      problems.push(`${source}: invalid level ${JSON.stringify(level)}`);
      return;
    }
    if (table.sink === 'syslog') {
      let target: SyslogTarget;
      try {
        target = parseSyslogTarget(table.target);
      } catch (error) {
        problems.push(`${source}: ${probeMessage(error)}`);
        return;
      }
      let transport = overrides.syslogTransport;
      if (transport === undefined) {
        transport =
          target.kind === 'unix'
            ? createUnixSyslogTransport(target.path)
            : createUdpSyslogTransport(target.host, target.port);
      }
      let sink: AuditSink;
      try {
        sink = createSyslogSink({
          transport,
          facility: table.facility,
        });
      } catch (error) {
        problems.push(`${source}: ${probeMessage(error)}`);
        return;
      }
      sinks.push({ sink, level, source, failures: [], stderrNoted: false });
      return;
    }
    if (table.sink === 'file') {
      if (table.target === undefined || table.target === '') {
        problems.push(`${source}: sink "file" needs a target path`);
        return;
      }
      sinks.push({
        sink: createTargetFileSink(table.target),
        level,
        source,
        failures: [],
        stderrNoted: false,
      });
      return;
    }
    if (table.sink === 'memory') {
      if (table.target !== undefined) {
        problems.push(
          `${source}: sink "memory" takes no target (got ${JSON.stringify(table.target)})`,
        );
        return;
      }
      sinks.push({
        sink: createMemorySink(source),
        level,
        source,
        failures: [],
        stderrNoted: false,
      });
      return;
    }
    problems.push(`${source}: unknown sink kind ${JSON.stringify(table.sink)}`);
  });
  return { sinks, problems };
}

// A `[[audit]] file` sink: one validated record per line at
// the EXACT target path (unlike the repo ledger, which owns its filename).
// Fail-open dirs like the repo ledger: the parent is created when missing.
function createTargetFileSink(target: string): AuditSink {
  const bridge = createNodeFileBridge(dirname(target));
  const file = basename(target);
  return {
    name: `file:${target}`,
    kind: 'file',
    write: (record: OrgAuditRecord): void => {
      if (!bridge.exists('.')) bridge.createDir('.', true);
      bridge.appendFile(file, `${JSON.stringify(record)}\n`);
    },
  };
}

function probeMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export interface AuditSinkProbes {
  socketExists(path: string): boolean;
  udpAvailable(): boolean;
}

// One syslog target's reachability: unix sockets must exist,
// UDP needs a creatable socket (connectionless — delivery stays
// best-effort). Garbage targets fail closed.
export function isSyslogTargetAvailable(
  target: string | undefined,
  probes: AuditSinkProbes,
): boolean {
  let parsed: SyslogTarget;
  try {
    parsed = parseSyslogTarget(target);
  } catch {
    return false;
  }
  if (parsed.kind === 'unix') return probes.socketExists(parsed.path);
  return probes.udpAvailable();
}

export interface AuditSinkDoctorInput {
  tables: readonly AuditTableConfig[];
  problems: readonly string[];
  snapshot: ReturnType<typeof auditSinkSnapshot>;
  probes: AuditSinkProbes;
}

// The `[[audit]]` doctor report: one check per configured
// table — reachable sinks pass naming target and level, missing sockets
// and unbuilt tables fail — plus the runtime failures the process recorded
// (`audit:sink:<kind>`). No tables means no checks, so the default matrix
// is unchanged.
export function auditSinksDoctorChecks(
  input: AuditSinkDoctorInput,
): import('../doctor.js').DoctorCheck[] {
  const { tables, problems, snapshot, probes } = input;
  const failuresBySource = new Map<string, readonly string[]>();
  for (const entry of snapshot) {
    if (entry.failures.length > 0) {
      failuresBySource.set(entry.source, entry.failures);
    }
  }
  return tables.map((table, index) => {
    const source = `audit[${index + 1}]`;
    const id = `audit:sink:${table.sink}-${index + 1}`;
    const label = `audit sink ${table.sink}`;
    const level = table.level ?? 'privileged';
    const problem = problems.find((entry) => entry.startsWith(`${source}:`));
    if (problem !== undefined) {
      return {
        id,
        label,
        status: 'fail' as const,
        reason: 'sink-unreachable' as const,
        detail: `${source} not built: ${problem.slice(source.length + 2)}`,
      };
    }
    const failures = failuresBySource.get(source);
    if (failures !== undefined) {
      return {
        id,
        label,
        status: 'fail' as const,
        reason: 'sink-unreachable' as const,
        detail: `${source} recorded ${failures.length} failure(s) this process: ${failures[failures.length - 1]}`,
      };
    }
    if (table.sink === 'syslog') {
      let target: SyslogTarget;
      try {
        target = parseSyslogTarget(table.target);
      } catch (error) {
        return {
          id,
          label,
          status: 'fail' as const,
          reason: 'sink-unreachable' as const,
          detail: `${source}: ${probeMessage(error)}`,
        };
      }
      if (target.kind === 'unix') {
        if (!probes.socketExists(target.path)) {
          return {
            id,
            label,
            status: 'fail' as const,
            reason: 'sink-unreachable' as const,
            detail: `${source} syslog socket missing: ${target.path} (${level})`,
          };
        }
        return {
          id,
          label,
          status: 'pass' as const,
          reason: 'ok' as const,
          detail: `${source} syslog unix:${target.path} (${level})`,
        };
      }
      if (!probes.udpAvailable()) {
        return {
          id,
          label,
          status: 'fail' as const,
          reason: 'sink-unreachable' as const,
          detail: `${source} syslog UDP unavailable for ${target.host}:${target.port} (${level})`,
        };
      }
      return {
        id,
        label,
        status: 'pass' as const,
        reason: 'ok' as const,
        // UDP is connectionless: reachable means routable here, delivery
        // stays best-effort by protocol design.
        detail: `${source} syslog udp:${target.host}:${target.port} (${level}; delivery best-effort)`,
      };
    }
    if (table.sink === 'file') {
      return {
        id,
        label,
        status: 'pass' as const,
        reason: 'ok' as const,
        detail: `${source} file appends ${table.target} (${level})`,
      };
    }
    if (table.sink === 'memory') {
      return {
        id,
        label,
        status: 'pass' as const,
        reason: 'ok' as const,
        detail: `${source} memory sink, process-scoped (${level})`,
      };
    }
    return {
      id,
      label,
      status: 'fail' as const,
      reason: 'sink-unreachable' as const,
      detail: `${source}: unknown sink kind ${JSON.stringify(table.sink)}`,
    };
  });
}

// Audit record for a journal undo restore: the user-level act of
// putting files back. restored names the restored paths, skipped counts the
// steps left in place — a partial restore (exit 1) records 'error'.
export interface UndoRestoreInput {
  /** Absent for a workspace-scoped undo (no session) — records unknown. */
  sessionId?: string;
  workspace: string;
  base?: string;
  restored: string[];
  skipped?: number;
}

export function undoRestoreAudit(input: UndoRestoreInput): AuditInput {
  const skipped = input.skipped ?? 0;
  const files =
    input.restored.length === 1 ? '1 file' : `${input.restored.length} file(s)`;
  return {
    who: 'user:cli',
    what: 'undo-restore',
    agent: { session: input.sessionId || UNKNOWN, role: 'user' },
    model: { provider: UNKNOWN, id: UNKNOWN, thinking: UNKNOWN },
    worker: { pid: process.pid, generation: 0, role: 'user' },
    workspace: { path: input.workspace, base: input.base || UNKNOWN },
    permission: { permission: 'journal:undo', approval: 'user command' },
    credential: { sentinel: 'none' },
    network: { ...NO_NETWORK },
    posture: 'approvals',
    result: skipped > 0 ? 'error' : 'ok',
    reason:
      `restored ${files}: ${input.restored.join(', ')}` +
      (skipped > 0 ? `; ${skipped} skipped` : ''),
  };
}

// Audit record for one credential use: the ref
// (as a sentinel), the role and the purpose — never the value.
export interface CredentialUseInput {
  sessionId: string;
  role: string;
  provider: string;
  ref: string;
  purpose: string;
  workspace: string;
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
    posture: 'credentials',
    result: 'ok',
    reason: input.purpose,
  };
}

// Audit record for switching a session to full access:
// who enabled it (the user, through the CLI), when, for which session, and
// through which command. One row per enable; the per-ask rows that follow
// carry posture 'full-access' on their own.
export interface FullAccessEnabledInput {
  sessionId: string;
  /** The originating command line, e.g. `kubic run --dangerously-skip-approvals`. */
  command: string;
  workspace: string;
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
    posture: 'full-access',
    result: 'ok',
    reason: `full access enabled for session ${input.sessionId || UNKNOWN} by ${input.command}`,
  };
}

// Audit record for a run's start: the mode the run
// resolved — explicit `--autonomous` or off by default — so the audit trail
// names the autonomous combination the session records. A run record, not a
// privileged action: it is kept at the privileged sink level beside the
// decisions, while PRIVILEGED_ACTION_KINDS stays the closed action set.
export interface RunStartInput {
  sessionId?: string;
  /** The originating command, e.g. `kubic run`. */
  command: string;
  /** The run's mode. */
  runMode: RunMode;
  workspace?: string;
  posture: string;
  /** Whether `--autonomous` was passed explicitly. */
  autonomous: boolean;
  /** The resolved worktree base revision: the caller passes
   *  its `runBase`; absent, the row stays honestly `unknown`. */
  base?: string;
}

export function runStartAudit(input: RunStartInput): AuditInput {
  const role = 'root';
  return {
    who: 'user:cli',
    what: 'run:start',
    agent: { session: input.sessionId || UNKNOWN, role },
    model: { provider: UNKNOWN, id: UNKNOWN, thinking: UNKNOWN },
    worker: { pid: process.pid, generation: 0, role },
    workspace: {
      path: input.workspace || UNKNOWN,
      base: input.base || UNKNOWN,
    },
    permission: {
      permission: 'run:start',
      approval: `started by ${input.command}`,
    },
    credential: { sentinel: 'none' },
    network: { ...NO_NETWORK },
    posture: input.posture,
    result: 'ok',
    reason:
      `run started in ${input.runMode} mode by ${input.command}` +
      (input.autonomous ? ' (--autonomous)' : ''),
  };
}

// audit record for switching a session BACK to enforced approvals: the TUI's
// in-session toggle off, the symmetric half of `fullAccessEnabledAudit`. One
// row per disable, so the ledger carries the whole posture history in order.
export interface FullAccessDisabledInput {
  sessionId: string;
  /** The originating action, e.g. `kubic tui /approvals off`. */
  command: string;
  workspace: string;
}

export function fullAccessDisabledAudit(
  input: FullAccessDisabledInput,
): AuditInput {
  return {
    who: 'user:tui',
    what: 'posture:approvals',
    agent: { session: input.sessionId || UNKNOWN, role: 'user' },
    model: { provider: UNKNOWN, id: UNKNOWN, thinking: UNKNOWN },
    worker: { pid: process.pid, generation: 0, role: 'user' },
    workspace: { path: input.workspace || UNKNOWN, base: UNKNOWN },
    permission: {
      permission: 'posture:approvals',
      approval: `disabled by ${input.command}`,
    },
    credential: { sentinel: 'none' },
    network: { ...NO_NETWORK },
    posture: 'approvals',
    result: 'ok',
    reason: `full access disabled for session ${input.sessionId || UNKNOWN} by ${input.command}`,
  };
}

// Audit record for a posture.json change made DURING a session:
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
    // credential-use row.
    // Configured `[[audit]]` sinks fan out beside the repo
    // ledger, which always leads and is mandatory: the `what` is checked
    // pre-redaction (a redacted `what` would never match the level filter).
    // A configured sink's failure is recorded on its entry and noted on
    // `onError` ONCE per process per sink — then swallowed, so a dead
    // syslog never blocks the repo write (or the action). A repo-ledger
    // failure still throws below and reaches `onError` every time.
    const privileged = isPrivilegedAuditWhat(input.what);
    const sinks: AuditSink[] = [createLedgerSink(dir)];
    for (const entry of configuredAuditSinks) {
      if (entry.level === 'privileged' && !privileged) continue;
      const configured = entry.sink;
      sinks.push({
        name: configured.name,
        kind: configured.kind,
        write: (record: OrgAuditRecord): void => {
          try {
            configured.write(record);
          } catch (error) {
            const message = probeMessage(error);
            entry.failures.push(message);
            if (!entry.stderrNoted) {
              entry.stderrNoted = true;
              onError(`audit sink '${entry.source}' failed: ${message}`);
            }
          }
        },
      });
    }
    return emitAudit(sinks, redactInput(input), {
      secrets: matchableSecrets(secrets),
    });
  } catch (error) {
    onError(error instanceof Error ? error.message : String(error));
    return undefined;
  }
}
