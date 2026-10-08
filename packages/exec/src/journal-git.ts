// Git pre-images for the reconcile sweep.
//
// The baseline walk holds sha256 hashes, not content, so a bash `rm` or
// `sed -i` on a tracked file could never be undone even though its pre-image
// sits in the git object store. This module is the git plumbing behind that
// fix; the sweep policy (when a pre-image may be used) lives in `journal.ts`
// `reconcile`, and the run lifecycle (capture/persist/pass to the sweep) in
// `journal-reconcile.ts`.
//
// Cost contract: the baseline stays a metadata walk. Capturing OIDs costs
// exactly two git invocations — `ls-files -s` (index blob OIDs) and `status
// --porcelain` (the stat-clean check) — and never reads a blob. Blob content
// is read only on the sweep path, only for files the sweep already found
// changed or deleted, and only under a byte bound (a `cat-file -s` size
// pre-check first). Only files clean against the index at baseline qualify:
// restoring a committed version over uncommitted work would destroy it, so
// dirty tracked files keep today's non-reversible reporting.
//
// Fail-open throughout: any git failure (non-repo, missing binary, odd
// output) reads as "no git information" and the sweep behaves exactly as
// before. Nothing here throws except an unsafe run id at persist time.

import { spawnSync } from 'node:child_process';
import { createNodeFileBridge } from './file-bridge.js';
import type { Baseline } from './journal.js';

/** Workspace-relative path → index blob OID, for files clean at baseline. */
export type GitBaseline = Record<string, string>;

export interface GitCommandResult {
  status: number | null;
  stdout: Buffer;
}

/**
 * The git seam. Production spawns `git -C <root>` on the inherited
 * environment; tests script it to observe call counts and outputs without a
 * repository. Args always start with `-C <root>` (see `defaultGitCommand`),
 * so a fake may locate the subcommand after it.
 */
export type GitCommand = (args: string[], root: string) => GitCommandResult;

const GIT_TIMEOUT_MS = 10_000;

function defaultGitCommand(args: string[], root: string): GitCommandResult {
  try {
    const result = spawnSync('git', ['-C', root, ...args], {
      encoding: 'buffer',
      timeout: GIT_TIMEOUT_MS,
    });
    if (result.error !== undefined) {
      return { status: null, stdout: Buffer.alloc(0) };
    }
    const stdout = Buffer.isBuffer(result.stdout)
      ? result.stdout
      : Buffer.from(result.stdout ?? []);
    return { status: result.status, stdout };
  } catch {
    return { status: null, stdout: Buffer.alloc(0) };
  }
}

// A blob OID as `ls-files -s` prints it: sha1 (40 hex) or sha256 (64 hex).
// The check doubles as injection armor — the OID is interpolated into
// `cat-file` argv (never a shell), and only a hex digest gets that far.
const OID_PATTERN = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;

/** Parse `ls-files -s -z` into path → { oid, stage, mode }. */
function parseLsFiles(
  stdout: Buffer,
): Map<string, { oid: string; stage: string; mode: string }> {
  const out = new Map<string, { oid: string; stage: string; mode: string }>();
  for (const record of stdout.toString('utf8').split('\0')) {
    if (record === '') continue;
    // `<mode> <oid> <stage>\t<path>`; -z disables quoting, so the path is raw.
    const match = /^([0-7]+) ([0-9a-f]+) ([0-3])\t([\s\S]*)$/.exec(record);
    if (match === null) return new Map();
    const [, mode, oid, stage, path] = match as unknown as [
      string,
      string,
      string,
      string,
      string,
    ];
    if (
      mode === undefined ||
      oid === undefined ||
      stage === undefined ||
      path === undefined
    ) {
      return new Map();
    }
    out.set(path, { oid, stage, mode });
  }
  return out;
}

/**
 * Parse `status --porcelain=v1 --untracked-files=no --no-renames -z` into
 * the dirty path set, or null when a record is not git-shaped. `--no-renames`
 * keeps one path per record (never `orig -> new`), so every record's tail
 * is a dirty path. A malformed record fails the whole parse:
 * an empty set would read as "nothing dirty" and bless possibly-dirty
 * OIDs on the strength of the downstream hash verify alone — fail closed
 * instead, the same as a failed git call.
 */
function parsePorcelain(stdout: Buffer): Set<string> | null {
  const dirty = new Set<string>();
  for (const record of stdout.toString('utf8').split('\0')) {
    if (record === '') continue;
    // `XY <path>`; unmerged rows (`UU`, `AA`, …) are dirty by construction.
    const match = /^.{2} ([\s\S]*)$/.exec(record);
    if (match?.[1] === undefined) return null;
    dirty.add(match[1]);
  }
  return dirty;
}

/**
 * Index blob OIDs for the baseline-visible files clean against the index,
 * or null when git cannot answer (non-repo, missing binary, parse failure).
 * The two calls are both metadata: no blob is read here.
 */
export function captureGitBaseline(
  root: string,
  baseline: Baseline,
  runGit: GitCommand = defaultGitCommand,
): GitBaseline | null {
  const ls = runGit(['ls-files', '-s', '-z'], root);
  if (ls.status !== 0) return null;
  const status = runGit(
    ['status', '--porcelain=v1', '--untracked-files=no', '--no-renames', '-z'],
    root,
  );
  if (status.status !== 0) return null;
  const tracked = parseLsFiles(ls.stdout);
  if (tracked.size === 0 && ls.stdout.length > 0) return null;
  const dirty = parsePorcelain(status.stdout);
  if (dirty === null) return null;
  const out: GitBaseline = {};
  for (const [path, info] of tracked) {
    // Only the baseline-visible files qualify (the walk skips .git/,
    // .kubic/, gitignored and out-of-scope paths — an OID for one of those
    // could never be a sweep candidate), only merged index rows (stage 0),
    // never a submodule (mode 160000 names a commit, not a blob) and never
    // a symlink (mode 120000 names its target, not content a restore could
    // use — skipped explicitly, not via the walk's exclusion).
    if (baseline[path] === undefined) continue;
    if (info.stage !== '0') continue;
    if (info.mode === '160000' || info.mode === '120000') continue;
    if (!OID_PATTERN.test(info.oid)) continue;
    // The stat-clean check: anything `status` names differs from the index
    // (worktree edit, staged change, unmerged) and must keep today's
    // non-reversible reporting.
    if (dirty.has(path)) continue;
    out[path] = info.oid;
  }
  return out;
}

/**
 * The blob's bytes, or null. A `cat-file -s` size pre-check runs first so a
 * huge pre-image is refused without reading it; the OID pattern check keeps
 * arbitrary revisions out of `cat-file` argv.
 */
export function readGitBlob(
  root: string,
  oid: string,
  maxBytes: number,
  runGit: GitCommand = defaultGitCommand,
): Uint8Array | null {
  if (!OID_PATTERN.test(oid)) return null;
  const sizeOut = runGit(['cat-file', '-s', oid], root);
  if (sizeOut.status !== 0) return null;
  const size = Number.parseInt(sizeOut.stdout.toString('utf8').trim(), 10);
  if (!Number.isSafeInteger(size) || size < 0 || size > maxBytes) return null;
  const content = runGit(['cat-file', 'blob', oid], root);
  if (content.status !== 0) return null;
  return content.stdout;
}

/**
 * Where a run's HEAD was at baseline — the commit, the branch
 * (or `(detached)`), and how many stashes existed. Compared at sweep: any
 * difference means the agent moved HEAD (`checkout`, `reset`, `stash`), and
 * the sweep appends a marker entry instead of letting hundreds of
 * unattributed file entries pretend nothing happened.
 */
export interface HeadState {
  head: string;
  branch: string;
  stash: number;
}

/**
 * Read the current HEAD state, or null when git cannot answer (non-repo,
 * unborn HEAD, missing binary — fail-open, the sweep then emits no
 * marker). Three metadata calls, no content reads.
 */
export function captureHeadState(
  root: string,
  runGit: GitCommand = defaultGitCommand,
): HeadState | null {
  const headOut = runGit(['rev-parse', 'HEAD'], root);
  if (headOut.status !== 0) return null;
  const head = headOut.stdout.toString('utf8').trim();
  if (!/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/.test(head)) return null;
  const branchOut = runGit(['symbolic-ref', '--short', '-q', 'HEAD'], root);
  const branch =
    branchOut.status === 0 && branchOut.stdout.toString('utf8').trim() !== ''
      ? branchOut.stdout.toString('utf8').trim()
      : '(detached)';
  const stashOut = runGit(['stash', 'list', '--format=%H'], root);
  if (stashOut.status !== 0) return null;
  const stash = stashOut.stdout
    .toString('utf8')
    .split('\n')
    .filter((line) => line.trim() !== '').length;
  return { head, branch, stash };
}

const RUN_ID_PATTERN = /^[A-Za-z0-9_-]+$/;

function gitBaselinePath(dir: string, runId: string): string {
  if (!RUN_ID_PATTERN.test(runId)) {
    throw new Error(
      `invalid run id ${JSON.stringify(runId)} (use [A-Za-z0-9_-])`,
    );
  }
  return `${dir}/baseline-${runId}.git.json`;
}

export function saveGitBaseline(
  dir: string,
  runId: string,
  git: GitBaseline,
): void {
  createNodeFileBridge('/').writeFile(
    gitBaselinePath(dir, runId),
    JSON.stringify(git),
  );
}

function headStatePath(dir: string, runId: string): string {
  if (!RUN_ID_PATTERN.test(runId)) {
    throw new Error(
      `invalid run id ${JSON.stringify(runId)} (use [A-Za-z0-9_-])`,
    );
  }
  return `${dir}/baseline-${runId}.head.json`;
}

export function sameHeadState(a: HeadState, b: HeadState): boolean {
  return a.head === b.head && a.branch === b.branch && a.stash === b.stash;
}

export function saveHeadState(
  dir: string,
  runId: string,
  head: HeadState,
): void {
  createNodeFileBridge('/').writeFile(
    headStatePath(dir, runId),
    JSON.stringify(head),
  );
}
