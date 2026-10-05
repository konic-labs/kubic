// Host-side git guard (issue #363).
//
// A worker or solo agent can plant `.git/hooks/*` or set `core.hooksPath` /
// `core.fsmonitor` in the shared `.git/config`. The orchestrator's own
// commit and merge then execute that code — and it keeps running on the
// user's later git commands — while the journal never sees the change
// (the sweep skips `.git/` and `.kubic/` by design).
//
// Three layers share one spelling here (the filesystem snapshot itself lives in
// `packages/exec/src/git-guard-snapshot.ts`, because only exec touches
// node:fs):
//  1. argv guard — every host-side git invocation runs with
//     `-c core.hooksPath=/dev/null -c core.fsmonitor=false`, and commits
//     additionally pass `--no-verify` (`git merge` has no such flag; the
//     hooksPath override already disables its hooks). `-c` beats repo
//     config, so even a tampered `.git/config` cannot re-enable hooks.
//  2. drift report — `diffGitGuardSnapshots` compares the run-start
//     snapshot against a settle snapshot and names the drift. The `.git`
//     entry may be a pointer file (`gitdir: <path>`, linked worktrees),
//     which the snapshot follows to the real gitdir.
//  3. approval — `isGitDirTarget` names writes under `<workspace>/.git/`
//     for the `kubic-state-write` (always-ask) capability in
//     `packages/host/src/approvals.ts`.

import { join, relative, resolve, sep } from 'node:path';
import type { GitGuardSnapshot } from '../../../../exec/src/git-guard-snapshot.js';

/** `-c` overrides prepended to every host-side git invocation (issue #363). */
export const HOST_GIT_CONFIG_ARGS: readonly string[] = [
  '-c',
  'core.hooksPath=/dev/null',
  '-c',
  'core.fsmonitor=false',
];

/** Extra flags for host-side commits only (issue #363). */
export const HOST_GIT_COMMIT_EXTRA_ARGS: readonly string[] = ['--no-verify'];

function hasGuardPrefix(args: readonly string[]): boolean {
  return (
    args.length >= HOST_GIT_CONFIG_ARGS.length &&
    HOST_GIT_CONFIG_ARGS.every((flag, index) => args[index] === flag)
  );
}

/**
 * Prepend the hooksPath/fsmonitor overrides ahead of the subcommand.
 * Idempotent: an already-guarded argv is returned unchanged (as a copy).
 */
export function withHostGitGuard(args: readonly string[]): string[] {
  if (hasGuardPrefix(args)) return [...args];
  return [...HOST_GIT_CONFIG_ARGS, ...args];
}

/**
 * Guard plus `--no-verify` for host-side commits. Idempotent.
 */
export function withHostGitCommitGuard(args: readonly string[]): string[] {
  const guarded = withHostGitGuard(args);
  if (guarded.includes('--no-verify')) return guarded;
  return [...guarded, '--no-verify'];
}

function shortHash(hash: string): string {
  return hash.slice(0, 12);
}

/**
 * Human-readable drift lines between a run-start snapshot and a settle
 * snapshot; empty when nothing changed. Callers report each line on the
 * run's report channel (the worker journal already records the offending
 * tool call; these lines name the drift it left behind).
 */
export function diffGitGuardSnapshots(
  before: GitGuardSnapshot,
  after: GitGuardSnapshot,
): string[] {
  const lines: string[] = [];
  if (before.gitDir !== after.gitDir) {
    lines.push(
      `git guard: gitdir moved during the run (${before.gitDir} -> ${after.gitDir}) — ` +
        `re-verify hooks and config before merging`,
    );
    return lines;
  }
  if (before.configHash !== after.configHash) {
    const from =
      before.configHash === undefined
        ? 'absent'
        : `sha256:${shortHash(before.configHash)}`;
    const to =
      after.configHash === undefined
        ? 'absent'
        : `sha256:${shortHash(after.configHash)}`;
    lines.push(
      `git guard: .git/config changed during the run (${from} -> ${to}) — ` +
        `check core.hooksPath / core.fsmonitor before trusting later git commands`,
    );
  }
  if (before.hooksDirMissing !== after.hooksDirMissing) {
    lines.push(
      after.hooksDirMissing
        ? 'git guard: .git/hooks directory removed during the run'
        : 'git guard: .git/hooks directory appeared during the run — inspect it before trusting later git commands',
    );
  }
  for (const name of Object.keys(after.hooks).sort()) {
    const prev = before.hooks[name];
    if (prev === undefined) {
      lines.push(
        `git guard: hook planted during the run: .git/hooks/${name} — ` +
          `remove it before trusting later git commands`,
      );
    } else if (prev !== after.hooks[name]) {
      lines.push(
        `git guard: hook modified during the run: .git/hooks/${name} — ` +
          `inspect it before trusting later git commands`,
      );
    }
  }
  for (const name of Object.keys(before.hooks).sort()) {
    if (after.hooks[name] === undefined) {
      lines.push(`git guard: hook removed during the run: .git/hooks/${name}`);
    }
  }
  return lines;
}

function stripSurroundingQuotes(target: string): string {
  if (
    target.length >= 2 &&
    ((target.startsWith('"') && target.endsWith('"')) ||
      (target.startsWith("'") && target.endsWith("'")))
  ) {
    return target.slice(1, -1);
  }
  return target;
}

/**
 * True when a write target lands at or under `<workspace>/.git/` —
 * lexically (no fs access), case-folded like the control-plane guard
 * (macOS/Windows filesystems are case-insensitive). `..` escapes resolve
 * outside and do not match; globs stay literal and still match by prefix.
 */
export function isGitDirTarget(workspace: string, target: string): boolean {
  const trimmed = stripSurroundingQuotes(target.trim());
  if (trimmed === '') return false;
  const ws = resolve(workspace);
  const abs = resolve(ws, trimmed);
  const gitDir = `${join(ws, '.git')}${sep}`;
  const folded = abs.toLowerCase();
  const foldedGitDir = gitDir.toLowerCase();
  if (folded === foldedGitDir.slice(0, -1)) return true;
  if (!folded.startsWith(foldedGitDir)) return false;
  // The target resolves under .git/: confirm the FIRST segment below the
  // workspace really is `.git` (a prefix hit on a case-folded sibling like
  // `.github/` is impossible here, but belt and braces cost nothing).
  const rel = relative(ws.toLowerCase(), folded);
  return rel === '.git' || rel.startsWith(`.git${sep}`);
}
