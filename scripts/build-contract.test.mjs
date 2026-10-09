// Build/install contract for the `kubic` binary.
// Static repo state, no build needed: asserts the packaging story holds
// together — `npm run build` bundles the CLI into gitignored dist/kubic.js with
// no hand-rolled flags, tsc only typechecks, and the committed `bin` wrapper
// exists, is executable, and loads that bundle.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { ENTRY, OUTFILE } from './build.mjs';

const ROOT = join(import.meta.dirname, '..');

function rootManifest() {
  return JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
}

describe('build/install contract', () => {
  it('root manifest is ESM, exposes the kubic bin, and builds via the bundler', () => {
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
    assert.equal(
      manifest.scripts?.build,
      'node scripts/build.mjs',
      '"npm run build" runs the bundler script and takes no flags of its own',
    );
    assert.ok(
      typeof manifest.scripts?.kubic === 'string' &&
        manifest.scripts.kubic.length > 0,
      'root package.json needs an "npm run kubic" runner script',
    );
  });

  it('declares the supported Node floor', () => {
    assert.equal(rootManifest().engines?.node, '>=22.19');
  });

  it('tsc only typechecks: no build tsconfig, typecheck is noEmit', () => {
    assert.equal(
      existsSync(join(ROOT, 'tsconfig.build.json')),
      false,
      'tsconfig.build.json must not exist: tsc typechecks, the bundler emits',
    );
    assert.match(
      rootManifest().scripts?.typecheck ?? '',
      /--noEmit/,
      '"npm run typecheck" must not emit',
    );
  });

  it('the bundle is one file, from the composition root into dist/', () => {
    assert.equal(
      OUTFILE,
      'dist/kubic.js',
      'build output must go to gitignored dist/kubic.js',
    );
    assert.ok(
      existsSync(join(ROOT, ENTRY)),
      `bundle entry ${ENTRY} must exist`,
    );
  });

  it('bin wrapper is executable, has a node shebang, loads the bundle', () => {
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
      /\.\.\/dist\/kubic\.js/,
      `${binTarget} must load the built bundle`,
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
