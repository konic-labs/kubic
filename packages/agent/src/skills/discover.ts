// Discovering skills across the user, project, package, settings and
// --skill roots, later sources shadowing earlier ones.

import type { FileBridge } from '@kubic/exec/file-bridge';
import { parseSkillFile } from './frontmatter.js';
import {
  basenameOf,
  dirnameOf,
  isWithinDir,
  joinPosix,
  normalizeSkillPath,
  projectChain,
  resolveSkillPath,
} from './paths.js';
import type {
  DiscoverSkillsOptions,
  DiscoverSkillsResult,
  LoadedSkill,
  SkillSource,
  SkippedSkill,
} from './types.js';

function loadSkillFile(
  bridge: FileBridge,
  filePath: string,
  source: SkillSource,
  log?: (line: string) => void,
  note?: (skip: SkippedSkill) => void,
): LoadedSkill | undefined {
  let raw: string;
  try {
    raw = bridge.readTextFile(filePath);
  } catch {
    log?.(`skill skipped (unreadable ${filePath})`);
    // The failed read is reported, not just logged, so the
    // listing can show it as an error with its reason.
    note?.({
      name: basenameOf(dirnameOf(filePath)),
      filePath,
      source,
      status: 'error',
      reason: `unreadable ${filePath}`,
    });
    return undefined;
  }
  return { ...parseSkillFile(filePath, raw), source };
}

function loadSkillDir(
  bridge: FileBridge,
  dir: string,
  source: SkillSource,
  log?: (line: string) => void,
  note?: (skip: SkippedSkill) => void,
): LoadedSkill | undefined {
  return loadSkillFile(bridge, joinPosix(dir, 'SKILL.md'), source, log, note);
}

// A --skill value is a directory, a SKILL.md file, or a bare name. Paths
// anchor at the invoking cwd — never at '/' (joinPosix's
// rooting turned './my-skill' into '/my-skill/SKILL.md') and never at the
// bridge's own root (which is the sessions root on `kubic run`). A bare
// name resolves against the discovery roots first (first hit wins — the
// shipped precedence): a top-level `<root>/<name>` in any root, then a
// nested skill directory of that name, found by the walk discovery makes.
// The cwd is the last resort. No absolute '/<name>' probe is made (a stray
// filesystem-root hit must never win over the roots).
function loadExplicitSkill(
  bridge: FileBridge,
  value: string,
  roots: string[],
  cwd: string,
  log?: (line: string) => void,
): LoadedSkill | undefined {
  if (value.endsWith('.md')) {
    return loadSkillFile(bridge, resolveSkillPath(cwd, value), 'cli', log);
  }
  if (value.includes('/')) {
    return loadSkillDir(bridge, resolveSkillPath(cwd, value), 'cli', log);
  }
  for (const root of roots) {
    const hit = loadSkillDir(bridge, joinPosix(root, value), 'cli', log);
    if (hit !== undefined) return hit;
  }
  for (const root of roots) {
    const nested = listSkillDirs(bridge, root).find(
      (dir) => basenameOf(dir) === value,
    );
    if (nested !== undefined) return loadSkillDir(bridge, nested, 'cli', log);
  }
  return loadSkillDir(bridge, joinPosix(cwd, value), 'cli', log);
}

// Recursive discovery, Pi-style — every SKILL.md-bearing
// directory under the root, at any depth. Dot-dirs, node_modules and
// symlinked dirs are never descended into (a repo root otherwise walks the
// whole dependency tree, and a symlink cycle never terminates — both probed
// through the bridge, fail-open). Only dirs containing SKILL.md are returned:
// a grouping dir without one contributes no skill, just a debug line.
function listSkillDirs(bridge: FileBridge, root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    let entries: {
      name: string;
      isDirectory: boolean;
      isSymbolicLink: boolean;
    }[];
    try {
      entries = bridge.listDir(dir);
    } catch {
      return;
    }
    for (const entry of entries) {
      if (!entry.isDirectory || entry.isSymbolicLink) continue;
      if (entry.name.startsWith('.') || entry.name === 'node_modules') {
        continue;
      }
      const full = joinPosix(dir, entry.name);
      let hasSkill = false;
      try {
        hasSkill = bridge.exists(joinPosix(full, 'SKILL.md'));
      } catch {
        hasSkill = false;
      }
      if (hasSkill) out.push(full);
      walk(full);
    }
  };
  walk(root);
  return out;
}

function readPackageSkillDirs(
  bridge: FileBridge,
  dir: string,
  log?: (line: string) => void,
): string[] {
  let raw: string;
  try {
    raw = bridge.readTextFile(joinPosix(dir, 'package.json'));
  } catch {
    return [];
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    log?.(`skill skipped (invalid package.json in ${dir})`);
    return [];
  }
  if (typeof parsed !== 'object' || parsed === null) return [];
  const record = parsed as Record<string, unknown>;
  const out: string[] = [];
  const collect = (value: unknown): void => {
    if (!Array.isArray(value)) return;
    for (const entry of value) {
      if (typeof entry === 'string' && entry !== '') out.push(entry);
    }
  };
  collect(record.skills);
  const pi = record.pi;
  if (typeof pi === 'object' && pi !== null) {
    collect((pi as Record<string, unknown>).skills);
  }
  return out.map((entry) =>
    entry.startsWith('/') ? entry : joinPosix(dir, entry),
  );
}

function confinedPackageDir(
  bridge: FileBridge,
  declared: string,
  ancestor: string,
  log?: (line: string) => void,
): string | SkippedSkill {
  const lexical = normalizeSkillPath(declared);
  if (!isWithinDir(lexical, ancestor)) {
    const reason = `package skill '${declared}' outside trusted root '${ancestor}'`;
    log?.(`skill skipped (${reason})`);
    // The confinement refusal is reported, not just logged.
    return {
      name: basenameOf(lexical),
      filePath: joinPosix(lexical, 'SKILL.md'),
      source: 'package',
      status: 'excluded',
      reason,
    };
  }
  let resolved: string;
  try {
    resolved = normalizeSkillPath(bridge.realPath?.(lexical) ?? lexical);
  } catch {
    // Review on: a transient realPath failure must fail closed —
    // falling back to the lexical path would load a skill whose target
    // was never verified. Reported as an error, like an unreadable file.
    const reason = `package skill '${declared}' unresolvable under trusted root '${ancestor}' (realPath failed)`;
    log?.(`skill skipped (${reason})`);
    return {
      name: basenameOf(lexical),
      filePath: joinPosix(lexical, 'SKILL.md'),
      source: 'package',
      status: 'error',
      reason,
    };
  }
  if (!isWithinDir(resolved, ancestor)) {
    const reason = `package skill '${declared}' resolves outside trusted root '${ancestor}'`;
    log?.(`skill skipped (${reason})`);
    return {
      name: basenameOf(lexical),
      filePath: joinPosix(lexical, 'SKILL.md'),
      source: 'package',
      status: 'excluded',
      reason,
    };
  }
  return lexical;
}

export function discoverSkills(
  options: DiscoverSkillsOptions,
): DiscoverSkillsResult {
  const {
    bridge,
    homeDir,
    cwd,
    trusted,
    trustProject,
    settingsSkills = [],
    cliSkills = [],
    noSkills = false,
    log,
  } = options;
  const byName = new Map<string, LoadedSkill>();
  const roots: string[] = [];
  // Every met-but-not-loaded skill, each with its reason.
  const skipped: SkippedSkill[] = [];
  const note = (skip: SkippedSkill): void => {
    skipped.push(skip);
  };
  const add = (skill: LoadedSkill | undefined): void => {
    if (skill !== undefined) byName.set(skill.name, skill);
  };

  if (!noSkills) {
    // Low precedence first: user roots, then project ancestors far-to-near.
    // `~/.kubic/skills` joins the Pi-compatible
    // roots LAST, so a Kubic-native skill wins a same-name conflict with
    // a Pi-carried one — the tool-specific directory overrides the
    // portable fallback.
    const userRoots = [
      joinPosix(homeDir, '.pi/agent/skills'),
      joinPosix(homeDir, '.agents/skills'),
      joinPosix(homeDir, '.kubic/skills'),
    ];
    // A user root is never relabelled 'project'. When the
    // repo root is $HOME itself (or $HOME is otherwise on the chain),
    // the project probe would re-list ~/.agents/skills under 'project'
    // and shadow the user entry — skip those exact roots here.
    const userRootSet = new Set(userRoots);
    for (const root of userRoots) {
      roots.push(root);
      for (const dir of listSkillDirs(bridge, root)) {
        add(loadSkillDir(bridge, dir, 'user', log, note));
      }
    }
    // Distrust names what it leaves out instead of staying
    // silent — directory names only (the walk reads no contents, so
    // nothing crosses the trust boundary). Package.json entries stay
    // unenumerated: naming them means reading the project file. An
    // untrusted root is never added to `roots`, so a bare --skill name
    // cannot resolve into it.
    const trustFor = trustProject ?? (() => trusted);
    const chain = projectChain(bridge, cwd);
    let anyTrusted = false;
    for (const ancestor of chain) {
      if (!trustFor(ancestor)) {
        for (const rootName of ['.pi/skills', '.agents/skills']) {
          const root = joinPosix(ancestor, rootName);
          if (userRootSet.has(root)) continue;
          for (const dir of listSkillDirs(bridge, root)) {
            note({
              name: basenameOf(dir),
              filePath: joinPosix(dir, 'SKILL.md'),
              source: 'project',
              status: 'excluded',
              reason: `project skills excluded (untrusted project root ${ancestor})`,
            });
          }
        }
        continue;
      }
      anyTrusted = true;
      for (const rootName of ['.pi/skills', '.agents/skills']) {
        const root = joinPosix(ancestor, rootName);
        if (userRootSet.has(root)) continue;
        roots.push(root);
        for (const dir of listSkillDirs(bridge, root)) {
          add(loadSkillDir(bridge, dir, 'project', log, note));
        }
      }
      // Package-declared dirs: nearest package.json wins per name via the
      // same shadowing map (ancestors far-to-near so nearer shadows).
      // Each entry is confined to the ancestor that declared
      // it — absolute paths, `..` escapes and outside-resolving symlinks
      // are refused with a reason, never loaded under project trust.
      for (const dir of readPackageSkillDirs(bridge, ancestor, log)) {
        const confined = confinedPackageDir(bridge, dir, ancestor, log);
        if (typeof confined === 'string') {
          add(loadSkillDir(bridge, confined, 'package', log, note));
        } else {
          note(confined);
        }
      }
    }
    if (!anyTrusted) {
      log?.('skill discovery: untrusted cwd, project skills excluded');
    }
  }

  // Explicit intent always applies, even under --no-skills or distrust.
  // Settings dirs anchor at the invoking cwd like --skill values: a relative
  // dir in the settings file is cwd-relative, not bridge-root-relative.
  for (const dir of settingsSkills) {
    add(
      loadSkillDir(bridge, resolveSkillPath(cwd, dir), 'settings', log, note),
    );
  }
  // An explicit --skill that resolves to nothing is reported, not just
  // debug-logged: the caller warns on stderr, so a typo
  // cannot read as a loaded skill.
  const unknownSkills: string[] = [];
  for (const value of cliSkills) {
    const skill = loadExplicitSkill(bridge, value, roots, cwd, log);
    if (skill === undefined) unknownSkills.push(value);
    else add(skill);
  }
  return { skills: [...byName.values()], unknownSkills, skipped };
}
