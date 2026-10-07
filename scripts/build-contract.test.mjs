// Build/install contract for the `kubic` binary.
// Static repo state, no build needed: asserts the packaging story holds
// together — `npm run build` emits runnable JS to gitignored dist/ with
// no hand-rolled flags, and the committed `bin` wrapper exists,
// is executable, and points at the real composition root.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';

const ROOT = join(import.meta.dirname, '..');

function rootManifest() {
  return JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
}

describe('build/install contract', () => {
  it('root manifest is ESM, exposes the kubic bin, and builds via config', () => {
    const manifest = rootManifest();
    assert.equal(
      manifest.type,
      'module',
      'root package.json needs "type": "module" (else dist .js warns MODULE_TYPELESS)',
    );
    const binTarget = manifest.bin?.kubic;
    assert.ok(
      typeof binTarget === 'string' && binTarget.length > 0,
      'root package.json needs a "bin.kubic" entry',
    );
    assert.ok(
      existsSync(join(ROOT, binTarget)),
      `"bin.kubic" target ${binTarget} must exist in the repo`,
    );
    const buildScript = manifest.scripts?.build;
    assert.ok(
      typeof buildScript === 'string' && buildScript.length > 0,
      'root package.json needs an "npm run build" script',
    );
    assert.doesNotMatch(
      buildScript,
      /--outDir|--noEmit|--declaration|--sourceMap/,
      '"npm run build" takes no hand-rolled tsc flags — emit options live in tsconfig.build.json',
    );
    assert.ok(
      typeof manifest.scripts?.kubic === 'string' &&
        manifest.scripts.kubic.length > 0,
      'root package.json needs an "npm run kubic" runner script',
    );
  });

  it('tsconfig.build.json emits the repo tree to dist/', () => {
    const buildPath = join(ROOT, 'tsconfig.build.json');
    assert.ok(existsSync(buildPath), 'tsconfig.build.json must exist');
    const build = JSON.parse(readFileSync(buildPath, 'utf8'));
    assert.ok(
      typeof build.extends === 'string' &&
        build.extends.includes('tsconfig.base.json'),
      'tsconfig.build.json must extend tsconfig.base.json',
    );
    assert.equal(
      build.compilerOptions?.outDir,
      'dist',
      'build output must go to gitignored dist/',
    );
  });

  it('bin wrapper is executable, has a node shebang, loads the built main', () => {
    const binTarget = rootManifest().bin.kubic;
    const abs = join(ROOT, binTarget);
    const mode = statSync(abs).mode;
    assert.ok(
      (mode & 0o111) !== 0,
      `${binTarget} must be executable (git mode 755)`,
    );
    const content = readFileSync(abs, 'utf8');
    assert.ok(
      content.startsWith('#!/usr/bin/env node'),
      `${binTarget} must start with a node shebang`,
    );
    assert.match(
      content,
      /dist\/apps\/kubic\/src\/main\.js/,
      `${binTarget} must load the built composition root`,
    );
  });

  it('dist/ stays gitignored', () => {
    // Probe a path *under* dist/: `check-ignore -q dist` only matches the
    // dir-only `dist/` pattern when dist/ exists on disk, so a bare probe
    // fails on fresh checkouts where `npm test` runs before any build (CI).
    try {
      execFileSync('git', ['check-ignore', '-q', 'dist/probe.js'], {
        cwd: ROOT,
      });
    } catch {
      assert.fail(
        'dist/ must stay gitignored (git check-ignore -q dist/probe.js)',
      );
    }
  });
});
