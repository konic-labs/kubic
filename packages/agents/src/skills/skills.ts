// Skills loader (issue #36; design §29). Markdown-only skills from
// own-config + repo only: user roots (~/.pi/agent/skills,
// ~/.agents/skills), project roots (.pi/skills + .agents/skills in the cwd
// up to the git top-level — the cwd alone outside a repository —
// post-trust only, never relabelling a user root as 'project'),
// package-declared skill dirs (`skills` + `pi.skills` in the trusted
// package.json files at or under that same top level), the
// settings array, and repeatable --skill paths (additive even under
// --no-skills). Later sources shadow earlier ones on name conflict.
//
// v1-safe by construction: there is no fetcher, no installer, no network —
// every skill resolves to a local SKILL.md file. I/O confinement: this
// module never touches node:fs — all reads go through the injected exec
// FileBridge; tests back it with FakeExecutionEnv.
//
// Frontmatter contract (minimal subset, hand-parsed, no deps — Pi parity
// per issue #186: kebab-case keys, block sequences and folded/literal
// scalars for the contract keys, recursive discovery; deeper YAML —
// anchors, tags, nested maps, indent indicators — reads as plain values):
//   name: string (fallback: directory basename)
//   description: string (fallback: first non-empty body line; `>` folds,
//     `|` keeps newlines)
//   roles: [a, b] or a `- ` block list (absent = visible to every role)
//   tools: [read, write] or a `- ` block list (required tools, gated
//     against the grant)
//   disable-model-invocation: true (hidden from the model XML,
//     explicit-call only — Pi-compatible escape hatch for agent-invoked
//     helpers; the camelCase spelling stays as an alias)

import type { FileBridge } from '../../../exec/src/file-bridge.js';
import { type PermissionClasses, toolsForClasses } from '../policy.js';

export type SkillSource = 'user' | 'project' | 'package' | 'settings' | 'cli';

export interface SkillMeta {
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
  // Issue #228 review: per-directory trust. Takes precedence over
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
  // Explicit --skill values that resolved to nothing (issue #177): the
  // caller reports these on stderr — a silent skip reads as a loaded skill.
  unknownSkills: string[];
  // Issue #238: every skill the walk met but did not load — excluded by
  // distrust or confinement, or failed reads — each with its reason, so
  // the `kubic skills` listing (and the TUI notice) can name what was
  // left out instead of dropping it silently.
  skipped: SkippedSkill[];
}

// Issue #238: a skill the walk met but did not load. `excluded` is
// policy — distrust, or a package entry confined away (issue #423);
// `error` is a failed read. The name of an excluded project skill is the
// directory basename: the frontmatter name is unknowable without reading
// the file, which trust forbids.
export type SkillSkipStatus = 'excluded' | 'error';

export interface SkippedSkill {
  name: string;
  filePath: string;
  source: SkillSource;
  status: SkillSkipStatus;
  reason: string;
}

export interface GateContext {
  // Issue #181 (§29.4): absent means the lane booted with no role — the
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

function joinPosix(...parts: string[]): string {
  const segments: string[] = [];
  for (const chunk of parts.join('/').split('/')) {
    if (chunk === '' || chunk === '.') continue;
    if (chunk === '..') {
      segments.pop();
      continue;
    }
    segments.push(chunk);
  }
  return `/${segments.join('/')}`;
}

// Issue #177 (§29.2/§29.3): explicit skill paths anchor at the invoking
// cwd, never at '/' and never at whatever root the caller's bridge
// carries. Absolute values pass through (normalized); relative values —
// './rel-skill', 'rel-skill', '../up/skill', 'rel/SKILL.md' — resolve
// against the cwd, so `kubic run` (sessions-rooted bridge) and `kubic tui`
// (cwd bridge) agree. joinPosix cannot do this: it roots everything at '/'.
function normalizeSkillPath(path: string): string {
  const absolute = path.startsWith('/');
  const segments: string[] = [];
  for (const chunk of path.split('/')) {
    if (chunk === '' || chunk === '.') continue;
    if (chunk === '..') {
      if (segments.length > 0) segments.pop();
      continue;
    }
    segments.push(chunk);
  }
  return `${absolute ? '/' : ''}${segments.join('/')}`;
}

function resolveSkillPath(cwd: string, value: string): string {
  if (value.startsWith('/')) return normalizeSkillPath(value);
  return normalizeSkillPath(`${cwd}/${value}`);
}

function basenameOf(path: string): string {
  const clean = path.replace(/\/*$/, '');
  const slash = clean.lastIndexOf('/');
  return slash === -1 ? clean : clean.slice(slash + 1);
}

function dirnameOf(path: string): string {
  const clean = path.replace(/\/*$/, '');
  const slash = clean.lastIndexOf('/');
  if (slash === -1) return '.';
  if (slash === 0) return '/';
  return clean.slice(0, slash);
}

// Ancestors nearest-first: /a/b -> ['/a/b', '/a', '/'].
function ancestorsOf(cwd: string): string[] {
  const clean = cwd.replace(/\/*$/, '') || '/';
  const out: string[] = [];
  let current = clean;
  for (;;) {
    out.push(current);
    if (current === '/') break;
    current = dirnameOf(current);
  }
  return out;
}

// Issue #189 (§29.2): the repository top level, Pi-style — the nearest
// ancestor (itself included) holding a `.git` entry. Probed through the
// injected bridge (I/O confinement: no node:fs here); an unreadable path
// reads as "no marker", never fatal.
function findRepoRoot(bridge: FileBridge, cwd: string): string | undefined {
  for (const ancestor of ancestorsOf(cwd)) {
    let hasMarker = false;
    try {
      hasMarker = bridge.exists(joinPosix(ancestor, '.git'));
    } catch {
      hasMarker = false;
    }
    if (hasMarker) return ancestor;
  }
  return undefined;
}

// Issue #189: the trusted-ancestor chain for project + package skills is
// the repo root down to the cwd, far-to-near — the cwd alone outside a
// repository. Trusting one repo must not trust instructions from a parent
// directory, a shared /tmp, or $HOME, and a package.json above the root
// contributes nothing (it is never walked to).
function projectChain(bridge: FileBridge, cwd: string): string[] {
  const root = findRepoRoot(bridge, cwd);
  if (root === undefined) return [cwd.replace(/\/*$/, '') || '/'];
  if (root === '/') return ancestorsOf(cwd).reverse();
  return ancestorsOf(cwd)
    .filter((dir) => dir === root || dir.startsWith(`${root}/`))
    .reverse();
}

type FrontmatterValue = string | boolean | string[];

function stripScalarQuotes(item: string): string {
  const trimmed = item.trim();
  if (
    trimmed.length >= 2 &&
    ((trimmed.startsWith('"') && trimmed.endsWith('"')) ||
      (trimmed.startsWith("'") && trimmed.endsWith("'")))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function parseFlowList(raw: string): string[] {
  const inner = raw.slice(1, -1).trim();
  if (inner === '') return [];
  return inner.split(',').map((entry) => stripScalarQuotes(entry));
}

function parseFrontmatterValue(raw: string): FrontmatterValue {
  const value = raw.trim();
  if (value === 'true') return true;
  if (value === 'false') return false;
  if (value.startsWith('[') && value.endsWith(']')) return parseFlowList(value);
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }
  return value;
}

// Issue #186: is this frontmatter line a continuation of the block opened
// at keyIndent — a blank line, or anything indented past the key?
function isBlockContinuation(line: string, keyIndent: number): boolean {
  if (line.trim() === '') return true;
  const indent = line.search(/\S/);
  return indent !== -1 && indent > keyIndent;
}

// Issue #186: a `- item` block sequence under an empty-valued key.
// Returns undefined when the continuation holds no list items, so plain
// indented text still reads as an empty value (fail-open, as before).
function collectBlockSequence(
  fmLines: string[],
  from: number,
  keyIndent: number,
): { items: string[] | undefined; next: number } {
  const items: string[] = [];
  let sawItem = false;
  let next = from;
  for (let j = from; j < fmLines.length; j++) {
    const candidate = fmLines[j];
    if (candidate === undefined || !isBlockContinuation(candidate, keyIndent)) {
      break;
    }
    next = j;
    const text = candidate.trim();
    if (text === '' || text.startsWith('#')) continue;
    if (!text.startsWith('-')) return { items: undefined, next: from };
    const item = stripScalarQuotes(text.slice(1));
    if (item !== '') {
      items.push(item);
      sawItem = true;
    }
  }
  if (!sawItem) return { items: undefined, next: from };
  return { items, next };
}

// Issue #186: a `>` folded or `|` literal block scalar. Chomping is clip
// by default (one trailing newline, then clipped), `-` strips and `+`
// keeps; blank lines separate folded paragraphs and are kept in literals.
function collectBlockScalar(
  fmLines: string[],
  from: number,
  keyIndent: number,
  folded: boolean,
  chomping: string | undefined,
): { text: string; next: number } {
  const taken: string[] = [];
  let next = from;
  for (let j = from; j < fmLines.length; j++) {
    const candidate = fmLines[j];
    if (candidate === undefined || !isBlockContinuation(candidate, keyIndent)) {
      break;
    }
    next = j;
    taken.push(candidate.trim());
  }
  while (taken.length > 0 && taken[taken.length - 1] === '') taken.pop();
  let text: string;
  if (folded) {
    const paragraphs: string[] = [];
    let current: string[] = [];
    for (const line of taken) {
      if (line === '') {
        if (current.length > 0) paragraphs.push(current.join(' '));
        current = [];
      } else {
        current.push(line);
      }
    }
    if (current.length > 0) paragraphs.push(current.join(' '));
    text = paragraphs.join('\n');
  } else {
    text = taken.join('\n');
  }
  if (chomping === '-') return { text, next };
  // `+` keeps a trailing newline; clip (the default) drops it. Trailing
  // blank runs beyond one newline are not reconstructed — the contract
  // keys never depend on them.
  if (chomping === '+') return { text: `${text}\n`, next };
  return { text, next };
}

export function parseSkillFile(
  filePath: string,
  raw: string,
): Omit<LoadedSkill, 'source'> {
  const frontmatter: Record<string, FrontmatterValue> = {};
  let body = raw;
  if (raw.startsWith('---\n') || raw.startsWith('---\r\n')) {
    const lines = raw.split('\n');
    const closing = lines.findIndex(
      (line, index) => index > 0 && line.trim() === '---',
    );
    if (closing > 0) {
      // Issue #186 (§29, Pi parity): the contract keys accept YAML block
      // sequences and folded/literal scalars — not just flow values.
      // Only the contract subset is supported (no anchors, tags, nested
      // maps, or indent indicators); anything else reads as a plain value.
      const fmLines = lines
        .slice(1, closing)
        .map((line) => (line.endsWith('\r') ? line.slice(0, -1) : line));
      for (let i = 0; i < fmLines.length; i++) {
        const line = fmLines[i];
        if (line === undefined) continue;
        if (line.trim() === '' || line.trim().startsWith('#')) continue;
        const colon = line.indexOf(':');
        if (colon === -1) continue;
        const key = line.slice(0, colon).trim();
        if (key === '') continue;
        const keyIndent = line.search(/\S/);
        const marker = line.slice(colon + 1).trim();
        const blockMatch = /^[>|]([+-])?$/.exec(marker);
        if (blockMatch !== null) {
          const { text, next } = collectBlockScalar(
            fmLines,
            i + 1,
            keyIndent,
            marker.startsWith('>'),
            blockMatch[1],
          );
          frontmatter[key] = text;
          i = next;
          continue;
        }
        if (marker === '') {
          const { items, next } = collectBlockSequence(
            fmLines,
            i + 1,
            keyIndent,
          );
          if (items !== undefined) {
            frontmatter[key] = items;
            i = next;
          }
          continue;
        }
        frontmatter[key] = parseFrontmatterValue(line.slice(colon + 1));
      }
      body = lines.slice(closing + 1).join('\n');
    }
  }
  const dirName = basenameOf(dirnameOf(filePath));
  const name =
    typeof frontmatter.name === 'string' && frontmatter.name !== ''
      ? frontmatter.name
      : dirName;
  const firstLine = body
    .split('\n')
    .map((line) => line.trim())
    .find((line) => line !== '');
  const description =
    typeof frontmatter.description === 'string'
      ? frontmatter.description
      : (firstLine ?? '');
  const roles =
    Array.isArray(frontmatter.roles) && frontmatter.roles.length > 0
      ? [...frontmatter.roles]
      : undefined;
  const requiredTools =
    Array.isArray(frontmatter.tools) && frontmatter.tools.length > 0
      ? [...frontmatter.tools]
      : undefined;
  return {
    name,
    description,
    filePath,
    roles,
    requiredTools,
    // Issue #186 (§29, Pi parity): the canonical kebab-case key hides
    // the skill; the camelCase spelling stays as an alias.
    disableModelInvocation:
      frontmatter['disable-model-invocation'] === true ||
      frontmatter.disableModelInvocation === true
        ? true
        : undefined,
    content: body,
  };
}

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
    // Issue #238: the failed read is reported, not just logged, so the
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
// anchor at the invoking cwd (issue #177) — never at '/' (joinPosix's
// rooting turned './my-skill' into '/my-skill/SKILL.md') and never at the
// bridge's own root (which is the sessions root on `kubic run`). A bare
// name resolves against the discovery roots first (first hit wins — the
// shipped precedence), then against the cwd as a last resort; the old
// absolute '/<name>' probe is gone (a stray filesystem-root hit must never
// win over the roots).
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
  return loadSkillDir(bridge, joinPosix(cwd, value), 'cli', log);
}

// Issue #186 (§29): recursive discovery, Pi-style — every SKILL.md-bearing
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

// Issue #423: a package-declared skill dir is confined to the ancestor
// whose package.json declared it (the trusted root it was discovered
// under). An absolute path or a `..` escape landing outside never loads,
// and neither does a symlink resolving outside (realpath, so links
// count) — each refusal carries its reason on the log sink. Without the
// bridge's realPath seam the check is lexical only.
//
// The boundary is deliberately the DECLARING package's directory, not
// the repo root: per the per-ancestor trust model (issue #228) a grant
// for `/repo/pkg` covers `/repo/pkg` only, so a `/repo/pkg` entry for
// `../sibling` is refused even though the sibling is inside the same
// repo. A transient realPath failure fails closed (error skip, never a
// lexical fallback load).
function isWithinDir(path: string, dir: string): boolean {
  const cleanDir = dir.replace(/\/*$/, '') || '/';
  if (cleanDir === '/') return true;
  return path === cleanDir || path.startsWith(`${cleanDir}/`);
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
    // Issue #238: the confinement refusal is reported, not just logged.
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
    // Review on #423: a transient realPath failure must fail closed —
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
  // Issue #238: every met-but-not-loaded skill, each with its reason.
  const skipped: SkippedSkill[] = [];
  const note = (skip: SkippedSkill): void => {
    skipped.push(skip);
  };
  const add = (skill: LoadedSkill | undefined): void => {
    if (skill !== undefined) byName.set(skill.name, skill);
  };

  if (!noSkills) {
    // Low precedence first: user roots, then project ancestors far-to-near.
    // Issue #237 (§35 tree): `~/.kubic/skills` joins the Pi-compatible
    // roots LAST, so a Kubic-native skill wins a same-name conflict with
    // a Pi-carried one — the tool-specific directory overrides the
    // portable fallback.
    const userRoots = [
      joinPosix(homeDir, '.pi/agent/skills'),
      joinPosix(homeDir, '.agents/skills'),
      joinPosix(homeDir, '.kubic/skills'),
    ];
    // Issue #189: a user root is never relabelled 'project'. When the
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
    // Issue #238: distrust names what it leaves out instead of staying
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
      // Issue #423: each entry is confined to the ancestor that declared
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
  // Settings dirs anchor at the invoking cwd like --skill values (issue
  // #177): a relative dir in the settings file is cwd-relative, not
  // bridge-root-relative.
  for (const dir of settingsSkills) {
    add(
      loadSkillDir(bridge, resolveSkillPath(cwd, dir), 'settings', log, note),
    );
  }
  // An explicit --skill that resolves to nothing is reported, not just
  // debug-logged (issue #177): the caller warns on stderr, so a typo
  // cannot read as a loaded skill.
  const unknownSkills: string[] = [];
  for (const value of cliSkills) {
    const skill = loadExplicitSkill(bridge, value, roots, cwd, log);
    if (skill === undefined) unknownSkills.push(value);
    else add(skill);
  }
  return { skills: [...byName.values()], unknownSkills, skipped };
}

export function gateSkills(
  skills: LoadedSkill[],
  context: GateContext,
): GatedSkills {
  const allowed = new Set(toolsForClasses(context.classes));
  const visible: LoadedSkill[] = [];
  const withheld: WithheldSkill[] = [];
  for (const skill of skills) {
    // Issue #181: no role on the lane means no role scoping — the skill
    // is judged on capability alone.
    if (
      context.role !== undefined &&
      skill.roles !== undefined &&
      !skill.roles.includes(context.role)
    ) {
      const reason = `not visible to role '${context.role}'`;
      withheld.push({ name: skill.name, reason });
      context.log?.(`skill '${skill.name}' withheld: ${reason}`);
      continue;
    }
    const denied = skill.requiredTools?.find((tool) => !allowed.has(tool));
    if (denied !== undefined) {
      const reason = `needs tool '${denied}' denied by capability grant`;
      withheld.push({ name: skill.name, reason });
      context.log?.(`skill '${skill.name}' withheld: ${reason}`);
      continue;
    }
    visible.push(skill);
  }
  return { visible, withheld };
}

// Issue #186 (§29.3 agentskills.io shape, Pi parity): quotes escape too —
// a description carrying `"` or `'` must not break the block.
function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

// Pi-compatible prompt injection (agentskills.io shape): one <skill> block
// per model-visible skill. disableModelInvocation skills are never
// injected — they run only via explicit invokeSkill.
export function formatSkillsForSystemPrompt(skills: LoadedSkill[]): string {
  const blocks = skills
    .filter((skill) => skill.disableModelInvocation !== true)
    .map(
      (skill) =>
        `<skill>\n<name>${escapeXml(skill.name)}</name>\n` +
        `<description>${escapeXml(skill.description)}</description>\n` +
        `<filePath>${escapeXml(skill.filePath)}</filePath>\n</skill>`,
    );
  return `<skills>\n${blocks.join('\n')}\n</skills>`;
}

// Explicit call surface: the only way to run a disableModelInvocation
// skill. Unknown names throw — explicit calls are deliberate, never
// mid-task resolution (see resolveTaskSkillRefs).
export function invokeSkill(skills: LoadedSkill[], name: string): string {
  const hit = skills.find((skill) => skill.name === name);
  if (hit === undefined) throw new Error(`unknown skill '${name}'`);
  return hit.content;
}

// Explicit invocation expansion (issue #183, §29.4): a hidden skill runs
// by giving the model its content, with the operator's instructions
// appended — the turn prompt carries both, so the skill is reachable
// without ever entering the system prompt. Withheld skills are not in the
// input set (the caller passes the gated-visible skills), so invoking one
// reports the same unknown-skill refusal — existence never leaks.
export function expandSkillInvocation(
  skills: LoadedSkill[],
  name: string,
  instructions?: string,
): string {
  const content = invokeSkill(skills, name);
  const extra = instructions?.trim() ?? '';
  return extra === '' ? content : `${content}\n\n${extra}`;
}

// Task resource resolution: withheld or unknown skill refs are reported,
// never thrown — a withheld skill must not fail a task mid-run.
export interface ResolvedTaskSkills {
  granted: LoadedSkill[];
  withheld: WithheldSkill[];
}

export function resolveTaskSkillRefs(
  names: string[],
  gated: GatedSkills,
): ResolvedTaskSkills {
  const byName = new Map(gated.visible.map((skill) => [skill.name, skill]));
  const withheldByName = new Map(
    gated.withheld.map((entry) => [entry.name, entry.reason]),
  );
  const granted: LoadedSkill[] = [];
  const withheld: WithheldSkill[] = [];
  for (const name of names) {
    const skill = byName.get(name);
    if (skill !== undefined) {
      granted.push(skill);
      continue;
    }
    withheld.push({
      name,
      reason: withheldByName.get(name) ?? `unknown skill '${name}'`,
    });
  }
  return { granted, withheld };
}
