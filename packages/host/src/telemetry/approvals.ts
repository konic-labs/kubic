// The approval asks a run (or a tui turn) wrote to its workspace ledger since
// it started, and how many were refused: what the telemetry export reports.

import { auditLedgerDirFor, readAuditLedger } from '../audit/index.js';

export function approvalCounts(
  sessionId: string,
  workspace: string | undefined,
  since: number,
): { asked: number; denied: number } {
  if (workspace === undefined) return { asked: 0, denied: 0 };
  let records: ReturnType<typeof readAuditLedger>;
  try {
    records = readAuditLedger(auditLedgerDirFor(workspace));
  } catch {
    return { asked: 0, denied: 0 };
  }
  const asks = records.filter(
    (record) =>
      record.agent.session === sessionId &&
      /^(tool|trigger):/.test(record.what) &&
      Date.parse(record.when) >= since,
  );
  return {
    asked: asks.length,
    denied: asks.filter((record) => record.result === 'deny').length,
  };
}
