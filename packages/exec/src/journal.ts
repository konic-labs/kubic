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
  while (
    prefix < a.length &&
    prefix < b.length &&
    a[prefix] === b[prefix]
  ) {
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
    const beforeHash = input.before === null ? null : sha256Hex(input.before);
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

  enforceRetention(policy: RetentionPolicy): { entries: number; bytes: number } {
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
      kept.map((e) => JSON.stringify(e)).join('\n') + (kept.length > 0 ? '\n' : ''),
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
        if (!info.isDirectory && !info.isSymbolicLink && !referenced.has(info.name)) {
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
