// Nested `.gitignore` support in the baseline walk.
//
// `captureBaseline` read only the ROOT `.gitignore`, so every nested ignore
// file — the standard monorepo mechanism, this repo's own layout included —
// was invisible to the walk: nested-ignored build output was baselined at boot
// (hash cost) and then recorded as an unattributed write at sweep time
// whenever a tool built. Pure noise in `diff`/`log`, and journal retention
// pressure from files no one wants tracked.
//
// The walk now accumulates rules per directory as the recursion descends:
// child rules are appended AFTER the parent's — `isIgnored` is
// last-match-wins, so a nested negation overrides a parent ignore, the
// ordering git uses — and the stack pops on recursion exit, so siblings never
// see each other's rules.
//
// With the root-only walk the fixture's `packages/foo/build/out.js`
// IS in the baseline, the nested `!keep.log` has no effect, the walk probes
// `.gitignore` once (root only), and the sweep records the nested-ignored
// write. Each test below states the failure it guards against.

import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createNodeFileBridge, type FileBridge } from '../file-bridge.js';
import { captureBaseline, UNREADABLE_HASH } from './baseline.js';
import { FileJournalStore } from './store.js';
import { reconcile } from './sweep.js';

const CTX = {
  sessionId: 's-nested',
  agentId: 'a-nested',
  timestamp: 1_700_000_000_000,
};

const roots: string[] = [];

function tmpRoot(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

function journalStore(): FileJournalStore {
  return new FileJournalStore(tmpRoot('j-nested-ignore-'));
}

afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

// The fixture: a root ignore file whose rules must keep applying
// inside children (`*.log`, `node_modules/`) plus a nested one whose rules
// must apply to its own subtree and nowhere else.
function workspace(): string {
  const root = tmpRoot('ws-nested-ignore-');
  writeFileSync(join(root, '.gitignore'), '*.log\nnode_modules/\n');
  writeFileSync(join(root, 'keep.txt'), 'keep\n');
  writeFileSync(join(root, 'root.log'), 'noise\n');
  mkdirSync(join(root, 'packages', 'foo', 'build'), { recursive: true });
  // `build/` is the nested ignore; `!keep.log` is the nested negation that
  // must override the parent's `*.log` for this subtree only.
  writeFileSync(
    join(root, 'packages', 'foo', '.gitignore'),
    'build/\n!keep.log\n',
  );
  writeFileSync(join(root, 'packages', 'foo', 'src.js'), 'src\n');
  writeFileSync(join(root, 'packages', 'foo', 'keep.log'), 'kept\n');
  writeFileSync(join(root, 'packages', 'foo', 'build', 'out.js'), 'built\n');
  mkdirSync(join(root, 'packages', 'bar'), { recursive: true });
  writeFileSync(join(root, 'packages', 'bar', 'other.log'), 'noise\n');
  mkdirSync(join(root, 'packages', 'foo', 'node_modules'));
  writeFileSync(
    join(root, 'packages', 'foo', 'node_modules', 'dep.js'),
    'dep\n',
  );
  return root;
}

function readable(path: string): boolean {
  try {
    readFileSync(path);
    return true;
  } catch {
    return false;
  }
}

describe('nested .gitignore in the baseline walk', () => {
  it('excludes a nested-ignored subtree from the baseline', () => {
    const root = workspace();
    const baseline = captureBaseline(root);
    // The failing assertion today: the root-only walk hashes the nested build
    // output and baselines it.
    expect(baseline['packages/foo/build/out.js']).toBeUndefined();
    expect(baseline['packages/foo/build']).toBeUndefined();
    expect(Object.keys(baseline).sort()).toEqual([
      '.gitignore',
      'keep.txt',
      'packages/foo/.gitignore',
      'packages/foo/keep.log',
      'packages/foo/src.js',
    ]);
    // The sweep reads the same tree with the same rules, so the path is not a
    // reconcile find either: an unchanged tree adds nothing.
    const store = journalStore();
    expect(reconcile(store, baseline, root, CTX)).toBe(0);
    expect(store.entries()).toEqual([]);
  });

  it('lets a nested negation override a parent ignore, inside that subtree only', () => {
    const root = workspace();
    const baseline = captureBaseline(root);
    // `!keep.log` in packages/foo/.gitignore is appended AFTER the root
    // `*.log`, so last-match-wins baselines the file — the ordering git uses.
    expect(baseline['packages/foo/keep.log']).toMatch(/^[0-9a-f]{64}$/);
    // The parent rule keeps holding everywhere else: the root's own log and a
    // sibling package's log stay ignored.
    expect(baseline['root.log']).toBeUndefined();
    expect(baseline['packages/bar/other.log']).toBeUndefined();
  });

  it('keeps applying parent rules inside child directories', () => {
    const root = workspace();
    const baseline = captureBaseline(root);
    // The root `node_modules/` rule prunes a nested node_modules exactly as it
    // prunes the root's own — carrying child rules down must not shadow the
    // parent's.
    expect(baseline['packages/foo/node_modules/dep.js']).toBeUndefined();
    expect(baseline['packages/foo/src.js']).toMatch(/^[0-9a-f]{64}$/);
  });

  it('proceeds with the parent rules when a nested .gitignore cannot be read', (ctx) => {
    const root = tmpRoot('ws-nested-unreadable-');
    writeFileSync(join(root, '.gitignore'), '*.tmp\n');
    writeFileSync(join(root, 'keep.txt'), 'keep\n');
    mkdirSync(join(root, 'sub'));
    writeFileSync(join(root, 'sub', 'keep.txt'), 'keep\n');
    writeFileSync(join(root, 'sub', 'scratch.tmp'), 'noise\n');
    const nested = join(root, 'sub', '.gitignore');
    // Would un-ignore `scratch.tmp` if it could be read.
    writeFileSync(nested, '!scratch.tmp\n');
    chmodSync(nested, 0o000);
    if (readable(nested)) {
      // Running as root (or a filesystem without permission bits): the
      // unreadable case cannot be expressed here. Say so instead of passing
      // vacuously.
      ctx.skip();
      return;
    }
    const baseline = captureBaseline(root);
    // The documented widening: the parent rules stay in force, the walk never
    // throws, and nothing is silently un-ignored.
    expect(baseline['sub/scratch.tmp']).toBeUndefined();
    expect(baseline['sub/keep.txt']).toMatch(/^[0-9a-f]{64}$/);
    // The unreadable file itself is recorded as unreadable: its
    // content could not be observed, so reconcile never reads the EACCES as
    // a delete of a file that is still there — and never invents a hash for
    // it either. A walk condition, never a crash.
    expect(baseline['sub/.gitignore']).toBe(UNREADABLE_HASH);
  });

  it('keeps the .git/ and .kubic/ skips hard-first, ahead of any ignore rule', () => {
    const root = tmpRoot('ws-nested-hardskip-');
    // Rules that would un-ignore them if the hard skips were not ahead of the
    // matcher.
    writeFileSync(join(root, '.gitignore'), '!.git/\n!.kubic/\n');
    writeFileSync(join(root, 'keep.txt'), 'keep\n');
    mkdirSync(join(root, '.git'));
    writeFileSync(join(root, '.git', 'HEAD'), 'ref: refs/heads/main\n');
    mkdirSync(join(root, '.kubic'));
    writeFileSync(join(root, '.kubic', 'state.json'), 'runtime\n');
    const baseline = captureBaseline(root);
    expect(Object.keys(baseline).sort()).toEqual(['.gitignore', 'keep.txt']);
  });

  it('records no unattributed entry for a nested-ignored path a tool writes during the run', () => {
    const root = workspace();
    const store = journalStore();
    const baseline = captureBaseline(root);
    // What bypasses interception: a build writing under the nested-ignored
    // directory, and an in-scope tracked file changing.
    writeFileSync(
      join(root, 'packages', 'foo', 'build', 'out.js'),
      'rebuilt\n',
    );
    writeFileSync(join(root, 'keep.txt'), 'changed\n');
    const added = reconcile(store, baseline, root, CTX);
    expect(added).toBe(1);
    expect(store.entries().map((e) => e.path)).toEqual(['keep.txt']);
  });

  it('probes .gitignore exactly once per directory entered (perf smoke)', () => {
    const root = tmpRoot('ws-nested-perf-');
    writeFileSync(join(root, '.gitignore'), 'ignored-dir/\n');
    writeFileSync(join(root, 'keep.txt'), 'keep\n');
    mkdirSync(join(root, 'a', 'b'), { recursive: true });
    writeFileSync(join(root, 'a', 'b', '.gitignore'), '*.tmp\n');
    writeFileSync(join(root, 'a', 'b', 'c.js'), 'c\n');
    writeFileSync(join(root, 'a', 'b', 'x.tmp'), 'noise\n');
    mkdirSync(join(root, 'd'));
    writeFileSync(join(root, 'd', '.gitignore'), 'd-only/\n');
    writeFileSync(join(root, 'd', 'keep.txt'), 'keep\n');
    mkdirSync(join(root, 'ignored-dir'));
    writeFileSync(join(root, 'ignored-dir', 'out.js'), 'built\n');

    const inner = createNodeFileBridge('/');
    const probes: string[] = [];
    const bridge: FileBridge = {
      ...inner,
      exists: (path: string): boolean => {
        if (path.endsWith('.gitignore')) probes.push(path);
        return inner.exists(path);
      },
    };
    const baseline = captureBaseline(root, { bridge });
    // Directories entered: root, a, a/b, d — one probe each. `a` has no ignore
    // file and is still probed exactly once; `ignored-dir` is pruned by the
    // root rule and never entered, so it is never probed.
    expect([...probes].sort()).toEqual(
      [
        join(root, '.gitignore'),
        join(root, 'a', '.gitignore'),
        join(root, 'a', 'b', '.gitignore'),
        join(root, 'd', '.gitignore'),
      ].sort(),
    );
    expect(probes).not.toContain(join(root, 'ignored-dir', '.gitignore'));
    expect(Object.keys(baseline).sort()).toEqual([
      '.gitignore',
      'a/b/.gitignore',
      'a/b/c.js',
      'd/.gitignore',
      'd/keep.txt',
      'keep.txt',
    ]);
  });

  it('does not leak a nested rule into a sibling subtree (the stack pops on exit)', () => {
    // The nested rules are carried down their own path only: `build/` in
    // packages/foo/.gitignore must not reach packages/bar, which is a sibling
    // subtree walked with the root rules alone.
    const root = workspace();
    mkdirSync(join(root, 'packages', 'bar', 'build'));
    writeFileSync(join(root, 'packages', 'bar', 'build', 'out.js'), 'built\n');
    const baseline = captureBaseline(root);
    expect(baseline['packages/bar/build/out.js']).toMatch(/^[0-9a-f]{64}$/);
    expect(baseline['packages/foo/build/out.js']).toBeUndefined();
  });

  it('matches an anchored nested rule against the workspace-relative path', () => {
    // The subset does not re-root a nested rule at its own directory: an
    // anchored nested pattern is matched against the workspace-relative path,
    // so the repo-relative form (`pkg/build/`) is exact...
    const root = tmpRoot('ws-nested-anchored-');
    writeFileSync(join(root, '.gitignore'), '');
    mkdirSync(join(root, 'pkg', 'build'), { recursive: true });
    mkdirSync(join(root, 'pkg', 'sub', 'build'), { recursive: true });
    writeFileSync(join(root, 'pkg', '.gitignore'), 'pkg/build/\nsub/build/\n');
    writeFileSync(join(root, 'pkg', 'build', 'out.js'), 'built\n');
    writeFileSync(join(root, 'pkg', 'sub', 'build', 'out.js'), 'built\n');
    writeFileSync(join(root, 'pkg', 'src.js'), 'src\n');
    const baseline = captureBaseline(root);
    expect(baseline['pkg/build/out.js']).toBeUndefined();
    expect(baseline['pkg/src.js']).toMatch(/^[0-9a-f]{64}$/);
    // ...while a git-style directory-relative one (`sub/build/`, meaning
    // pkg/sub/build/ to git) matches nothing and merely widens the baseline —
    // the documented limit, pinned so it cannot drift silently.
    expect(baseline['pkg/sub/build/out.js']).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('gitignore dir rules at the walk', () => {
  function dirRuleWorkspace(): string {
    const root = tmpRoot('ws-dir-rules-');
    writeFileSync(join(root, '.gitignore'), 'build/\n*.egg-info/\n');
    // Narrowing half: a tracked script named `build` — the `build/` rule
    // names a directory, so the file stays in the baseline.
    writeFileSync(join(root, 'build'), '#!/bin/sh\necho hi\n');
    // The rule still hides a real `build/` directory elsewhere.
    mkdirSync(join(root, 'packages', 'foo', 'build'), { recursive: true });
    writeFileSync(join(root, 'packages', 'foo', 'build', 'out.js'), 'built\n');
    // Widening half: a glob dir rule hides the whole subtree, so its
    // build churn is never hashed or journaled.
    mkdirSync(join(root, 'pkg.egg-info'), { recursive: true });
    writeFileSync(join(root, 'pkg.egg-info', 'PKG-INFO'), 'meta\n');
    writeFileSync(join(root, 'keep.txt'), 'keep\n');
    return root;
  }

  it('keeps a regular file named like a dirOnly rule in the baseline', () => {
    const root = dirRuleWorkspace();
    const baseline = captureBaseline(root);
    expect(baseline.build).toBeDefined();
    expect(baseline['packages/foo/build/out.js']).toBeUndefined();
    expect(baseline['pkg.egg-info/PKG-INFO']).toBeUndefined();
    expect(baseline['keep.txt']).toBeDefined();
  });

  it('hashes nothing under a glob dir rule, so the sweep journals no churn', () => {
    const root = dirRuleWorkspace();
    const baseline = captureBaseline(root);
    expect(baseline['pkg.egg-info/PKG-INFO']).toBeUndefined();
    expect(baseline['pkg.egg-info']).toBeUndefined();
    const store = journalStore();
    expect(reconcile(store, baseline, root, CTX)).toBe(0);
    expect(store.entries()).toEqual([]);
  });
});
