// The configured audit sinks: building them from `[[audit]]` tables, probing
// their targets, and what `kubic doctor` reports about them.

import { basename, dirname } from 'node:path';
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
} from './audit.js';
import type { auditSinkSnapshot, ConfiguredAuditSink } from './ledger.js';
import { appendAuditLine, probeMessage } from './ledger.js';
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
// the EXACT target path (unlike the repo ledger, which owns its filename),
// appended durably and created private like the repo ledger: the parent is
// created when missing.
function createTargetFileSink(target: string): AuditSink {
  const bridge = createNodeFileBridge(dirname(target));
  const file = basename(target);
  return {
    name: `file:${target}`,
    kind: 'file',
    write: (record: OrgAuditRecord): void => {
      appendAuditLine(bridge, file, record);
    },
  };
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
): import('../doctor/index.js').DoctorCheck[] {
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
