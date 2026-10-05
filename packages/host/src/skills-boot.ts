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
import type {
  DiscoverSkillsOptions,
  LoadedSkill,
  WithheldSkill,
} from '../../agents/src/skills/skills.js';
import {
  discoverSkills,
  formatSkillsForSystemPrompt,
} from '../../agents/src/skills/skills.js';
import type { FileBridge } from '../../exec/src/file-bridge.js';

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
}

export interface BootSkills {
  skills: LoadedSkill[];
  // The `<skills>` block for the system prompt, or undefined when no skill
  // is model-visible. Undefined — not an empty block — so a skill-less
  // boot assembles byte-identical prompt bytes (issue #33: the prompt
  // prefix is cache-keyed, and an empty block would shift it for every
  // session that has no skills).
  block: string | undefined;
  // Model-invisible skills (disableModelInvocation). Reported so a caller
  // can name them if it needs to; never injected.
  hidden: string[];
  // Issue #177: the explicit --skill values that resolved to nothing. The
  // boot already warned each one via `warn`; reported as well so a caller
  // that renders its own diagnostics (doctor, tests) can read them.
  unknownSkills: string[];
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
  const { skills, unknownSkills } = discoverSkills(load);
  // Issue #177: explicit intent that resolved to nothing is a visible
  // warning, not a debug line — otherwise a typo reads as a loaded skill.
  for (const value of unknownSkills) {
    options.warn?.(`skill skipped (unknown skill '${value}')`);
  }
  const visible = skills.filter(
    (skill) => skill.disableModelInvocation !== true,
  );
  const hidden = skills
    .filter((skill) => skill.disableModelInvocation === true)
    .map((skill) => skill.name);
  return {
    skills,
    block:
      visible.length === 0 ? undefined : formatSkillsForSystemPrompt(visible),
    hidden,
    unknownSkills,
    readRoots: skillReadRoots(skills, options.cwd),
  };
}

// The role/capability gate (§29.4, §71): a skill whose `roles` list does
// not name the running role, or whose required tools the capability grant
// does not provide, is withheld — reported by name, never silently
// dropped. Kept here (not in the loader) because the loader owns
// discovery, and the grant is a policy input the caller holds.
export type { LoadedSkill, WithheldSkill };
