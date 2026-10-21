// The configured audit sinks: building them from `[[audit]]` tables, probing
// their targets, and what `kubic doctor` reports about them.

import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { createNodeFileBridge } from '@kubic/exec/file-bridge';
import type { AuditTableConfig } from '../config/index.js';
import type {
  AuditSink,
  OrgAuditRecord,
  SyslogTarget,
  SyslogTransport,
} from './audit.js';
import {
  createMemorySink,
  createSyslogSink,
  parseSyslogTarget,
  syslogLineFormat,
} from './audit.js';
import { appendChainedAuditLine } from './chain.js';
import {
  checkCollectorUrl,
  deliverSyslogStream,
  otlpLogsBody,
  postJson,
} from './collectors.js';
import type { auditSinkSnapshot, ConfiguredAuditSink } from './ledger.js';
import { probeMessage } from './ledger.js';
import { createSpooledSink, type SpooledSink } from './spool.js';
import {
  createUdpSyslogTransport,
  createUnixSyslogTransport,
} from './syslog-transport.js';

export interface BuiltAuditSinks {
  sinks: ConfiguredAuditSink[];
  // Invalid tables are never built and never throw here: each problem names
  // its table, so `kubic doctor` can report it instead of the process
  // dying before doctor runs.
  problems: string[];
}

/** Where the collector sinks keep the records they could not deliver yet. */
function defaultAuditSpoolDir(): string {
  return join(homedir(), '.kubic', 'audit-spool');
}

export interface AuditSinkOverrides {
  // The syslog wire for the unix and UDP targets (tests).
  readonly syslogTransport?: SyslogTransport;
  // The spool directory of the collector sinks. Absent:
  // `~/.kubic/audit-spool/`.
  readonly spoolDir?: string;
  readonly env?: Record<string, string | undefined>;
}

// The collector a network sink delivers to: its spool identity and how one
// batch of records reaches it. Throws a named problem for a table it cannot
// build (an unreadable `ca`, an unset `tokenEnv`, an insecure URL).
function collectorFor(
  table: AuditTableConfig,
  target: SyslogTarget | undefined,
  env: Record<string, string | undefined>,
): {
  identity: string;
  deliver: (records: readonly OrgAuditRecord[]) => Promise<void>;
} {
  const ca =
    table.ca === undefined
      ? undefined
      : (() => {
          try {
            return createNodeFileBridge('/').readTextFile(table.ca);
          } catch (error) {
            throw new Error(
              `cannot read ca ${table.ca}: ${probeMessage(error)}`,
            );
          }
        })();
  if (
    table.sink === 'syslog' &&
    target !== undefined &&
    target.kind !== 'unix' &&
    target.kind !== 'udp'
  ) {
    const format = syslogLineFormat({ facility: table.facility });
    return {
      identity: `syslog ${target.kind}://${target.host}:${target.port}`,
      deliver: (records) =>
        deliverSyslogStream(
          {
            host: target.host,
            port: target.port,
            tls: target.kind === 'tls',
            ...(ca === undefined ? {} : { ca }),
          },
          records.map(format),
        ),
    };
  }
  if (table.target === undefined || table.target === '') {
    throw new Error(`sink "${table.sink}" needs a target URL`);
  }
  const url = checkCollectorUrl(table.target).toString();
  let headers: Record<string, string> = {};
  if (table.tokenEnv !== undefined) {
    const token = env[table.tokenEnv];
    if (token === undefined || token === '') {
      throw new Error(`tokenEnv ${table.tokenEnv} is not set`);
    }
    headers = { authorization: `Bearer ${token}` };
  }
  const collector = { url, headers, ...(ca === undefined ? {} : { ca }) };
  return {
    identity: `${table.sink} ${url}`,
    deliver: (records) =>
      postJson(
        collector,
        table.sink === 'otlp' ? otlpLogsBody(records) : { records },
      ),
  };
}

// A spooled collector sink, or the problem that keeps it from being built.
function spooledSink(
  table: AuditTableConfig,
  target: SyslogTarget | undefined,
  overrides: AuditSinkOverrides,
  failures: string[],
): SpooledSink {
  const collector = collectorFor(table, target, overrides.env ?? process.env);
  return createSpooledSink({
    name: collector.identity,
    kind: table.sink as SpooledSink['kind'],
    identity: collector.identity,
    spoolDir: overrides.spoolDir ?? defaultAuditSpoolDir(),
    deliver: collector.deliver,
    onError: (message) => failures.push(`${message} (kept in the spool)`),
  });
}

// Build the process's configured sinks from parsed `[[audit]]` tables.
// `syslogTransport` injects the syslog wire for tests — prod builds real
// transports from the target (a unix socket path, defaulting per platform and
// reached through the system logger, or `host[:port]` UDP defaulting to 514).
// A `tcp://` or `tls://` syslog target, an `https` sink and an `otlp` sink
// deliver through a durable spool (spool.ts). A transport's asynchronous
// delivery failures land on the sink's own failure list, which the ledger
// notes and doctor reports.
export function buildConfiguredSinks(
  tables: readonly AuditTableConfig[],
  overrides: AuditSinkOverrides = {},
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
    if (table.sink === 'https' || table.sink === 'otlp') {
      const failures: string[] = [];
      try {
        const sink = spooledSink(table, undefined, overrides, failures);
        sinks.push({ sink, level, source, failures, stderrNoted: false });
      } catch (error) {
        problems.push(`${source}: ${probeMessage(error)}`);
      }
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
      if (target.kind === 'tcp' || target.kind === 'tls') {
        const failures: string[] = [];
        try {
          const sink = spooledSink(table, target, overrides, failures);
          sinks.push({ sink, level, source, failures, stderrNoted: false });
        } catch (error) {
          problems.push(`${source}: ${probeMessage(error)}`);
        }
        return;
      }
      const failures: string[] = [];
      const onError = (message: string): void => {
        failures.push(message);
      };
      let sink: AuditSink;
      try {
        const transport =
          overrides.syslogTransport ??
          (target.kind === 'unix'
            ? createUnixSyslogTransport(target.path, { onError })
            : createUdpSyslogTransport(target.host, target.port, { onError }));
        sink = createSyslogSink({
          transport,
          facility: table.facility,
        });
      } catch (error) {
        problems.push(`${source}: ${probeMessage(error)}`);
        return;
      }
      sinks.push({ sink, level, source, failures, stderrNoted: false });
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
// the EXACT target path (unlike the repo ledger, which owns its filename),
// chained and appended durably, and created private like the repo ledger:
// the parent is created when missing.
function createTargetFileSink(target: string): AuditSink {
  const bridge = createNodeFileBridge(dirname(target));
  const file = basename(target);
  return {
    name: `file:${target}`,
    kind: 'file',
    write: (record: OrgAuditRecord): void => {
      appendChainedAuditLine(bridge, dirname(target), file, record);
    },
  };
}

export interface AuditSinkProbes {
  /** Whether the path is a unix domain socket. */
  socketExists(path: string): boolean;
  udpAvailable(): boolean;
  /** Why the system logger cannot reach the socket; undefined when it can. */
  unixTransportProblem(path: string): string | undefined;
}

// One syslog target's reachability: a unix target must be a socket the
// system logger can reach, UDP needs a creatable socket (connectionless —
// delivery stays best-effort). Garbage targets fail closed.
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
  if (parsed.kind === 'unix') {
    return (
      probes.socketExists(parsed.path) &&
      probes.unixTransportProblem(parsed.path) === undefined
    );
  }
  // A stream collector delivers through its spool: no record waits on it.
  if (parsed.kind === 'tcp' || parsed.kind === 'tls') return true;
  return probes.udpAvailable();
}

// A spooled collector's check: pass while its spool is empty, a warning
// naming how many records wait while the collector has not taken them.
function collectorCheck(
  base: { id: string; label: string; source: string; level: string },
  where: string,
  pending: number | undefined,
): import('../doctor/index.js').DoctorCheck {
  const waiting = pending ?? 0;
  return waiting === 0
    ? {
        id: base.id,
        label: base.label,
        status: 'pass',
        reason: 'ok',
        detail: `${base.source} ${where} (${base.level}; spooled on disk until delivered)`,
      }
    : {
        id: base.id,
        label: base.label,
        status: 'warn',
        reason: 'sink-unreachable',
        detail: `${base.source} ${where} (${base.level}): ${waiting} record(s) wait in the spool — the collector has not taken them yet; \`kubic audit flush\` retries`,
      };
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
): import('../doctor/index.js').DoctorCheck[] {
  const { tables, problems, snapshot, probes } = input;
  const failuresBySource = new Map<string, readonly string[]>();
  const pendingBySource = new Map<string, number>();
  for (const entry of snapshot) {
    if (entry.failures.length > 0) {
      failuresBySource.set(entry.source, entry.failures);
    }
    if (entry.pending !== undefined) {
      pendingBySource.set(entry.source, entry.pending);
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
    const pending = pendingBySource.get(source);
    if (table.sink === 'https' || table.sink === 'otlp') {
      return collectorCheck(
        { id, label, source, level },
        `${table.sink} ${table.target ?? ''}`,
        pending,
      );
    }
    const failures = failuresBySource.get(source);
    if (failures !== undefined && pending === undefined) {
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
      if (target.kind === 'tcp' || target.kind === 'tls') {
        return collectorCheck(
          { id, label, source, level },
          `syslog ${target.kind}://${target.host}:${target.port}`,
          pending,
        );
      }
      if (target.kind === 'unix') {
        if (!probes.socketExists(target.path)) {
          return {
            id,
            label,
            status: 'fail' as const,
            reason: 'sink-unreachable' as const,
            detail: `${source} syslog socket missing (or not a socket): ${target.path} (${level})`,
          };
        }
        const problem = probes.unixTransportProblem(target.path);
        if (problem !== undefined) {
          return {
            id,
            label,
            status: 'fail' as const,
            reason: 'sink-unreachable' as const,
            detail: `${source} ${problem} (${level})`,
          };
        }
        return {
          id,
          label,
          status: 'pass' as const,
          reason: 'ok' as const,
          detail: `${source} syslog unix:${target.path} through the system logger (${level})`,
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
