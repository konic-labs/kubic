// The process's configured audit sinks: built once from the loaded
// `[[audit]]` tables before the command runs, and given one short last try
// to deliver their spools after it.

import {
  buildConfiguredSinks,
  flushAuditSinks,
  setAuditSinks,
} from '@kubic/host/audit';
import type { CliConfigResult } from './config/load.js';

// The last try a command gives its collector sinks before it exits.
const AUDIT_FLUSH_MS = 2_000;

// Every command fans its audit rows out to these plus the mandatory repo
// ledger. An unbuildable table is named on `warn` (and fails its doctor
// check); it never stops the command, and the repo ledger still records
// everything.
export function installAuditSinks(
  cliConfig: CliConfigResult,
  warn: (line: string) => void,
): void {
  if (cliConfig.runtime === undefined) return;
  const built = buildConfiguredSinks(cliConfig.runtime.config.audit ?? []);
  setAuditSinks(built.sinks);
  for (const problem of built.problems) {
    warn(`warning: [[audit]] ${problem}`);
  }
}

// A collector sink that could not deliver during the command gets one short
// last try; whatever still waits stays in its spool for the next command or
// `kubic audit flush`.
export async function flushAuditSinksAtExit(): Promise<void> {
  await flushAuditSinks(AUDIT_FLUSH_MS);
}
