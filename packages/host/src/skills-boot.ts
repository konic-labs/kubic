// Boot-time skill discovery + prompt injection (issue #99, scope item 2;
// design §29, §29.3). The §29 discovery roots are traversed through the
// exec FileBridge (I/O confinement: this module never imports node:fs) and
// the model-visible blocks are produced by the skills loader's own
// formatter — no second format lives here.
//
// Fail-open by design, and stated: a skill that cannot be read is reported
// on the log sink and skipped by the loader itself; an unusable discovery
// root yields no skills. Skills are context, never a gate — a run must not
// die because a SKILL.md is malformed. What is NOT fail-open is the trust
// gate: project roots are traversed only under an explicit trust opt-in
// (§29.3), and the loader is told, never asked to guess.

import { basename, dirname, resolve, sep } from 'node:path';
import type { PermissionClasses } from '../../agents/src/policy.js';
import { SOLO_DEFAULTS } from '../../agents/src/policy.js';
import type {
  DiscoverSkillsOptions,
  LoadedSkill,
  SkillSource,
  SkippedSkill,
  WithheldSkill,
} from '../../agents/src/skills/skills.js';
import {
  discoverSkills,
  formatSkillsForSystemPrompt,
  gateSkills,
} from '../../agents/src/skills/skills.js';
import type { FileBridge } from '../../exec/src/file-bridge.js';
import type { DoctorCheck } from './doctor.js';

export interface BootSkillOptions {
  bridge: FileBridge;
  cwd: string;
  homeDir: string;
  // §29.3 trust gate: false keeps every project root (`.pi/skills`,
  // `.agents/skills`, package-declared dirs) out of discovery — unless
  // `trustProject` is given, which checks each ancestor on its own.
  trusted: boolean;
  // Issue #228 review: per-ancestor trust. Production passes the store's
  // per-path check, so a grant for the tree a skill lives in applies and a
  // grant for a child never reaches an untrusted parent.
  trustProject?: (dir: string) => boolean;
  // --no-skills: layered discovery off. Explicit --skill paths still apply
  // (the loader's own contract: explicit intent always applies).
  noSkills?: boolean;
  cliSkills?: string[];
  // Issue #237 (§29.2): the config `skills` projection — files or
  // directories, already resolved against their declaring file at load.
  // Loads with source 'settings', same as explicit intent: it applies
  // even under --no-skills or distrust (the config layer was trusted
  // when read, or refused before reading).
  settingsSkills?: string[];
  // Issue #177: an explicit --skill that resolves to nothing warns here,
  // on stderr — never on the debug log sink the TUI drops and --debug
  // gates. The message is the loader's own skip text, so run and tui name
  // the same value.
  warn?: (line: string) => void;
  log?: (line: string) => void;
  // Issue #181 (§29.4): the resolved role name for role-scoped skills.
  // Absent means the lane booted with no role — role scoping is skipped
  // and the capability check alone decides. The caller passes the name
  // the lane resolved (`--role`).
  role?: string;
  // Issue #181 (§29.4): the resolved role document's `skills` list, by
  // skill name. Absent means the document declares none — no restriction.
  // A declared list restricts the visible set to its names (merged with
  // the skill-side `roles:` check: both must admit).
  roleSkills?: string[];
  // Issue #181 (§29.4): the capability classes the lane enforces, for the
  // capability-aware check. Absent means the documented SOLO_DEFAULTS —
  // the same default the lane installs, so the gate never withholds what
  // the lane would run.
  classes?: PermissionClasses;
}

export interface BootSkills {
  skills: LoadedSkill[];
  // Issue #183 (§29.4): the invocable set for explicit invocation —
  // admitted + gate-passed, hidden included, withheld excluded. This is
  // `gated.visible`: the role `skills` list and the role/capability gate
  // have already removed what the lane must not offer, while
  // `disableModelInvocation` skills stay (they are unreachable except
  // through invocation). Expand/complete against this, never `skills`.
  invocable: LoadedSkill[];
  // The `<skills>` block for the system prompt, or undefined when no skill
  // is model-visible. Undefined — not an empty block — so a skill-less
  // boot assembles byte-identical prompt bytes (issue #33: the prompt
  // prefix is cache-keyed, and an empty block would shift it for every
  // session that has no skills).
  block: string | undefined;
  // Model-invisible skills (disableModelInvocation). Reported so a caller
  // can name them if it needs to; never injected.
  hidden: string[];
  // Issue #181 (§29.4): skills the role/capability gate withheld, with
  // the reason each was not offered. Reported (debug log + here) — never
  // silently dropped. `kubic doctor` reads this same list.
  withheld: WithheldSkill[];
  // Issue #177: the explicit --skill values that resolved to nothing. The
  // boot already warned each one via `warn`; reported as well so a caller
  // that renders its own diagnostics (doctor, tests) can read them.
  unknownSkills: string[];
  // Issue #238: every skill the walk met but did not load (excluded by
  // distrust or confinement, or failed reads), each with its reason —
  // the `kubic skills` listing and the TUI notice name these instead of
  // dropping them.
  skipped: SkippedSkill[];
  // Issue #173 (§29.3): the read-only roots of every ADVERTISED skill that
  // lives outside the cwd (user roots under $HOME, trusted ancestor project
  // roots, explicit --skill paths): a `SKILL.md` opens its skill directory
  // (so the model can follow the skill's own relative references), a flat
  // skill file opens only itself. Hidden skills are never advertised, so
  // they open nothing. The lane boot threads these into the read tool's
  // env and confine guard; every other tool keeps the confinement.
  readRoots: string[];
}

function isInside(root: string, path: string): boolean {
  return path === root || path.startsWith(`${root}${sep}`);
}

export function skillReadRoots(
  skills: readonly LoadedSkill[],
  cwd: string,
): string[] {
  const workspace = resolve(cwd);
  const roots = new Set<string>();
  for (const skill of skills) {
    if (skill.disableModelInvocation === true) continue;
    const file = resolve(workspace, skill.filePath);
    if (isInside(workspace, file)) continue;
    roots.add(basename(file) === 'SKILL.md' ? dirname(file) : file);
  }
  return [...roots];
}

export function bootSkills(options: BootSkillOptions): BootSkills {
  const load: DiscoverSkillsOptions = {
    bridge: options.bridge,
    homeDir: options.homeDir,
    cwd: options.cwd,
    trusted: options.trusted,
    ...(options.trustProject === undefined
      ? {}
      : { trustProject: options.trustProject }),
    ...(options.noSkills === undefined ? {} : { noSkills: options.noSkills }),
    ...(options.cliSkills === undefined
      ? {}
      : { cliSkills: options.cliSkills }),
    ...(options.settingsSkills === undefined
      ? {}
      : { settingsSkills: options.settingsSkills }),
    ...(options.log === undefined ? {} : { log: options.log }),
  };
  const { skills, unknownSkills, skipped } = discoverSkills(load);
  // Issue #177: explicit intent that resolved to nothing is a visible
  // warning, not a debug line — otherwise a typo reads as a loaded skill.
  for (const value of unknownSkills) {
    options.warn?.(`skill skipped (unknown skill '${value}')`);
  }
  // Issue #181 (§29.4, role-scoped + capability-aware): the injected set
  // depends on the resolved role and the installed capability classes —
  // a skill the role or the grant cannot use is not offered, with the
  // reason logged (and returned) instead of failing silently mid-task.
  // The role document's `skills` list restricts first (both sides must
  // admit); the loader's own gate then applies role scoping (skipped with
  // no role on the lane) and the capability check.
  const roleWithheld: WithheldSkill[] = [];
  const admitted = skills.filter((skill) => {
    if (
      options.roleSkills !== undefined &&
      !options.roleSkills.includes(skill.name)
    ) {
      roleWithheld.push({
        name: skill.name,
        reason: "not listed in the role's skills",
      });
      return false;
    }
    return true;
  });
  for (const entry of roleWithheld) {
    options.log?.(`skill '${entry.name}' withheld: ${entry.reason}`);
  }
  const gated = gateSkills(admitted, {
    ...(options.role === undefined ? {} : { role: options.role }),
    classes: options.classes ?? SOLO_DEFAULTS,
    ...(options.log === undefined ? {} : { log: options.log }),
  });
  const visible = gated.visible.filter(
    (skill) => skill.disableModelInvocation !== true,
  );
  const hidden = skills
    .filter((skill) => skill.disableModelInvocation === true)
    .map((skill) => skill.name);
  return {
    skills,
    invocable: gated.visible,
    block:
      visible.length === 0 ? undefined : formatSkillsForSystemPrompt(visible),
    hidden,
    withheld: [...roleWithheld, ...gated.withheld],
    unknownSkills,
    skipped,
    readRoots: skillReadRoots(visible, options.cwd),
  };
}

export type {
  SkillSource,
  SkippedSkill,
} from '../../agents/src/skills/skills.js';
// The role/capability gate (§29.4, issue #181): applied in `bootSkills`
// above — discovery stays in the loader (it owns the roots and trust),
// while the grant (the resolved role, its `skills` list, the installed
// classes) is a boot input the caller holds. Withheld skills are reported
// by name on the log sink and in `BootSkills.withheld`, never silently
// dropped.
export type { LoadedSkill, WithheldSkill };

// The `kubic skills` listing row (issue #238): one per skill the boot met,
// loaded or not. `visible` reached the prompt; `hidden` stays
// model-invisible by its own flag; `withheld` failed the role/capability
// gate; `excluded` was left out by policy (distrust, confinement); `error`
// failed to read. Every non-visible row carries the reason — the same
// discovery plus role gating the lane boots, summarized, never
// reimplemented.
export type SkillRowStatus =
  | 'visible'
  | 'hidden'
  | 'withheld'
  | 'excluded'
  | 'error';

export interface SkillRow {
  name: string;
  source: SkillSource;
  path: string;
  status: SkillRowStatus;
  reason?: string;
}

export function summarizeSkills(booted: BootSkills): SkillRow[] {
  const withheldByName = new Map(
    booted.withheld.map((entry) => [entry.name, entry.reason]),
  );
  const hidden = new Set(booted.hidden);
  const rows: SkillRow[] = booted.skills.map((skill) => {
    if (hidden.has(skill.name)) {
      return {
        name: skill.name,
        source: skill.source,
        path: skill.filePath,
        status: 'hidden' as SkillRowStatus,
        reason:
          'hidden from the model (disable-model-invocation: explicit calls only)',
      };
    }
    const reason = withheldByName.get(skill.name);
    if (reason !== undefined) {
      return {
        name: skill.name,
        source: skill.source,
        path: skill.filePath,
        status: 'withheld' as SkillRowStatus,
        reason,
      };
    }
    return {
      name: skill.name,
      source: skill.source,
      path: skill.filePath,
      status: 'visible' as SkillRowStatus,
    };
  });
  for (const skip of booted.skipped) {
    rows.push({
      name: skip.name,
      source: skip.source,
      path: skip.filePath,
      status: skip.status,
      reason: skip.reason,
    });
  }
  // Sorted by name: the `--json` envelope is stable across filesystems
  // (directory listing order is not).
  rows.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return rows;
}

// The TUI's one-time boot notice (issue #238): the loader lines the TUI
// used to drop, as a single summary — `undefined` when nothing was
// skipped, so a clean boot stays silent.
export function describeSkillSkips(
  skipped: readonly SkippedSkill[],
): string | undefined {
  if (skipped.length === 0) return undefined;
  const errors = skipped.filter((skip) => skip.status === 'error').length;
  const excluded = skipped.length - errors;
  const parts: string[] = [];
  if (errors > 0) parts.push(`${errors} error${errors === 1 ? '' : 's'}`);
  if (excluded > 0) parts.push(`${excluded} excluded`);
  return `skills: ${skipped.length} skipped (${parts.join(', ')}) — run \`kubic skills\` for every skill and why it was left out`;
}

// Doctor surface (issue #181, §29.4): the same boot the lane runs, judged
// with the lane's classes and no role — a skill the default lane would
// not offer warns here with the gate's reason, never green. `kubic run
// --role` narrows further; that narrowing is named by the run's own
// debug log, not here.
// Issue #238: the summary line rides first — counts of what the boot
// met (loaded, hidden, withheld, errors). Errors warn (a skill the lane
// silently misses is worth a look); the line never fails.
export function skillsDoctorProbe(input: BootSkillOptions): DoctorCheck[] {
  const booted = bootSkills(input);
  return [
    skillsDoctorSummary(booted),
    ...booted.withheld.map((held) => ({
      id: `skill:${held.name}`,
      label: `skill ${held.name}`,
      status: 'warn' as const,
      reason: 'policy-mismatch' as const,
      detail: held.reason,
    })),
  ];
}

// The `kubic doctor` skills line (issue #238): counts of what the boot
// met — loaded, hidden, withheld, errors. Errors warn (a skill the lane
// silently misses is worth a look); the line never fails, and anything
// narrower (a role's own narrowing) stays on the run's debug log.
export function skillsDoctorSummary(booted: BootSkills): DoctorCheck {
  const errors = booted.skipped.filter(
    (skip) => skip.status === 'error',
  ).length;
  const detail =
    `${booted.skills.length} loaded, ${booted.hidden.length} hidden, ` +
    `${booted.withheld.length} withheld, ${errors} errors`;
  if (errors > 0) {
    return {
      id: 'skills',
      label: 'skills',
      status: 'warn',
      reason: 'deps-missing',
      detail,
    };
  }
  return {
    id: 'skills',
    label: 'skills',
    status: 'pass',
    reason: 'ok',
    detail,
  };
}
