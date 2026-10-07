import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const TSC = join(ROOT, 'node_modules', '.bin', 'tsc');

// Discovered, not hand-listed, so "every package/app" stays true as the
// workspace grows.
const PACKAGES = ['packages', 'apps'].flatMap((top) =>
  readdirSync(join(ROOT, top), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => `${top}/${entry.name}`),
);

const scratchDirs = [];
after(() => {
  for (const dir of scratchDirs) rmSync(dir, { recursive: true, force: true });
});

function tscFails(cwd, args) {
  try {
    execFileSync(TSC, args, { cwd, stdio: 'pipe', encoding: 'utf8' });
  } catch (err) {
    return (err.stdout ?? '') + (err.stderr ?? '');
  }
  return null;
}

function negativeFixture(name, source) {
  const dir = mkdtempSync(join(tmpdir(), `erasable-${name}-`));
  scratchDirs.push(dir);
  writeFileSync(join(dir, 'fixture.ts'), source);
  writeFileSync(
    join(dir, 'tsconfig.json'),
    JSON.stringify({
      extends: join(ROOT, 'tsconfig.base.json'),
      compilerOptions: { types: [] },
      include: ['fixture.ts'],
    }),
  );
  return dir;
}

describe('erasable-syntax config (issue #3)', () => {
  it('base enables erasableSyntaxOnly + verbatimModuleSyntax', () => {
    const base = JSON.parse(
      readFileSync(join(ROOT, 'tsconfig.base.json'), 'utf8'),
    );
    assert.equal(base.compilerOptions.erasableSyntaxOnly, true);
    assert.equal(base.compilerOptions.verbatimModuleSyntax, true);
  });

  it('every package/app tsconfig extends the base and typechecks', () => {
    // Floor: 8 packages + apps/kubic — a collapsed discovery must not pass.
    assert.ok(PACKAGES.length >= 9, `saw only ${PACKAGES.join(', ')}`);
    for (const pkg of PACKAGES) {
      const file = join(ROOT, pkg, 'tsconfig.json');
      assert.ok(existsSync(file), `missing ${pkg}/tsconfig.json`);
      const cfg = JSON.parse(readFileSync(file, 'utf8'));
      assert.ok(
        typeof cfg.extends === 'string' &&
          cfg.extends.endsWith('tsconfig.base.json'),
        `${pkg}/tsconfig.json must extend tsconfig.base.json`,
      );
      try {
        execFileSync(TSC, ['--noEmit', '-p', file], {
          stdio: 'pipe',
          encoding: 'utf8',
        });
      } catch (err) {
        assert.fail(
          `${pkg} typecheck failed:\n${err.stdout ?? ''}${err.stderr ?? ''}`,
        );
      }
    }
  });

  it('engines floor is declared as >=22.19', () => {
    const root = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
    assert.equal(root.engines.node, '>=22.19');
  });

  it('parameter properties fail with the erasable-syntax error', () => {
    const dir = negativeFixture(
      'param-prop',
      'class C {\n  constructor(private x: number) {}\n}\n',
    );
    const output = tscFails(dir, [
      '--noEmit',
      '-p',
      join(dir, 'tsconfig.json'),
    ]);
    assert.ok(
      output !== null,
      'tsc passed on parameter properties — expected failure',
    );
    assert.match(output, /TS1294.*erasableSyntaxOnly/);
  });

  it('enums fail with the erasable-syntax error', () => {
    const dir = negativeFixture('enum', 'enum E {\n  A,\n}\n');
    const output = tscFails(dir, [
      '--noEmit',
      '-p',
      join(dir, 'tsconfig.json'),
    ]);
    assert.ok(output !== null, 'tsc passed on enum — expected failure');
    assert.match(output, /TS1294.*erasableSyntaxOnly/);
  });

  it('namespaces fail with the erasable-syntax error', () => {
    const dir = negativeFixture(
      'namespace',
      'namespace N {\n  export const x = 1;\n}\n',
    );
    const output = tscFails(dir, [
      '--noEmit',
      '-p',
      join(dir, 'tsconfig.json'),
    ]);
    assert.ok(output !== null, 'tsc passed on namespace — expected failure');
    assert.match(output, /TS1294.*erasableSyntaxOnly/);
  });

  it('import = require() fails with the erasable-syntax error', () => {
    const dir = negativeFixture(
      'import-eq',
      "import fs = require('node:fs');\nexport const x = fs;\n",
    );
    const output = tscFails(dir, [
      '--noEmit',
      '-p',
      join(dir, 'tsconfig.json'),
    ]);
    assert.ok(output !== null, 'tsc passed on import = — expected failure');
    assert.match(output, /\(1,1\): error TS1294.*erasableSyntaxOnly/);
  });

  it('export = fails with the erasable-syntax error', () => {
    const dir = negativeFixture('export-eq', 'const x = 1;\nexport = x;\n');
    const output = tscFails(dir, [
      '--noEmit',
      '-p',
      join(dir, 'tsconfig.json'),
    ]);
    assert.ok(output !== null, 'tsc passed on export = — expected failure');
    assert.match(output, /\(2,1\): error TS1294.*erasableSyntaxOnly/);
  });

  it('CI runs tests, typecheck, dep-lint, and biome', () => {
    const file = join(ROOT, '.github', 'workflows', 'ci.yml');
    assert.ok(existsSync(file), 'missing .github/workflows/ci.yml');
    const yml = readFileSync(file, 'utf8');
    for (const needle of ['npm test', 'typecheck', 'lint:deps', 'biome']) {
      assert.ok(yml.includes(needle), `ci.yml must run ${needle}`);
    }
  });
});
