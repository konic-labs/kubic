// Skills loader (issue #36; design §29). Markdown-only skills from
// own-config + repo only: user roots (~/.pi/agent/skills,
// ~/.agents/skills), project roots (.pi/skills + .agents/skills in the cwd
// and its ancestors, post-trust only), package-declared skill dirs
// (`skills` + `pi.skills` in the nearest trusted package.json), the
// settings array, and repeatable --skill paths (additive even under
// --no-skills). Later sources shadow earlier ones on name conflict.
//
// v1-safe by construction: there is no fetcher, no installer, no network —
// every skill resolves to a local SKILL.md file. I/O confinement: this
// module never touches node:fs — all reads go through the injected exec
// FileBridge; tests back it with FakeExecutionEnv.
//
// Frontmatter contract (minimal subset, hand-parsed, no deps):
//   name: string (fallback: directory basename)
//   description: string (fallback: first non-empty body line)
//   roles: [a, b] (absent = visible to every role)
//   tools: [read, write] (required tools, gated against the grant)
//   disableModelInvocation: true (hidden from the model XML, explicit-call
//     only — Pi-compatible escape hatch for agent-invoked helpers)
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
  trusted: boolean;
  settingsSkills?: string[];
  cliSkills?: string[];
  noSkills?: boolean;
  log?: (line: string) => void;
}

export interface DiscoverSkillsResult {
  skills: LoadedSkill[];
}

export interface GateContext {
  role: string;
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

type FrontmatterValue = string | boolean | string[];

function parseFlowList(raw: string): string[] {
  const inner = raw.slice(1, -1).trim();
  if (inner === '') return [];
  return inner.split(',').map((entry) => {
    const item = entry.trim();
    if (
      (item.startsWith('"') && item.endsWith('"')) ||
      (item.startsWith("'") && item.endsWith("'"))
    ) {
      return item.slice(1, -1);
    }
    return item;
  });
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

export function parseSkillFile(
  filePath: string,
  raw: string,
): Omit<LoadedSkill, 'source'> {
  let frontmatter: Record<string, FrontmatterValue> = {};
  let body = raw;
  if (raw.startsWith('---\n') || raw.startsWith('---\r\n')) {
    const lines = raw.split('\n');
    const closing = lines.findIndex(
      (line, index) => index > 0 && line.trim() === '---',
    );
    if (closing > 0) {
      frontmatter = {};
      for (const line of lines.slice(1, closing)) {
        if (line.trim() === '' || line.trim().startsWith('#')) continue;
        const colon = line.indexOf(':');
        if (colon === -1) continue;
        const key = line.slice(0, colon).trim();
        const value = line.slice(colon + 1);
        if (key !== '') frontmatter[key] = parseFrontmatterValue(value);
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
    disableModelInvocation:
      frontmatter.disableModelInvocation === true ? true : undefined,
    content: body,
  };
}

function loadSkillFile(
  bridge: FileBridge,
  filePath: string,
  source: SkillSource,
  log?: (line: string) => void,
): LoadedSkill | undefined {
  let raw: string;
  try {
    raw = bridge.readTextFile(filePath);
  } catch {
    log?.(`skill skipped (unreadable ${filePath})`);
    return undefined;
  }
  return { ...parseSkillFile(filePath, raw), source };
}

function loadSkillDir(
  bridge: FileBridge,
  dir: string,
  source: SkillSource,
  log?: (line: string) => void,
): LoadedSkill | undefined {
  return loadSkillFile(bridge, joinPosix(dir, 'SKILL.md'), source, log);
}

// A --skill value is a directory, a SKILL.md file, or a bare name resolved
// against the enabled discovery roots (first hit wins).
function loadExplicitSkill(
  bridge: FileBridge,
  value: string,
  roots: string[],
  log?: (line: string) => void,
): LoadedSkill | undefined {
  const candidates = value.endsWith('.md')
    ? [value]
    : [joinPosix(value, 'SKILL.md')];
  for (const candidate of candidates) {
    const hit = loadSkillFile(bridge, candidate, 'cli');
    if (hit !== undefined) return hit;
  }
  if (!value.includes('/')) {
    for (const root of roots) {
      const hit = loadSkillDir(bridge, joinPosix(root, value), 'cli');
      if (hit !== undefined) return hit;
    }
  }
  log?.(`skill skipped (unknown skill '${value}')`);
  return undefined;
}

function listSkillDirs(bridge: FileBridge, root: string): string[] {
  let entries: { name: string; isDirectory: boolean }[];
  try {
    entries = bridge.listDir(root);
  } catch {
    return [];
  }
  return entries
    .filter((entry) => entry.isDirectory && !entry.name.startsWith('.'))
    .map((entry) => joinPosix(root, entry.name));
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

export function discoverSkills(
  options: DiscoverSkillsOptions,
): DiscoverSkillsResult {
  const {
    bridge,
    homeDir,
    cwd,
    trusted,
    settingsSkills = [],
    cliSkills = [],
    noSkills = false,
    log,
  } = options;
  const byName = new Map<string, LoadedSkill>();
  const roots: string[] = [];
  const add = (skill: LoadedSkill | undefined): void => {
    if (skill !== undefined) byName.set(skill.name, skill);
  };

  if (!noSkills) {
    // Low precedence first: user roots, then project ancestors far-to-near.
    const userRoots = [
      joinPosix(homeDir, '.pi/agent/skills'),
      joinPosix(homeDir, '.agents/skills'),
    ];
    for (const root of userRoots) {
      roots.push(root);
      for (const dir of listSkillDirs(bridge, root)) {
        add(loadSkillDir(bridge, dir, 'user', log));
      }
    }
    if (trusted) {
      const chain = ancestorsOf(cwd).reverse();
      for (const ancestor of chain) {
        for (const rootName of ['.pi/skills', '.agents/skills']) {
          const root = joinPosix(ancestor, rootName);
          roots.push(root);
          for (const dir of listSkillDirs(bridge, root)) {
            add(loadSkillDir(bridge, dir, 'project', log));
          }
        }
      }
      // Package-declared dirs: nearest package.json wins per name via the
      // same shadowing map (ancestors far-to-near so nearer shadows).
      for (const ancestor of chain) {
        for (const dir of readPackageSkillDirs(bridge, ancestor, log)) {
          add(loadSkillDir(bridge, dir, 'package', log));
        }
      }
    } else {
      log?.('skill discovery: untrusted cwd, project skills excluded');
    }
  }

  // Explicit intent always applies, even under --no-skills or distrust.
  for (const dir of settingsSkills) {
    add(loadSkillDir(bridge, dir, 'settings', log));
  }
  for (const value of cliSkills) {
    add(loadExplicitSkill(bridge, value, roots, log));
  }
  return { skills: [...byName.values()] };
}

export function gateSkills(
  skills: LoadedSkill[],
  context: GateContext,
): GatedSkills {
  const allowed = new Set(toolsForClasses(context.classes));
  const visible: LoadedSkill[] = [];
  const withheld: WithheldSkill[] = [];
  for (const skill of skills) {
    if (skill.roles !== undefined && !skill.roles.includes(context.role)) {
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

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
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

export interface SkillFlagSelection {
  noSkills: boolean;
  skills: string[];
}

// Minimal flag parser for the skill surface only: --skill is repeatable,
// --no-skills disables layered discovery (explicit --skill still applies).
// Anything fetch/install-shaped is rejected — skills never fetch, and no
// fetcher module or flag exists in this package.
export function parseSkillArgs(argv: string[]): SkillFlagSelection {
  const skills: string[] = [];
  let noSkills = false;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index] as string;
    if (arg === '--no-skills') {
      noSkills = true;
      continue;
    }
    if (arg === '--skill') {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith('--')) {
        throw new Error('error: --skill needs a value');
      }
      skills.push(value);
      index += 1;
      continue;
    }
    if (/fetch|install/i.test(arg)) {
      throw new Error(
        `error: unknown skill flag '${arg}' (skills never fetch)`,
      );
    }
  }
  return { noSkills, skills };
}
