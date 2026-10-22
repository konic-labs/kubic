// What changed in a project since its trust grant. A grant keeps a snapshot of
// the files its fingerprint covers — each file's digest, and its text within
// the walk's bounds — in `trust-snapshots/` beside the store
// (`~/.kubic/trust-snapshots/`), private like the store. Before a changed project is trusted again (the trust question's
// `d` key, `kubic trust`, `kubic trust --diff`), the project as it is now is
// compared against that snapshot, file by file, as unified diffs.
//
// The snapshot is the store's companion, never its authority: the grant is the
// fingerprint in `trust.json`, and a missing or unreadable snapshot only means
// the review has nothing to compare against — it then lists the files the
// grant would cover. Writes go through the exec bridge's locked tmp+rename.

import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import {
  createNodeFileBridge,
  updateFileLocked,
} from '@kubic/exec/file-bridge';
import { unifiedHunks } from '@kubic/exec/journal';
import { tightenStateDir } from '@kubic/exec/lock-file';
import { projectTrustWalk, type TrustedFile } from './trust-fingerprint.js';

const SNAPSHOT_VERSION = 1;
const BRIDGE = createNodeFileBridge('/');

// The lines of one added or removed file a review shows.
const FILE_LINES = 120;

type TrustFileChangeKind = 'added' | 'removed' | 'changed';

interface TrustFileChange {
  readonly name: string;
  readonly kind: TrustFileChangeKind;
  // The diff body: hunks for a changed file, `+`/`-` lines for an added or
  // removed one, or one note when the text was not kept.
  readonly lines: readonly string[];
}

export interface TrustReview {
  readonly key: string;
  // False when no snapshot records what was trusted before: `changes` then
  // lists every file the grant would cover, as added, without content.
  readonly baseline: boolean;
  readonly changes: readonly TrustFileChange[];
}

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

/**
 * Where the snapshot of the grant for `key` lives, beside the store.
 * @internal
 */
export function trustSnapshotPath(storeDir: string, key: string): string {
  return join(storeDir, 'trust-snapshots', `${sha256(key).slice(0, 32)}.json`);
}

function isTrustedFile(value: unknown): value is TrustedFile {
  if (typeof value !== 'object' || value === null) return false;
  const file = value as Record<string, unknown>;
  return (
    typeof file.name === 'string' &&
    typeof file.digest === 'string' &&
    (file.text === undefined || typeof file.text === 'string')
  );
}

function readSnapshot(
  storeDir: string,
  key: string,
): readonly TrustedFile[] | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(BRIDGE.readTextFile(trustSnapshotPath(storeDir, key)));
  } catch {
    return undefined;
  }
  if (typeof parsed !== 'object' || parsed === null) return undefined;
  const record = parsed as Record<string, unknown>;
  if (
    record.v !== SNAPSHOT_VERSION ||
    record.key !== key ||
    !Array.isArray(record.files) ||
    !record.files.every(isTrustedFile)
  ) {
    return undefined;
  }
  return record.files as TrustedFile[];
}

/** Records what a grant for `key` covered. Best-effort: never fails a grant. */
export function saveTrustSnapshot(
  storeDir: string,
  key: string,
  files: readonly TrustedFile[],
): void {
  const path = trustSnapshotPath(storeDir, key);
  try {
    BRIDGE.createDir(dirname(path), true, 0o700);
    tightenStateDir(dirname(path));
    updateFileLocked(
      path,
      () => `${JSON.stringify({ v: SNAPSHOT_VERSION, key, files })}\n`,
      { mode: 0o600 },
    );
  } catch {
    // A review without a snapshot lists the files instead of diffing them.
  }
}

/** Forgets the snapshot of a revoked or declined grant. */
export function dropTrustSnapshot(storeDir: string, key: string): void {
  try {
    BRIDGE.remove(trustSnapshotPath(storeDir, key), false, true);
  } catch {
    // Nothing to forget.
  }
}

function bodyLines(text: string, sign: '+' | '-'): string[] {
  const lines = text.endsWith('\n')
    ? text.slice(0, -1).split('\n')
    : text.split('\n');
  const shown = lines.slice(0, FILE_LINES).map((line) => `${sign}${line}`);
  return lines.length > FILE_LINES
    ? [...shown, `… ${lines.length - FILE_LINES} more lines`]
    : shown;
}

function changeOf(
  name: string,
  before: TrustedFile | undefined,
  after: TrustedFile | undefined,
): TrustFileChange | undefined {
  if (before !== undefined && after !== undefined) {
    if (before.digest === after.digest) return undefined;
    return {
      name,
      kind: 'changed',
      lines:
        before.text !== undefined && after.text !== undefined
          ? unifiedHunks(before.text, after.text)
          : ['(content not kept: binary or too large to compare)'],
    };
  }
  if (after !== undefined) {
    return {
      name,
      kind: 'added',
      lines:
        after.text === undefined
          ? ['(content not kept: binary or too large to show)']
          : bodyLines(after.text, '+'),
    };
  }
  if (before === undefined) return undefined;
  return {
    name,
    kind: 'removed',
    lines:
      before.text === undefined
        ? ['(content not kept: binary or too large to show)']
        : bodyLines(before.text, '-'),
  };
}

/**
 * The project at `key` as it is now, against the snapshot of its grant in
 * `storeDir`. `home` resolves a `~/` systemPromptFile, as the fingerprint does.
 */
export function reviewTrustChanges(
  home: string,
  storeDir: string,
  key: string,
): TrustReview {
  const current = projectTrustWalk(key, home).files;
  const snapshot = readSnapshot(storeDir, key);
  if (snapshot === undefined) {
    return {
      key,
      baseline: false,
      changes: current.map((file) => ({
        name: file.name,
        kind: 'added',
        lines: [],
      })),
    };
  }
  const before = new Map(snapshot.map((file) => [file.name, file]));
  const after = new Map(current.map((file) => [file.name, file]));
  const names = [...new Set([...before.keys(), ...after.keys()])].sort();
  const changes = names.flatMap((name) => {
    const change = changeOf(name, before.get(name), after.get(name));
    return change === undefined ? [] : [change];
  });
  return { key, baseline: true, changes };
}

/**
 * The review as plain lines: one header per file (`--- a/…`/`+++ b/…` for a
 * change, `added …`/`removed …` otherwise) and its body, cut at `maxLines`.
 */
export function renderTrustReview(
  review: TrustReview,
  maxLines = 400,
): string[] {
  if (!review.baseline) {
    const names = review.changes.map((change) => `  ${change.name}`);
    return [
      `no record of what was trusted before in ${review.key}; the grant covers these files — review them before you trust the project:`,
      ...(names.length === 0 ? ['  (none)'] : names),
    ];
  }
  if (review.changes.length === 0) {
    return [`no changes in ${review.key} since the last grant`];
  }
  const out = [
    `${review.changes.length} file${review.changes.length === 1 ? '' : 's'} changed in ${review.key} since the last grant:`,
  ];
  for (const change of review.changes) {
    if (change.kind === 'changed') {
      out.push(`--- a/${change.name}`, `+++ b/${change.name}`);
    } else {
      out.push(`${change.kind} ${change.name}`);
    }
    out.push(...change.lines);
  }
  if (out.length <= maxLines) return out;
  return [
    ...out.slice(0, maxLines),
    `… ${out.length - maxLines} more lines — review the files themselves`,
  ];
}
