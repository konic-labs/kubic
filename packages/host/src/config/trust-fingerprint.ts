// The fingerprint a project-trust grant is bound to: one digest over every
// project file the grant lets take effect. A grant covers the content it was
// given for, so a pulled commit, a checked-out branch or a local edit that
// changes any of these files makes the project untrusted again until the user
// re-confirms it:
//
//   - the `.kubic/` tree (config.toml, models.json, role documents, anything
//     else there) — but not the runtime state Kubic writes itself (`audit/`,
//     `journal/`, `sessions/`);
//   - a root `models.json` and a root `AGENTS.md` (the project
//     instructions; one in a subdirectory belongs to that directory's own
//     grant, like its skills);
//   - the project skills: `.pi/skills/` and `.agents/skills/`, and the skill
//     directories `package.json` declares (its `skills` and `pi.skills` lists,
//     never the rest of the file, so a dependency bump does not ask again);
//   - the `[agent] systemPromptFile` the project config names, when it lives
//     inside the project.
//
// Reads go through the exec FileBridge (I/O confinement). A file's content is
// hashed while the walk stays inside its bounds; past them only its path and
// size count, so a huge skill tree cannot stall a command.

import { createHash } from 'node:crypto';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { createNodeFileBridge } from '@kubic/exec/file-bridge';
import { parseTomlDocument } from './toml-parse.js';

const RUNTIME_STATE = new Set(['audit', 'journal', 'sessions']);
const SKILL_ROOTS = ['.pi/skills', '.agents/skills'];
const MAX_FILES = 4096;
const MAX_CONTENT_BYTES = 32 * 1024 * 1024;

const BRIDGE = createNodeFileBridge('/');

interface Walk {
  readonly root: string;
  readonly lines: string[];
  files: number;
  bytes: number;
}

function sha256(data: Uint8Array | string): string {
  return createHash('sha256').update(data).digest('hex');
}

function inside(root: string, path: string): boolean {
  const rel = relative(root, path);
  return (
    rel === '' ||
    (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel))
  );
}

function addFile(walk: Walk, path: string, size: number): void {
  const name = relative(walk.root, path).split(sep).join('/');
  walk.files += 1;
  if (walk.files > MAX_FILES || walk.bytes + size > MAX_CONTENT_BYTES) {
    walk.lines.push(`${name}\0size:${size}`);
    return;
  }
  try {
    const content = BRIDGE.readBinaryFile(path);
    walk.bytes += content.byteLength;
    walk.lines.push(`${name}\0${sha256(content)}`);
  } catch {
    walk.lines.push(`${name}\0unreadable`);
  }
}

// Every regular file under `dir`, links to files followed (the loaders read
// through them), links to directories recorded by target and not walked.
function addTree(walk: Walk, dir: string, skip?: ReadonlySet<string>): void {
  let entries: ReturnType<typeof BRIDGE.listDir>;
  try {
    entries = BRIDGE.listDir(dir);
  } catch {
    return;
  }
  for (const entry of [...entries].sort((a, b) => (a.name < b.name ? -1 : 1))) {
    if (skip?.has(entry.name) === true) continue;
    const path = join(dir, entry.name);
    if (entry.isSymbolicLink) {
      let target: string;
      try {
        target = BRIDGE.realPath?.(path) ?? path;
      } catch {
        walk.lines.push(`${relative(walk.root, path)}\0dangling`);
        continue;
      }
      let info: ReturnType<typeof BRIDGE.fileInfo>;
      try {
        info = BRIDGE.fileInfo(target);
      } catch {
        continue;
      }
      if (info.isDirectory) {
        walk.lines.push(`${relative(walk.root, path)}\0link:${target}`);
      } else if (info.isFile !== false) {
        // Named by the link, read through it.
        addFile(walk, path, info.size);
      }
      continue;
    }
    if (entry.isDirectory) addTree(walk, path);
    else if (entry.isFile !== false) addFile(walk, path, entry.size);
  }
}

function addPath(walk: Walk, path: string): void {
  let info: ReturnType<typeof BRIDGE.fileInfo>;
  try {
    info = BRIDGE.fileInfo(BRIDGE.realPath?.(path) ?? path);
  } catch {
    return;
  }
  if (info.isDirectory) addTree(walk, path);
  else if (info.isFile !== false) addFile(walk, path, info.size);
}

// The skill directories package.json declares, as the skills loader reads
// them: `skills` and `pi.skills`, each relative to the project root.
function packageSkillDirs(root: string): string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(BRIDGE.readTextFile(join(root, 'package.json')));
  } catch {
    return [];
  }
  if (typeof parsed !== 'object' || parsed === null) return [];
  const record = parsed as Record<string, unknown>;
  const pi = record.pi as Record<string, unknown> | undefined;
  return [record.skills, typeof pi === 'object' && pi !== null ? pi.skills : []]
    .flatMap((value) => (Array.isArray(value) ? value : []))
    .filter(
      (entry): entry is string => typeof entry === 'string' && entry !== '',
    );
}

// The `[agent] systemPromptFile` of the project config, resolved like the
// config load resolves it: against the config file's own directory.
function systemPromptFile(root: string, home: string): string | undefined {
  const configPath = join(root, '.kubic', 'config.toml');
  let agent: unknown;
  try {
    agent = parseTomlDocument(BRIDGE.readTextFile(configPath)).agent;
  } catch {
    return undefined;
  }
  if (typeof agent !== 'object' || agent === null) return undefined;
  const file = (agent as Record<string, unknown>).systemPromptFile;
  if (typeof file !== 'string' || file === '') return undefined;
  if (file.startsWith('~/')) return join(home, file.slice(2));
  return resolve(dirname(configPath), file);
}

/** The digest of every file a trust grant for `root` lets take effect. */
export function projectTrustFingerprint(root: string, home: string): string {
  const walk: Walk = { root, lines: [], files: 0, bytes: 0 };
  addTree(walk, join(root, '.kubic'), RUNTIME_STATE);
  addPath(walk, join(root, 'models.json'));
  addPath(walk, join(root, 'AGENTS.md'));
  for (const skills of SKILL_ROOTS) addPath(walk, join(root, skills));
  const declared = packageSkillDirs(root);
  walk.lines.push(`package.json skills\0${JSON.stringify(declared)}`);
  for (const entry of declared) {
    const dir = resolve(root, entry);
    if (inside(root, dir)) addPath(walk, dir);
  }
  const prompt = systemPromptFile(root, home);
  if (prompt !== undefined && inside(root, prompt)) {
    if (!inside(join(root, '.kubic'), prompt)) addPath(walk, prompt);
  }
  return `sha256:${sha256(walk.lines.join('\n'))}`;
}
