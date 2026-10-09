// `kubic doctor`: health readout over providers,
// deps, and approval-policy mismatches, with a skip flag. Presentation
// only — every probe is injected (faux-only, zero network): the command
// never dials a provider, it reports what the injected probers say.
// Provider shapes mirror packages/agent/src/models-config/ read-only; policy
// validation reuses approvals/policy.ts. File access, if ever needed,
// goes through the exec FileBridge — this module never imports node:fs.

import type { CommandResult } from '@kubic/core/cli/exit-codes';
import { EXIT_OK, EXIT_USAGE } from '@kubic/core/cli/exit-codes';
import { formatJson } from '@kubic/core/cli/output';
import { diagnosticsOf, themeOf } from '../cli/index.js';
import { collectDoctorChecks } from './collect.js';
import { limitsDoctorExit } from './doctor-limits.js';
import { renderDoctorGrouped } from './doctor-render.js';
import type { DoctorCheck, DoctorDeps, DoctorStatus } from './types.js';

function summarize(checks: DoctorCheck[]): string {
  const pass = checks.filter((c) => c.status === 'pass').length;
  const warn = checks.filter((c) => c.status === 'warn').length;
  const fail = checks.filter((c) => c.status === 'fail').length;
  const skip = checks.filter((c) => c.status === 'skip').length;
  return `doctor: ${pass} pass, ${warn} warn, ${fail} fail, ${skip} skip`;
}

// The parsed `kubic doctor` invocation (commander owns the argv:
// apps/kubic/src/commands/session.ts). Each `skip` entry may list several
// comma-separated check ids.
export interface DoctorCommandOptions {
  readonly skip?: readonly string[];
  readonly json?: boolean;
  // The full per-check report on an interactive terminal
  // (the grouped summary is the default there). Piped output is always the
  // full report.
  readonly verbose?: boolean;
  // Check one session — its installed posture reads that
  // session's posture.json, and the full-access enumeration covers
  // exactly it (workspace filter bypassed).
  readonly session?: string;
}

export async function runDoctorCommand(
  options: DoctorCommandOptions,
  deps: DoctorDeps,
): Promise<CommandResult> {
  const skip = (options.skip ?? [])
    .flatMap((value) => value.split(','))
    .map((part) => part.trim())
    .filter((part) => part !== '');
  const checks = collectDoctorChecks(deps, skip);
  const known = new Set(checks.map((check) => check.id));
  const unknownSkip = skip.find((id) => !known.has(id));
  if (unknownSkip !== undefined) {
    diagnosticsOf(deps).error(`unknown check ${JSON.stringify(unknownSkip)}`);
    return { exitCode: EXIT_USAGE };
  }
  const exitCode = limitsDoctorExit(checks);
  const failed = exitCode !== EXIT_OK;
  if (options.json === true) {
    deps.out(formatJson({ ok: !failed, exitCode, checks }));
    return { exitCode };
  }
  const theme = themeOf(deps);
  if (deps.fancy === true && options.verbose !== true) {
    for (const line of renderDoctorGrouped(checks, theme, {
      exitCode,
      ...(deps.columns === undefined ? {} : { columns: deps.columns }),
    })) {
      deps.out(line);
    }
    return { exitCode };
  }
  const paint: Record<DoctorStatus, (text: string) => string> = {
    pass: theme.success,
    warn: theme.warning,
    fail: theme.error,
    skip: theme.muted,
  };
  for (const check of checks) {
    deps.out(
      `${paint[check.status](check.status.toUpperCase())} ${theme.bold(check.id)} ${theme.muted(`(${check.reason})`)}: ${check.detail}`,
    );
  }
  const summary = summarize(checks);
  deps.out(failed ? theme.error(summary) : theme.success(summary));
  return { exitCode };
}
