// The baseline digest cache: a run's baseline walk hashes every file it
// visits, and on an unchanged tree most of that reading repeats the last
// run's. The cache keeps each file's digest with its size, modification time,
// change time and inode, and a later walk reuses the digest when all four
// still match.
//
// Racily-clean files are re-hashed: a file modified within the timestamp
// granularity of the walk that hashed it could change again without its
// modification time moving, so an entry is only trusted when the file's
// times are older than that walk's start by a safety margin (git's rule for
// its index). A change that keeps the size and restores the modification
// time still moves the change time, which no user tool can set.
//
// One private JSON file per workspace (0600 in a 0700 directory). A missing,
// corrupt, foreign or older-format file is ignored; concurrent runs simply
// leave the last writer's cache, which is valid either way.

import type { BridgeFileInfo, FileBridge } from '../file-bridge.js';
import { createNodeFileBridge } from '../file-bridge.js';

const CACHE_VERSION = 1;

// Coarse file systems keep 1–2 s timestamps: a file touched this close to
// the walk that hashed it is racy.
const RACY_MARGIN_MS = 2000;

// size, mtimeMs, ctimeMs, ino, digest
type CachedFile = readonly [number, number, number, number, string];

interface CacheFile {
  v: number;
  root: string;
  capturedAt: number;
  files: Record<string, CachedFile>;
}

export interface BaselineCache {
  /** The digest recorded for `rel`, when the file is provably unchanged. */
  reuse(rel: string, info: BridgeFileInfo): string | undefined;
  /** Every digest the current walk computed or reused. */
  record(rel: string, info: BridgeFileInfo, digest: string): void;
}

export interface RunBaselineCache extends BaselineCache {
  /** Start a walk: what it records becomes the next cache. */
  begin(now: number): void;
  /** End a walk: its records replace the cache, persisted when a path is set. */
  commit(): void;
}

function parse(text: string, root: string): CacheFile | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (typeof parsed !== 'object' || parsed === null) return undefined;
  const file = parsed as Partial<CacheFile>;
  if (
    file.v !== CACHE_VERSION ||
    file.root !== root ||
    typeof file.capturedAt !== 'number' ||
    typeof file.files !== 'object' ||
    file.files === null
  ) {
    return undefined;
  }
  return file as CacheFile;
}

/**
 * The cache for one workspace `root`, seeded from `path` when one is given
 * and readable, and saved there after each walk.
 */
export function createBaselineCache(
  root: string,
  path?: string,
  bridge: FileBridge = createNodeFileBridge('/'),
): RunBaselineCache {
  let prior: CacheFile | undefined;
  if (path !== undefined) {
    try {
      prior = parse(bridge.readTextFile(path), root);
    } catch {
      prior = undefined;
    }
  }
  let next: CacheFile = { v: CACHE_VERSION, root, capturedAt: 0, files: {} };
  return {
    begin: (now) => {
      next = { v: CACHE_VERSION, root, capturedAt: now, files: {} };
    },
    reuse: (rel, info) => {
      const cached = prior?.files[rel];
      if (prior === undefined || cached === undefined) return undefined;
      if (info.ctimeMs === undefined || info.ino === undefined)
        return undefined;
      const [size, mtimeMs, ctimeMs, ino, digest] = cached;
      const unchanged =
        size === info.size &&
        mtimeMs === info.mtimeMs &&
        ctimeMs === info.ctimeMs &&
        ino === info.ino;
      const settled =
        Math.max(info.mtimeMs, info.ctimeMs) <
        prior.capturedAt - RACY_MARGIN_MS;
      return unchanged && settled ? digest : undefined;
    },
    record: (rel, info, digest) => {
      if (info.ctimeMs === undefined || info.ino === undefined) return;
      next.files[rel] = [
        info.size,
        info.mtimeMs,
        info.ctimeMs,
        info.ino,
        digest,
      ];
    },
    commit: () => {
      prior = next;
      if (path === undefined) return;
      try {
        const tmp = `${path}.${process.pid}.tmp`;
        bridge.writeFile(tmp, JSON.stringify(next), { mode: 0o600 });
        bridge.renameFile(tmp, path);
      } catch {
        // A cache that cannot be saved only costs the next run its reuse.
      }
    },
  };
}
