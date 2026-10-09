// The shapes of skill discovery and gating.

import type { FileBridge } from '@kubic/exec/file-bridge';
import type { PermissionClasses } from '../permissions.js';

export type SkillSource = 'user' | 'project' | 'package' | 'settings' | 'cli';

interface SkillMeta {
  name: string;
  description: string;
  filePath: string;
  source: SkillSource;
  roles?: string[];
  requiredTools?: string[];
  disableModelInvocation?: boolean;
}

export interface LoadedSkill extends SkillMeta {
  content: string;
}

export interface WithheldSkill {
  name: string;
  reason: string;
}

export interface DiscoverSkillsOptions {
  bridge: FileBridge;
  homeDir: string;
  cwd: string;
  // The global trust decision (the KUBIC_TRUST_PROJECT opt-in, fixtures):
  // every project ancestor is in scope. Production callers pass
  // `trustProject` so the decision is checked per ancestor instead.
  trusted: boolean;
  // Per-directory trust. Takes precedence over
  // `trusted`: a project/package skill is loaded only when its own
  // directory is trusted, so a grant for a child never walks up into an
  // untrusted parent (and a grant for a parent applies from a child cwd).
  trustProject?: (dir: string) => boolean;
  settingsSkills?: string[];
  cliSkills?: string[];
  noSkills?: boolean;
  log?: (line: string) => void;
}

export interface DiscoverSkillsResult {
  skills: LoadedSkill[];
  // Explicit --skill values that resolved to nothing: the
  // caller reports these on stderr — a silent skip reads as a loaded skill.
  unknownSkills: string[];
  // Every skill the walk met but did not load — excluded by
  // distrust or confinement, or failed reads — each with its reason, so
  // the `kubic skills` listing (and the TUI notice) can name what was
  // left out instead of dropping it silently.
  skipped: SkippedSkill[];
}

// A skill the walk met but did not load. `excluded` is
// policy — distrust, or a package entry confined away;
// `error` is a failed read. The name of an excluded project skill is the
// directory basename: the frontmatter name is unknowable without reading
// the file, which trust forbids.
type SkillSkipStatus = 'excluded' | 'error';

export interface SkippedSkill {
  name: string;
  filePath: string;
  source: SkillSource;
  status: SkillSkipStatus;
  reason: string;
}

export interface GateContext {
  // Absent means the lane booted with no role — the
  // role-scoping check is skipped (only the capability check applies), so
  // a plain `kubic run` still sees role-scoped skills it can actually run.
  role?: string;
  classes: PermissionClasses;
  log?: (line: string) => void;
}

export interface GatedSkills {
  visible: LoadedSkill[];
  withheld: WithheldSkill[];
}
