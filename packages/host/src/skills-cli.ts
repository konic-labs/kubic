// `kubic skills [--role <name>] [--json]`: which skills the
// agent was given, and why any were left out. Discovery plus role gating
// run through the SAME boot the lane runs (`bootSkills`) and are
// summarized, never reimplemented — the listing is a report on the boot,
// so it cannot drift from what a run would see.
//
// Presentation only: nothing here fetches, installs or dials. The exit is
// 0 even when skills were skipped (a skip is reported, not a failure); a
// `--role` that refuses to resolve fails closed with its named reason.

import type { PermissionClasses } from '../../agents/src/policy.js';
import { SOLO_DEFAULTS } from '../../agents/src/policy.js';
import { formatJson } from '../../core/src/cli/output.js';
import { renderTable } from '../../core/src/cli/table.js';
import { type CliIo, diagnosticsOf, themeOf } from './cli-io.js';
import { effectiveRoleClasses } from './roles/resolver.js';
import type { BootSkillOptions } from './skills-boot.js';
import { bootSkills, summarizeSkills } from './skills-boot.js';

export interface SkillsCommandOptions {
  role?: string;
  json?: boolean;
}

// What `--role <name>` resolved to for the gate: the lane-visible name,
// the document's skill allowlist (both sides must admit), and
// the document's capability grant for the most-restrictive merge.
export interface SkillsRoleGate {
  name: string;
  skills?: string[];
  classes?: PermissionClasses;
}

export interface SkillsCommandDeps extends CliIo {
  // The lane-boot discovery inputs (bridge, cwd, homeDir, trust,
  // settings, installed classes) — the composition root builds them from
  // the one config load; tests hand-build them over a tmp dir.
  base: Omit<BootSkillOptions, 'role' | 'roleSkills' | 'warn' | 'log'>;
  // `--role` resolution — the composition root wires the same `selectRole`
  // call `kubic run` uses (project root, layers, trust, enterprise tool
  // policy); a refusal throws with its named reason.
  resolveRole?: (name: string) => SkillsRoleGate;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function runSkillsCommand(
  options: SkillsCommandOptions,
  deps: SkillsCommandDeps,
): number {
  const log = diagnosticsOf(deps);
  let role: string | undefined;
  let roleSkills: string[] | undefined;
  let classes = deps.base.classes;
  if (options.role !== undefined) {
    if (deps.resolveRole === undefined) {
      log.error(
        `unknown role '${options.role}' (no role resolution in this context)`,
      );
      return 1;
    }
    let gate: SkillsRoleGate;
    try {
      gate = deps.resolveRole(options.role);
    } catch (error) {
      log.error(errorText(error));
      return 1;
    }
    role = gate.name;
    roleSkills = gate.skills;
    // The same most-restrictive merge the lane
    // installs — a role declaring `network: none` withholds here exactly
    // as it would at boot.
    if (gate.classes !== undefined) {
      classes = effectiveRoleClasses(
        { ...SOLO_DEFAULTS, ...deps.base.classes },
        gate.classes,
      );
    }
  }
  const booted = bootSkills({
    ...deps.base,
    ...(classes === undefined ? {} : { classes }),
    ...(role === undefined ? {} : { role }),
    ...(roleSkills === undefined ? {} : { roleSkills }),
    // An unresolvable explicit --skill warns on diagnostics —
    // never only in the table — so a typo cannot read as a loaded skill.
    warn: (line) => log.warn(line),
  });
  const rows = summarizeSkills(booted);
  if (options.json === true) {
    deps.out(formatJson(rows));
    return 0;
  }
  if (rows.length === 0) {
    log.info('no skills discovered');
    return 0;
  }
  const theme = themeOf(deps);
  deps.out(
    renderTable(
      rows.map((row) => [
        theme.bold(row.name),
        row.source,
        row.path,
        row.status,
        row.reason ?? '',
      ]),
      [
        { header: 'NAME' },
        { header: 'SOURCE' },
        { header: 'PATH' },
        { header: 'STATUS' },
        { header: 'REASON' },
      ],
      { fancy: deps.fancy === true, theme },
    ),
  );
  return 0;
}
