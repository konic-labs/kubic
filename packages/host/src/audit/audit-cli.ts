// `kubic audit [--posture p] [--result r] [--session id] [--since t] [--until
// t] [--format table|json|jsonl|csv]`. Query entry over org audit records:
// exact match on each supplied dimension and a time range; a table of the
// scanned fields for humans, the full records as JSON or JSON lines, or a CSV
// of the scanned fields for a spreadsheet. Records arrive injected; every
// printed record is redacted first, so query output never carries
// secret-shaped values or listed-secret inventory values — credentials stay
// sentinel-only.

import {
  type CommandResult,
  EXIT_FAILED,
  EXIT_OK,
  EXIT_USAGE,
} from '@kubic/core/cli/exit-codes';
import { createLineLogger } from '@kubic/core/cli/logger';
import { formatJson } from '@kubic/core/cli/output';
import { renderTable } from '@kubic/core/cli/table';
import { type CliTheme, createCliTheme } from '@kubic/core/cli/theme';
import { REDACTED_SECRET, redactSecretShapes } from '@kubic/core/secret-shapes';
import { type AuditResult, type OrgAuditRecord, queryAudits } from './audit.js';
import { type ChainVerification, verifyAuditChain } from './chain.js';
import type { AuditSinkFlush } from './ledger.js';

// The parsed `kubic audit` options (commander's `opts()`). `command` names a
// subcommand: `verify` checks the ledger's chain, `flush` drains the
// collector sinks' spools.
export interface AuditOptions {
  readonly command?: 'verify' | 'flush';
  readonly posture?: string;
  readonly result?: string;
  /** Filter on one session's rows. */
  readonly session?: string;
  /** Records at or after this time: ISO 8601, or `30m`/`24h`/`7d`/`2w` ago. */
  readonly since?: string;
  /** Records before this time, in the same forms. */
  readonly until?: string;
  readonly format?: string;
  readonly json?: boolean;
  /** `verify`: a chained `[[audit]] file` target instead of the repo ledger. */
  readonly file?: string;
}

const FORMATS = ['table', 'json', 'jsonl', 'csv'] as const;

const UNITS: Readonly<Record<string, number>> = {
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
  w: 604_800_000,
};

// An instant from ISO 8601 or a `<n><m|h|d|w>` age; undefined when neither.
function parseAuditTime(value: string, now: number): number | undefined {
  const age = /^(\d+)([mhdw])$/.exec(value.trim());
  if (age !== null) {
    return now - Number(age[1]) * (UNITS[age[2] as string] as number);
  }
  const at = Date.parse(value);
  return Number.isNaN(at) ? undefined : at;
}

// One CSV field: quoted when it must be, and a leading formula character
// defused so a spreadsheet shows the value instead of running it.
function csvField(value: string): string {
  const safe = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
  return /[",\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

const CSV_COLUMNS = [
  'when',
  'who',
  'what',
  'session',
  'role',
  'provider',
  'model',
  'posture',
  'permission',
  'approval',
  'result',
  'reason',
  'workspace',
] as const;

function csvOf(records: readonly OrgAuditRecord[]): string {
  const rows = records.map((record) =>
    [
      record.when,
      record.who,
      record.what,
      record.agent.session,
      record.agent.role,
      record.model.provider,
      record.model.id,
      record.posture,
      record.permission.permission,
      record.permission.approval,
      record.result,
      record.reason,
      record.workspace.path,
    ]
      .map(csvField)
      .join(','),
  );
  return [CSV_COLUMNS.join(','), ...rows].join('\n');
}

export interface AuditCommandDeps {
  loadRecords: () => OrgAuditRecord[] | Promise<OrgAuditRecord[]>;
  secrets?: readonly string[];
  // Prod secrets-inventory hook: the composition root passes its loader
  // here so the listed inventory reaches redaction end-to-end (fail-open
  // guard — omitting the inventory must never mean passthrough).
  loadSecrets?: () => readonly string[] | Promise<readonly string[]>;
  // stdout: the record table or the one `--json` document.
  out: (line: string) => void;
  // stderr: diagnostics, one `error: …` line each (core/cli/logger).
  err: (line: string) => void;
  // Clock seam for --since/--until ages; real runs use Date.now().
  now?: () => number;
  // Colour and the kit table for the human table; absent means plain.
  theme?: CliTheme;
  // Colour of the stderr diagnostics, from stderr's own TTY state (never
  // stdout's); absent means plain.
  errTheme?: CliTheme;
  fancy?: boolean;
}

const PLAIN = createCliTheme('none');

// The production listed-secret inventory. Nothing persists one, so it is
// empty; runAuditCommand already consults loadSecrets, so an inventory
// returned here reaches the report with no other change.
export function loadProdAuditSecrets(): readonly string[] {
  return [];
}

function isAuditResult(value: string): value is AuditResult {
  return value === 'ok' || value === 'deny' || value === 'error';
}

// Fail-closed query redaction: secret-shaped substrings plus every
// listed-secret inventory value become the fixed placeholder. Applied to
// the wire form so nested fields are covered, then parsed back so --json
// keeps the record shape.
function redactAuditRecord(
  record: OrgAuditRecord,
  secrets: readonly string[] = [],
): OrgAuditRecord {
  let text = redactSecretShapes(JSON.stringify(record));
  for (const secret of secrets) {
    if (secret === '') continue;
    if (text.includes(secret)) text = text.split(secret).join(REDACTED_SECRET);
  }
  return JSON.parse(text) as OrgAuditRecord;
}

// The human view: one table row per (already redacted) record over the
// fields an operator scans for; `--json` carries every field.
function auditTable(
  records: readonly OrgAuditRecord[],
  deps: AuditCommandDeps,
  theme: CliTheme,
): string {
  const resultCell = (result: AuditResult): string =>
    result === 'ok'
      ? theme.success(result)
      : result === 'deny'
        ? theme.warning(result)
        : theme.error(result);
  return renderTable(
    records.map((record) => [
      record.when,
      record.posture,
      resultCell(record.result),
      record.what,
      record.permission.permission,
      record.permission.approval,
      record.reason,
    ]),
    [
      { header: 'WHEN' },
      { header: 'POSTURE' },
      { header: 'RESULT' },
      { header: 'WHAT' },
      { header: 'PERMISSION' },
      { header: 'APPROVAL' },
      { header: 'REASON' },
    ],
    { fancy: deps.fancy === true, theme },
  );
}

// `kubic audit` over parsed options: commander (apps/kubic/src/commands/
// analysis.ts) owns argv syntax — unknown flags, missing filter values,
// `--help`; this handler owns result validation (with the fail-closed
// secret-shaped echo) and the redacted query.
export async function runAuditCommand(
  options: AuditOptions,
  deps: AuditCommandDeps,
): Promise<CommandResult> {
  const requested =
    options.format ?? (options.json === true ? 'json' : 'table');
  const format = FORMATS.find((name) => name === requested);
  const plain = format !== 'table';
  const theme = plain ? PLAIN : (deps.theme ?? PLAIN);
  const log = createLineLogger(deps.err, {
    theme: plain ? PLAIN : (deps.errTheme ?? PLAIN),
  });
  if (format === undefined) {
    log.error(
      redactSecretShapes(
        `unknown format ${JSON.stringify(options.format)} (want ${FORMATS.join('|')})`,
      ),
    );
    return { exitCode: EXIT_USAGE };
  }
  if (options.json === true && format !== 'json') {
    log.error(`--json and --format ${format} ask for two different outputs`);
    return { exitCode: EXIT_USAGE };
  }
  let result: AuditResult | undefined;
  if (options.result !== undefined) {
    if (!isAuditResult(options.result)) {
      log.error(
        redactSecretShapes(
          `unknown result ${JSON.stringify(options.result)} (want ok|deny|error)`,
        ),
      );
      return { exitCode: EXIT_USAGE };
    }
    result = options.result;
  }
  // A session filter is an id, never an empty value: `--session ''` (or a
  // whitespace-only one) would silently read as "no filter" or match nothing,
  // so it is refused like the other value-bearing filters.
  const session = options.session;
  if (session !== undefined && session.trim() === '') {
    log.error(
      redactSecretShapes(
        `unknown session ${JSON.stringify(options.session)} (want a session id)`,
      ),
    );
    return { exitCode: EXIT_USAGE };
  }
  const now = deps.now?.() ?? Date.now();
  const range: { since?: number; until?: number } = {};
  for (const flag of ['since', 'until'] as const) {
    const value = options[flag];
    if (value === undefined) continue;
    const at = parseAuditTime(value, now);
    if (at === undefined) {
      log.error(
        redactSecretShapes(
          `unknown time ${JSON.stringify(value)} for --${flag} (want ISO 8601, or an age such as 30m, 24h, 7d, 2w)`,
        ),
      );
      return { exitCode: EXIT_USAGE };
    }
    range[flag] = at;
  }
  // An unreadable ledger is a failure naming the file, never
  // an empty trail: "no audit records" would be a false all-clear.
  let records: OrgAuditRecord[];
  try {
    records = await deps.loadRecords();
  } catch (error) {
    log.error(
      redactSecretShapes(
        error instanceof Error ? error.message : String(error),
      ),
    );
    return { exitCode: EXIT_FAILED };
  }
  // Union of both inventory channels: an explicit list plus whatever the
  // injected loader returns — either source alone redacts.
  const secrets = [
    ...(deps.secrets ?? []),
    ...((await deps.loadSecrets?.()) ?? []),
  ];
  const filtered = queryAudits(records, {
    posture: options.posture,
    result,
    ...(session === undefined ? {} : { session }),
  }).filter((record) => {
    const at = Date.parse(record.when);
    return (
      (range.since === undefined || at >= range.since) &&
      (range.until === undefined || at < range.until)
    );
  });
  const redacted = filtered.map((record) => redactAuditRecord(record, secrets));
  if (format === 'json') {
    deps.out(formatJson(redacted));
    return { exitCode: EXIT_OK };
  }
  if (format === 'jsonl') {
    for (const record of redacted) deps.out(JSON.stringify(record));
    return { exitCode: EXIT_OK };
  }
  if (format === 'csv') {
    deps.out(csvOf(redacted));
    return { exitCode: EXIT_OK };
  }
  if (redacted.length === 0) {
    deps.out('no audit records');
    return { exitCode: EXIT_OK };
  }
  deps.out(auditTable(redacted, deps, theme));
  return { exitCode: EXIT_OK };
}

export interface AuditVerifyDeps {
  readonly out: (line: string) => void;
  readonly err: (line: string) => void;
  // The repo ledger `kubic audit verify` checks without `--file`.
  readonly ledgerPath: string;
}

// `kubic audit verify [--file <path>] [--json]`: walks the ledger's chain and
// names the first line it breaks at. Exit 0 when it holds, 1 when it does not
// (or the ledger cannot be read).
export function runAuditVerifyCommand(
  options: { readonly file?: string; readonly json?: boolean },
  deps: AuditVerifyDeps,
): CommandResult {
  const log = createLineLogger(deps.err);
  const path = options.file ?? deps.ledgerPath;
  let verified: ChainVerification;
  try {
    verified = verifyAuditChain(path);
  } catch (error) {
    log.error(
      `cannot read the audit ledger ${path}: ${error instanceof Error ? error.message : String(error)}`,
    );
    return { exitCode: EXIT_FAILED };
  }
  if (options.json === true) {
    deps.out(formatJson(verified));
    return { exitCode: verified.ok ? EXIT_OK : EXIT_FAILED };
  }
  if (!verified.ok && verified.problem !== undefined) {
    log.error(
      `audit ledger ${path}: line ${verified.problem.line} ${verified.problem.message}`,
    );
    return { exitCode: EXIT_FAILED };
  }
  deps.out(
    verified.records === 0
      ? `audit ledger ${path}: no records`
      : `audit ledger ${path}: intact — ${verified.records} record(s)${
          verified.unchained === 0
            ? ''
            : `, the first ${verified.unchained} written before the chain began`
        }${verified.head === undefined ? '' : `, head ${verified.head}`}`,
  );
  if (verified.note !== undefined) log.warn(verified.note);
  return { exitCode: EXIT_OK };
}

// `kubic audit flush`: drains the collector sinks' spools now. Exit 0 when
// nothing waits afterwards, 1 when a collector still has not taken records.
export async function runAuditFlushCommand(deps: {
  readonly out: (line: string) => void;
  readonly err: (line: string) => void;
  readonly flush: () => Promise<readonly AuditSinkFlush[]>;
}): Promise<CommandResult> {
  const log = createLineLogger(deps.err);
  const flushed = await deps.flush();
  if (flushed.length === 0) {
    deps.out('no collector sinks configured: nothing is spooled');
    return { exitCode: EXIT_OK };
  }
  for (const sink of flushed) {
    deps.out(
      `${sink.source}: delivered ${sink.delivered}, ${sink.pending} waiting`,
    );
    if (sink.error !== undefined) log.warn(`${sink.source}: ${sink.error}`);
  }
  return {
    exitCode: flushed.every((sink) => sink.pending === 0)
      ? EXIT_OK
      : EXIT_FAILED,
  };
}
