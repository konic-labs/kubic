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
  // `.agents/skills`, package-declared dirs) out of discovery. The
  // composition root passes the documented `KUBIC_TRUST_PROJECT` opt-in.
  trusted: boolean;
  // --no-skills: layered discovery off. Explicit --skill paths still apply
  // (the loader's own contract: explicit intent always applies).
  noSkills?: boolean;
  cliSkills?: string[];
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
}

export function bootSkills(options: BootSkillOptions): BootSkills {
  const load: DiscoverSkillsOptions = {
    bridge: options.bridge,
    homeDir: options.homeDir,
    cwd: options.cwd,
    trusted: options.trusted,
    ...(options.noSkills === undefined ? {} : { noSkills: options.noSkills }),
    ...(options.cliSkills === undefined
      ? {}
      : { cliSkills: options.cliSkills }),
    ...(options.log === undefined ? {} : { log: options.log }),
  };
  const { skills } = discoverSkills(load);
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
  };
}

// The role/capability gate (§29.4, §71): a skill whose `roles` list does
// not name the running role, or whose required tools the capability grant
// does not provide, is withheld — reported by name, never silently
// dropped. Kept here (not in the loader) because the loader owns
// discovery, and the grant is a policy input the caller holds.
export type { LoadedSkill, WithheldSkill };
