// `kubic audit [--mode m] [--posture p] [--result r] [--json]`
// (issue #79; §60). Query entry over org audit records: exact match on
// each supplied dimension, full 14-field records out. Records arrive
// injected (faux in tests — no audit persistence is wired yet); every
// printed record is redacted first, so query output never carries
// secret-shaped values or listed-secret inventory values — credentials
// stay sentinel-only.

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
  out: (line: string) => void;
}

function usage(out: (line: string) => void): number {
  out(
    'usage: kubic audit [--mode <solo|orchestrator>] [--posture <name>] [--result <ok|deny|error>] [--json]',
  );
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

export async function runAuditCommand(
  args: string[],
  deps: AuditCommandDeps,
): Promise<number> {
  let json = false;
  let mode: AuditMode | undefined;
  let posture: string | undefined;
  let result: AuditResult | undefined;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--json') {
      json = true;
    } else if (arg === '--mode' || arg === '--posture' || arg === '--result') {
      const value = args[i + 1];
      if (value === undefined || value.startsWith('--')) {
        deps.out(`error: ${arg} needs a value`);
        return usage(deps.out);
      }
      if (arg === '--mode') {
        if (!isAuditMode(value)) {
          deps.out(`error: unknown mode ${JSON.stringify(value)}`);
          return usage(deps.out);
        }
        mode = value;
      } else if (arg === '--result') {
        if (!isAuditResult(value)) {
          deps.out(`error: unknown result ${JSON.stringify(value)}`);
          return usage(deps.out);
        }
        result = value;
      } else {
        posture = value;
      }
      i++;
    } else {
      return usage(deps.out);
    }
  }
  const records = await deps.loadRecords();
  const filtered = queryAudits(records, { mode, posture, result });
  const redacted = filtered.map((record) =>
    redactAuditRecord(record, deps.secrets ?? []),
  );
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
