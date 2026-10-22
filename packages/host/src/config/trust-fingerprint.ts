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
// The content a walk keeps for the grant's snapshot (trust-review.ts): text
// files up to this size, and no more than the total.
const KEPT_FILE_BYTES = 64 * 1024;
const KEPT_TOTAL_BYTES = 1024 * 1024;

const BRIDGE = createNodeFileBridge('/');

// One file the fingerprint covers: its project-relative name, what the
// fingerprint recorded for it (a digest, or `size:<n>` past the walk's bounds,
// `unreadable`, `dangling`, `link:<target>`), and its text when the walk kept
// it.
export interface TrustedFile {
  readonly name: string;
  readonly digest: string;
  readonly text?: string;
}

interface Walk {
  readonly root: string;
  readonly lines: string[];
  readonly files: TrustedFile[];
  count: number;
  bytes: number;
  kept: number;
}

function record(walk: Walk, name: string, digest: string, text?: string): void {
  walk.lines.push(`${name}\0${digest}`);
  walk.files.push(
    text === undefined ? { name, digest } : { name, digest, text },
  );
}

// The content as text, when it is text: valid UTF-8 without NUL bytes.
function textOf(content: Uint8Array): string | undefined {
  if (content.includes(0)) return undefined;
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(content);
  } catch {
    return undefined;
  }
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

function nameOf(walk: Walk, path: string): string {
  return relative(walk.root, path).split(sep).join('/');
}

function addFile(walk: Walk, path: string, size: number): void {
  const name = nameOf(walk, path);
  walk.count += 1;
  if (walk.count > MAX_FILES || walk.bytes + size > MAX_CONTENT_BYTES) {
    record(walk, name, `size:${size}`);
    return;
  }
  let content: Uint8Array;
  try {
    content = BRIDGE.readBinaryFile(path);
  } catch {
    record(walk, name, 'unreadable');
    return;
  }
  walk.bytes += content.byteLength;
  const keep =
    content.byteLength <= KEPT_FILE_BYTES &&
    walk.kept + content.byteLength <= KEPT_TOTAL_BYTES;
  const text = keep ? textOf(content) : undefined;
  if (text !== undefined) walk.kept += content.byteLength;
  record(walk, name, sha256(content), text);
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
        record(walk, nameOf(walk, path), 'dangling');
        continue;
      }
      let info: ReturnType<typeof BRIDGE.fileInfo>;
      try {
        info = BRIDGE.fileInfo(target);
      } catch {
        continue;
      }
      if (info.isDirectory) {
        record(walk, nameOf(walk, path), `link:${target}`);
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

/**
 * The digest of every file a trust grant for `root` lets take effect.
 * @internal
 */
export function projectTrustFingerprint(root: string, home: string): string {
  return projectTrustWalk(root, home).fingerprint;
}

/** The fingerprint with the files it covers (and their text, within bounds). */
export function projectTrustWalk(
  root: string,
  home: string,
): { fingerprint: string; files: readonly TrustedFile[] } {
  const walk: Walk = {
    root,
    lines: [],
    files: [],
    count: 0,
    bytes: 0,
    kept: 0,
  };
  addTree(walk, join(root, '.kubic'), RUNTIME_STATE);
  addPath(walk, join(root, 'models.json'));
  addPath(walk, join(root, 'AGENTS.md'));
  for (const skills of SKILL_ROOTS) addPath(walk, join(root, skills));
  const declared = packageSkillDirs(root);
  record(
    walk,
    'package.json skills',
    JSON.stringify(declared),
    `${JSON.stringify(declared, null, 2)}\n`,
  );
  for (const entry of declared) {
    const dir = resolve(root, entry);
    if (inside(root, dir)) addPath(walk, dir);
  }
  const prompt = systemPromptFile(root, home);
  if (prompt !== undefined && inside(root, prompt)) {
    if (!inside(join(root, '.kubic'), prompt)) addPath(walk, prompt);
  }
  return {
    fingerprint: `sha256:${sha256(walk.lines.join('\n'))}`,
    files: walk.files,
  };
}
