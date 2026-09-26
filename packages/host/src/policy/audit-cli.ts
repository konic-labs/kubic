// `kubic audit [--mode m] [--posture p] [--result r] [--json]`
// (issue #79; §60). Query entry over org audit records: exact match on
// each supplied dimension, full 14-field records out. Records arrive
// injected (faux in tests — no audit persistence is wired yet); every
// printed record is redacted first, so query output never carries
// secret-shaped values or listed-secret inventory values — credentials
// stay sentinel-only.

import { answerHelp } from '../../../core/src/cli-help.js';
import { type FlagSpec, parseFlagArgs } from '../../../core/src/flags.js';
import {
  type AuditMode,
  type AuditResult,
  type OrgAuditRecord,
  queryAudits,
} from './audit.js';
import { REDACTED_SECRET, redactSecretShapes } from './secret-shapes.js';

export const AUDIT_EXIT_OK = 0;
export const AUDIT_EXIT_USAGE = 2;

export interface AuditCommandDeps {
  loadRecords: () => OrgAuditRecord[] | Promise<OrgAuditRecord[]>;
  secrets?: readonly string[];
  // Prod secrets-inventory hook: the composition root passes its loader
  // here so the listed inventory reaches redaction end-to-end (fail-open
  // guard — omitting the inventory must never mean passthrough).
  loadSecrets?: () => readonly string[] | Promise<readonly string[]>;
  out: (line: string) => void;
}

// Prod listed-secret inventory (issue #79). Audit persistence is not wired
// yet, so this returns no values today; when persistence lands, return the
// inventory here — runAuditCommand already consults loadSecrets, so the
// prod path cannot forget it.
export function loadProdAuditSecrets(): readonly string[] {
  return [];
}

export const AUDIT_USAGE =
  'usage: kubic audit [--mode <solo|orchestrator>] [--posture <name>] [--result <ok|deny|error>] [--json]';

function usage(out: (line: string) => void): number {
  out(AUDIT_USAGE);
  return AUDIT_EXIT_USAGE;
}

function isAuditMode(value: string): value is AuditMode {
  return value === 'solo' || value === 'orchestrator';
}

function isAuditResult(value: string): value is AuditResult {
  return value === 'ok' || value === 'deny' || value === 'error';
}

// Fail-closed query redaction: secret-shaped substrings plus every
// listed-secret inventory value become the fixed placeholder. Applied to
// the wire form so nested fields are covered, then parsed back so --json
// keeps the 14-field record shape.
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

// Issue #127: the shared parser replaces the hand-rolled loop. Missing
// values keep their `error: <flag> needs a value` line; unknown flags and
// stray operands keep the bare usage exit; mode/result validation stays
// this command's semantics (with the fail-closed secret-shaped echo).
const AUDIT_FLAG_SPEC: readonly FlagSpec[] = [
  { name: '--json', takes: 'boolean' },
  { name: '--mode', takes: 'value' },
  { name: '--posture', takes: 'value' },
  { name: '--result', takes: 'value' },
];

export async function runAuditCommand(
  args: string[],
  deps: AuditCommandDeps,
): Promise<number> {
  // `--help`/`-h` prints the usage line and exits 0 (issue #100).
  const help = answerHelp(args, deps.out, AUDIT_USAGE);
  if (help !== null) return help;
  const flags = parseFlagArgs(args, AUDIT_FLAG_SPEC);
  for (const flag of flags.missing) {
    deps.out(`error: ${flag} needs a value`);
    return usage(deps.out);
  }
  if (flags.unknown.length > 0 || flags.positional.length > 0) {
    return usage(deps.out);
  }
  const json = flags.values['--json'] === true;
  let mode: AuditMode | undefined;
  let result: AuditResult | undefined;
  const modeRaw = flags.values['--mode'] as string | undefined;
  if (modeRaw !== undefined) {
    if (!isAuditMode(modeRaw)) {
      deps.out(
        redactSecretShapes(`error: unknown mode ${JSON.stringify(modeRaw)}`),
      );
      return usage(deps.out);
    }
    mode = modeRaw;
  }
  const resultRaw = flags.values['--result'] as string | undefined;
  if (resultRaw !== undefined) {
    if (!isAuditResult(resultRaw)) {
      deps.out(
        redactSecretShapes(
          `error: unknown result ${JSON.stringify(resultRaw)}`,
        ),
      );
      return usage(deps.out);
    }
    result = resultRaw;
  }
  const posture = flags.values['--posture'] as string | undefined;
  const records = await deps.loadRecords();
  // Union of both inventory channels: an explicit list plus whatever the
  // injected loader returns — either source alone redacts.
  const secrets = [
    ...(deps.secrets ?? []),
    ...((await deps.loadSecrets?.()) ?? []),
  ];
  const filtered = queryAudits(records, { mode, posture, result });
  const redacted = filtered.map((record) => redactAuditRecord(record, secrets));
  if (json) {
    deps.out(JSON.stringify(redacted, null, 2));
    return AUDIT_EXIT_OK;
  }
  if (redacted.length === 0) {
    deps.out('no audit records');
    return AUDIT_EXIT_OK;
  }
  for (const record of redacted) {
    deps.out(JSON.stringify(record));
  }
  return AUDIT_EXIT_OK;
}
