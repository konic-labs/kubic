// `kubic audit [--posture p] [--result r] [--session id] [--json]`
// (issue #79; §60). Query entry over org audit records: exact match on
// each supplied dimension; a table of the scanned fields for humans, the
// full records under --json. Records arrive
// injected (faux in tests — no audit persistence is wired yet); every
// printed record is redacted first, so query output never carries
// secret-shaped values or listed-secret inventory values — credentials
// stay sentinel-only.

import {
  EXIT_FAILED,
  EXIT_OK,
  EXIT_USAGE,
} from '../../../core/src/cli/exit-codes.js';
import { createLineLogger } from '../../../core/src/cli/logger.js';
import { formatJson } from '../../../core/src/cli/output.js';
import { renderTable } from '../../../core/src/cli/table.js';
import { type CliTheme, createCliTheme } from '../../../core/src/cli/theme.js';
import { type AuditResult, type OrgAuditRecord, queryAudits } from './audit.js';
import { REDACTED_SECRET, redactSecretShapes } from './secret-shapes.js';

// The parsed `kubic audit` options (commander's `opts()`).
export interface AuditOptions {
  readonly posture?: string;
  readonly result?: string;
  /** Filter on one session's rows. */
  readonly session?: string;
  readonly json?: boolean;
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
  // Colour and the kit table for the human table; absent means plain.
  theme?: CliTheme;
  // Colour of the stderr diagnostics, from stderr's own TTY state (never
  // stdout's); absent means plain.
  errTheme?: CliTheme;
  fancy?: boolean;
}

const PLAIN = createCliTheme('none');

// Prod listed-secret inventory (issue #79). Audit persistence is not wired
// yet, so this returns no values today; when persistence lands, return the
// inventory here — runAuditCommand already consults loadSecrets, so the
// prod path cannot forget it.
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
export function redactAuditRecord(
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
): Promise<number> {
  const json = options.json === true;
  const theme = json ? PLAIN : (deps.theme ?? PLAIN);
  const log = createLineLogger(deps.err, {
    theme: json ? PLAIN : (deps.errTheme ?? PLAIN),
  });
  let result: AuditResult | undefined;
  if (options.result !== undefined) {
    if (!isAuditResult(options.result)) {
      log.error(
        redactSecretShapes(
          `unknown result ${JSON.stringify(options.result)} (want ok|deny|error)`,
        ),
      );
      return EXIT_USAGE;
    }
    result = options.result;
  }
  // A session filter is an id, never an empty value: `--session ''` (or a
  // whitespace-only one) would silently read as "no filter" or match nothing,
  // so it is refused like the other value-bearing filters (issue #159).
  const session = options.session;
  if (session !== undefined && session.trim() === '') {
    log.error(
      redactSecretShapes(
        `unknown session ${JSON.stringify(options.session)} (want a session id)`,
      ),
    );
    return EXIT_USAGE;
  }
  // An unreadable ledger (issue #279) is a failure naming the file, never
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
    return EXIT_FAILED;
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
  });
  const redacted = filtered.map((record) => redactAuditRecord(record, secrets));
  if (json) {
    deps.out(formatJson(redacted));
    return EXIT_OK;
  }
  if (redacted.length === 0) {
    deps.out('no audit records');
    return EXIT_OK;
  }
  deps.out(auditTable(redacted, deps, theme));
  return EXIT_OK;
}
