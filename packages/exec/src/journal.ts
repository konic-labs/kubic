// Change journal store (issue #17; §42.4).
// `.kubic/journal/index.jsonl` (append-only entries) + `blobs/` (content-
// addressed before/after content). Persists across sessions: undo works
// after the terminal closes. Retention is enforced on every append, so
// unbounded growth is impossible by construction — there is no path that
// adds an entry without checking the bounds first.

import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { createNodeFileBridge } from './file-bridge.js';

export type JournalOp = 'write' | 'edit' | 'create' | 'delete' | 'rename';

// Above this many bytes of new content, the after-side is stored as a
// line delta instead of a full blob. The before-blob is always kept whole:
// undo needs the pre-image, and content addressing dedupes it — editing
// the same large file twice stores the before-content once.
export const LARGE_FILE_BYTES = 64 * 1024;

export interface JournalEntryInput {
  path: string;
  op: JournalOp;
  before: string | null;
  // Explicit pre-image hash when before-content is unknowable
  // (reconciliation): the entry records what the hash was, with no blob —
  // readBefore returns null and undo reports non-reversible.
  beforeHash?: string | null;
  after: string | null;
  bytesDelta: number;
  sessionId: string;
  agentId: string;
  toolCallId: string | null;
  timestamp: number;
  unattributed?: boolean;
}

export interface JournalEntry {
  path: string;
  op: JournalOp;
  beforeHash: string | null;
  afterHash: string | null;
  deltaHash: string | null;
  bytesDelta: number;
  sessionId: string;
  agentId: string;
  toolCallId: string | null;
  timestamp: number;
  unattributed?: boolean;
}

export interface RetentionPolicy {
  maxBytes?: number;
  maxAgeMs?: number;
  now?: number;
}

export function sha256Hex(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

type DeltaOp = { eq: number } | { del: number } | { ins: string[] };

// Single-hunk prefix/suffix delta: exact reconstruction, tiny encoding
// for the common case (a few lines changed in a large file). Not a
// minimal diff — storage only, never shown to users.
export function encodeDelta(before: string, after: string): string {
  const a = before.split('\n');
  const b = after.split('\n');
  let prefix = 0;
  while (prefix < a.length && prefix < b.length && a[prefix] === b[prefix]) {
    prefix++;
  }
  let suffix = 0;
  while (
    suffix < a.length - prefix &&
    suffix < b.length - prefix &&
    a[a.length - 1 - suffix] === b[b.length - 1 - suffix]
  ) {
    suffix++;
  }
  const ops: DeltaOp[] = [];
  if (prefix > 0) ops.push({ eq: prefix });
  const del = a.length - prefix - suffix;
  if (del > 0) ops.push({ del });
  const ins = b.slice(prefix, b.length - suffix);
  if (ins.length > 0) ops.push({ ins });
  if (suffix > 0) ops.push({ eq: suffix });
  return JSON.stringify(ops);
}

export function applyDelta(before: string, delta: string): string {
  const lines = before.split('\n');
  const ops = JSON.parse(delta) as DeltaOp[];
  const out: string[] = [];
  let at = 0;
  for (const op of ops) {
    if ('eq' in op) {
      out.push(...lines.slice(at, at + op.eq));
      at += op.eq;
    } else if ('del' in op) {
      at += op.del;
    } else {
      out.push(...op.ins);
    }
  }
  return out.join('\n');
}

export class FileJournalStore {
  readonly indexPath: string;
  private readonly blobsDir: string;

  constructor(dir: string) {
    this.indexPath = join(dir, 'index.jsonl');
    this.blobsDir = join(dir, 'blobs');
  }

  private bridge() {
    return createNodeFileBridge('/');
  }

  append(input: JournalEntryInput): JournalEntry {
    const bridge = this.bridge();
    const beforeHash =
      input.before === null
        ? (input.beforeHash ?? null)
        : sha256Hex(input.before);
    const afterHash = input.after === null ? null : sha256Hex(input.after);
    if (input.before !== null && beforeHash !== null) {
      this.putBlob(bridge, beforeHash, input.before);
    }
    let deltaHash: string | null = null;
    if (input.after !== null && afterHash !== null) {
      if (Buffer.byteLength(input.after, 'utf8') > LARGE_FILE_BYTES) {
        const delta = encodeDelta(input.before ?? '', input.after);
        deltaHash = sha256Hex(delta);
        this.putBlob(bridge, deltaHash, delta);
      } else {
        this.putBlob(bridge, afterHash, input.after);
      }
    }
    const entry: JournalEntry = {
      path: input.path,
      op: input.op,
      beforeHash,
      afterHash,
      deltaHash,
      bytesDelta: input.bytesDelta,
      sessionId: input.sessionId,
      agentId: input.agentId,
      toolCallId: input.toolCallId,
      timestamp: input.timestamp,
      ...(input.unattributed === true ? { unattributed: true } : {}),
    };
    bridge.appendFile(this.indexPath, `${JSON.stringify(entry)}\n`);
    this.enforceRetention({});
    return entry;
  }

  entries(): JournalEntry[] {
    const bridge = this.bridge();
    if (!bridge.exists(this.indexPath)) return [];
    const out: JournalEntry[] = [];
    for (const line of bridge.readTextFile(this.indexPath).split('\n')) {
      if (line.trim() === '') continue;
      try {
        out.push(JSON.parse(line) as JournalEntry);
      } catch {
        // Corrupt lines never poison the journal; they are skipped and
        // dropped by the next retention rewrite.
      }
    }
    return out;
  }

  hasBlob(hash: string): boolean {
    return this.bridge().exists(join(this.blobsDir, hash));
  }

  blobCount(): number {
    const bridge = this.bridge();
    if (!bridge.exists(this.blobsDir)) return 0;
    return bridge
      .listDir(this.blobsDir)
      .filter((info) => !info.isDirectory && !info.isSymbolicLink).length;
  }

  readBefore(entry: JournalEntry): string | null {
    if (entry.beforeHash === null) return null;
    return this.readBlob(entry.beforeHash);
  }

  // After-content: direct blob, or before-blob plus delta for large files.
  // Null for deletes (no after-content exists).
  readAfter(entry: JournalEntry): string | null {
    if (entry.afterHash === null) return null;
    if (entry.deltaHash !== null) {
      const before = this.readBefore(entry) ?? '';
      const delta = this.readBlob(entry.deltaHash);
      if (delta === null) return null;
      return applyDelta(before, delta);
    }
    return this.readBlob(entry.afterHash);
  }

  enforceRetention(policy: RetentionPolicy): {
    entries: number;
    bytes: number;
  } {
    const bridge = this.bridge();
    const now = policy.now ?? Date.now();
    let kept = this.entries();
    if (policy.maxAgeMs !== undefined) {
      const maxAgeMs = policy.maxAgeMs;
      kept = kept.filter((e) => now - e.timestamp <= maxAgeMs);
    }
    if (policy.maxBytes !== undefined) {
      const maxBytes = policy.maxBytes;
      let total = this.blobBytes(bridge, kept);
      while (kept.length > 0 && total > maxBytes) {
        kept.shift();
        total = this.blobBytes(bridge, kept);
      }
    }
    const removed = this.entries().length - kept.length;
    if (removed === 0) return { entries: 0, bytes: 0 };
    const before = this.blobBytes(bridge, this.entries());
    const referenced = new Set<string>();
    for (const e of kept) {
      if (e.beforeHash !== null) referenced.add(e.beforeHash);
      if (e.deltaHash !== null) referenced.add(e.deltaHash);
      else if (e.afterHash !== null) referenced.add(e.afterHash);
    }
    const tmp = `${this.indexPath}.${process.pid}.tmp`;
    bridge.writeFile(
      tmp,
      kept.map((e) => JSON.stringify(e)).join('\n') +
        (kept.length > 0 ? '\n' : ''),
    );
    try {
      bridge.renameFile(tmp, this.indexPath);
    } catch {
      try {
        bridge.remove(tmp, false, true);
      } catch {
        // Best-effort tmp cleanup; the index rewrite is what matters.
      }
      return { entries: 0, bytes: 0 };
    }
    if (bridge.exists(this.blobsDir)) {
      for (const info of bridge.listDir(this.blobsDir)) {
        if (
          !info.isDirectory &&
          !info.isSymbolicLink &&
          !referenced.has(info.name)
        ) {
          try {
            bridge.remove(join(this.blobsDir, info.name), false, true);
          } catch {
            // Best-effort: an orphaned blob is a leak, not corruption.
          }
        }
      }
    }
    const after = this.blobBytes(bridge, kept);
    return { entries: removed, bytes: before - after };
  }

  private putBlob(
    bridge: ReturnType<typeof createNodeFileBridge>,
    hash: string,
    content: string,
  ): void {
    const path = join(this.blobsDir, hash);
    if (bridge.exists(path)) return;
    bridge.writeFile(path, content);
  }

  private readBlob(hash: string): string | null {
    const bridge = this.bridge();
    const path = join(this.blobsDir, hash);
    if (!bridge.exists(path)) return null;
    try {
      return bridge.readTextFile(path);
    } catch {
      return null;
    }
  }

  private blobBytes(
    bridge: ReturnType<typeof createNodeFileBridge>,
    entries: JournalEntry[],
  ): number {
    const seen = new Set<string>();
    let total = 0;
    const add = (hash: string | null): void => {
      if (hash === null || seen.has(hash)) return;
      seen.add(hash);
      const path = join(this.blobsDir, hash);
      try {
        total += bridge.fileInfo(path).size;
      } catch {
        // Missing blob: counts as zero, read paths handle the absence.
      }
    };
    for (const e of entries) {
      add(e.beforeHash);
      if (e.deltaHash !== null) add(e.deltaHash);
      else add(e.afterHash);
    }
    return total;
  }
}

// --- Baseline + reconciliation (issue #17, slice C; §42.5) ----------------

export type Baseline = Record<string, string>;

export interface BaselineOptions {
  outOfScope?: string[];
}

function globToRegExp(glob: string): RegExp {
  const escapable = new Set([
    '+',
    '.',
    '^',
    '$',
    '{',
    '}',
    '(',
    ')',
    '|',
    '[',
    ']',
    '\\',
  ]);
  let out = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i] ?? '';
    if (c === '*') {
      if (glob[i + 1] === '*') {
        out += '.*';
        i++;
      } else {
        out += '[^/]*';
      }
    } else if (c === '?') {
      out += '[^/]';
    } else if (escapable.has(c)) {
      out += `\\${c}`;
    } else {
      out += c;
    }
  }
  return new RegExp(`^${out}$`);
}

interface IgnoreRule {
  negate: boolean;
  dirOnly: boolean;
  anchored: boolean;
  match: RegExp;
  prefix: string;
}

function parseIgnoreFile(content: string): IgnoreRule[] {
  const rules: IgnoreRule[] = [];
  for (const raw of content.split('\n')) {
    const line = raw.trim();
    if (line === '' || line.startsWith('#')) continue;
    const negate = line.startsWith('!');
    const body = negate ? line.slice(1) : line;
    const dirOnly = body.endsWith('/');
    const stripped = dirOnly ? body.slice(0, -1) : body;
    const anchored = stripped.includes('/');
    const pattern = anchored ? stripped.replace(/^\//, '') : stripped;
    rules.push({
      negate,
      dirOnly,
      anchored,
      match: globToRegExp(
        anchored ? pattern : (pattern.split('/').pop() ?? pattern),
      ),
      prefix: stripped,
    });
  }
  return rules;
}

// Common-subset .gitignore matcher: *, ?, **, dir/ prefixes, ! negation
// (last match wins). Exotic forms (character classes beyond ?, rooted
// mid-pattern **) are not covered — documented, and anything missed only
// widens the baseline, never narrows the journal.
function isIgnored(
  rules: IgnoreRule[],
  relPath: string,
  isDir: boolean,
): boolean {
  const name = relPath.split('/').pop() ?? relPath;
  let ignored = false;
  for (const rule of rules) {
    let hit = false;
    if (rule.dirOnly) {
      hit =
        relPath === rule.prefix ||
        relPath.startsWith(`${rule.prefix}/`) ||
        (!rule.anchored && relPath.split('/').includes(rule.prefix));
    } else if (rule.anchored) {
      hit = rule.match.test(relPath);
    } else {
      hit = rule.match.test(name);
    }
    if (hit) ignored = !rule.negate;
    void isDir;
  }
  return ignored;
}

// Metadata walk, not a content copy: hashes only, no blobs. Always skips
// .git/ and .kubic/ (journal state is never journaled), honors the root
// .gitignore, and excludes caller-declared out-of-scope paths.
export function captureBaseline(
  root: string,
  options: BaselineOptions = {},
): Baseline {
  const bridge = createNodeFileBridge('/');
  const outOfScope = new Set(options.outOfScope ?? []);
  let rules: IgnoreRule[] = [];
  if (bridge.exists(join(root, '.gitignore'))) {
    try {
      rules = parseIgnoreFile(bridge.readTextFile(join(root, '.gitignore')));
    } catch {
      rules = [];
    }
  }
  const baseline: Baseline = {};
  const walk = (dir: string, rel: string): void => {
    let infos: ReturnType<typeof bridge.listDir> = [];
    try {
      infos = bridge.listDir(dir);
    } catch {
      return;
    }
    for (const info of [...infos].sort((a, b) => (a.name < b.name ? -1 : 1))) {
      if (info.isSymbolicLink) continue;
      const relPath = rel === '' ? info.name : `${rel}/${info.name}`;
      if (relPath === '.git' || relPath.startsWith('.git/')) continue;
      if (relPath === '.kubic' || relPath.startsWith('.kubic/')) continue;
      if (outOfScope.has(relPath)) continue;
      if (isIgnored(rules, relPath, info.isDirectory)) continue;
      if (info.isDirectory) {
        walk(join(dir, info.name), relPath);
      } else {
        try {
          baseline[relPath] = sha256Hex(
            bridge.readTextFile(join(dir, info.name)),
          );
        } catch {
          // Vanished mid-walk: reconcile treats it as a delete.
        }
      }
    }
  };
  walk(root, '');
  return baseline;
}

export function saveBaseline(
  dir: string,
  runId: string,
  baseline: Baseline,
): void {
  createNodeFileBridge('/').writeFile(
    join(dir, `baseline-${runId}.json`),
    JSON.stringify(baseline),
  );
}

export function loadBaseline(dir: string, runId: string): Baseline | null {
  const bridge = createNodeFileBridge('/');
  const path = join(dir, `baseline-${runId}.json`);
  if (!bridge.exists(path)) return null;
  try {
    return JSON.parse(bridge.readTextFile(path)) as Baseline;
  } catch {
    return null;
  }
}

export interface ReconcileContext {
  sessionId: string;
  agentId: string;
  timestamp: number;
}

export type RestoreResult =
  | { restored: true }
  | { restored: false; reason: string };

// Undo primitive for the next issue's CLI: writes the recorded
// before-content back. Entries without before-content (unattributed
// reconciliation finds) are reported non-reversible — never guessed.
export function restoreEntry(
  store: FileJournalStore,
  entry: JournalEntry,
  root: string,
): RestoreResult {
  const before = store.readBefore(entry);
  if (before === null) {
    return {
      restored: false,
      reason: 'no before-content: unattributed entry is not reversible',
    };
  }
  try {
    createNodeFileBridge('/').writeFile(join(root, entry.path), before);
  } catch (error) {
    return {
      restored: false,
      reason: `restore write failed: ${(error as Error).message}`,
    };
  }
  return { restored: true };
}

// End-of-run sweep: whatever moved without interception gets an
// unattributed entry — sed -i, npm install fallout, formatters, builds.
// Before-content is unknowable for these (the baseline holds hashes, not
// copies), so beforeHash is recorded but no before-blob exists: undo of
// unattributed entries is reported non-reversible by the next issue's CLI.
export function reconcile(
  store: FileJournalStore,
  baseline: Baseline,
  root: string,
  ctx: ReconcileContext,
  options: BaselineOptions = {},
): number {
  const bridge = createNodeFileBridge('/');
  const current = captureBaseline(root, options);
  const latest = new Map<string, { afterHash: string | null }>();
  for (const e of store.entries()) {
    latest.set(e.path, { afterHash: e.afterHash });
  }
  let added = 0;
  const record = (input: {
    path: string;
    op: JournalEntryInput['op'];
    beforeHash: string | null;
    after: string | null;
  }): void => {
    store.append({
      path: input.path,
      op: input.op,
      before: null,
      beforeHash: input.beforeHash,
      after: input.after,
      bytesDelta: 0,
      sessionId: ctx.sessionId,
      agentId: ctx.agentId,
      toolCallId: null,
      timestamp: ctx.timestamp,
      unattributed: true,
    });
    added++;
  };
  for (const [relPath, hash] of Object.entries(current)) {
    if (baseline[relPath] === hash) continue;
    if (latest.get(relPath)?.afterHash === hash) continue;
    let after: string | null = null;
    try {
      after = bridge.readTextFile(join(root, relPath));
    } catch {
      after = null;
    }
    record({
      path: relPath,
      op: baseline[relPath] === undefined ? 'create' : 'write',
      beforeHash: baseline[relPath] ?? null,
      after,
    });
  }
  for (const relPath of Object.keys(baseline)) {
    if (current[relPath] !== undefined) continue;
    if (latest.get(relPath)?.afterHash === null) continue;
    record({
      path: relPath,
      op: 'delete',
      beforeHash: baseline[relPath] ?? null,
      after: null,
    });
  }
  return added;
}
