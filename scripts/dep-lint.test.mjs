import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { checkTree } from './dep-lint.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// Every fixture is removed after the file: this suite builds ~50 trees per
// run, so leaking them piles up in the OS temp dir.
const scratchDirs = [];
after(() => {
  for (const dir of scratchDirs) rmSync(dir, { recursive: true, force: true });
});

function scratchDir() {
  const dir = mkdtempSync(join(tmpdir(), 'dep-lint-'));
  scratchDirs.push(dir);
  return dir;
}

function fixtureTree(files) {
  const dir = scratchDir();
  for (const [rel, content] of Object.entries(files)) {
    const full = join(dir, rel);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, content);
  }
  return dir;
}

describe('dep-lint', () => {
  it('passes on the clean skeleton', () => {
    assert.deepEqual(checkTree(ROOT), []);
  });

  it('fails when packages/tui imports host implementation', () => {
    const dir = fixtureTree({
      'packages/tui/src/index.ts': `import { dispatch } from '@kubic/host';\n`,
    });
    const violations = checkTree(dir);
    assert.ok(
      violations.some((v) => v.from === 'tui' && v.to === 'host'),
      `expected tui->host violation, got ${JSON.stringify(violations)}`,
    );
  });

  it('fails when packages/tui imports agent implementation via relative path', () => {
    const dir = fixtureTree({
      'packages/tui/src/views.ts': `import { tools } from '../../agent/src/tools.js';\n`,
    });
    const violations = checkTree(dir);
    assert.ok(
      violations.some((v) => v.from === 'tui' && v.to === 'agent'),
      `expected tui->agent violation, got ${JSON.stringify(violations)}`,
    );
  });

  it('fails when packages/core imports exec', () => {
    const dir = fixtureTree({
      'packages/core/src/session.ts': `import { workspace } from '@kubic/exec';\n`,
    });
    const violations = checkTree(dir);
    assert.ok(
      violations.some((v) => v.from === 'core' && v.to === 'exec'),
      `expected core->exec violation, got ${JSON.stringify(violations)}`,
    );
  });

  it('fails when packages/agent imports host', () => {
    const dir = fixtureTree({
      'packages/agent/src/session.ts': `import { dispatch } from '@kubic/host';\n`,
    });
    const violations = checkTree(dir);
    assert.ok(
      violations.some((v) => v.from === 'agent' && v.to === 'host'),
      `expected agent->host violation, got ${JSON.stringify(violations)}`,
    );
  });

  it('allows tui to import core contracts', () => {
    const dir = fixtureTree({
      'packages/tui/src/index.ts': `import type { LaneSnapshot } from '@kubic/core';\n`,
    });
    assert.deepEqual(checkTree(dir), []);
  });

  it('allows only the tui boundary to touch Pi presentation modules', () => {
    const ok = fixtureTree({
      'packages/tui/src/tui-boundary.ts': `import { VStack } from '@earendil-works/pi-tui';\n`,
    });
    assert.deepEqual(checkTree(ok), []);
    const bad = fixtureTree({
      'packages/tui/src/layout.ts': `import { VStack } from '@earendil-works/pi-tui';\n`,
    });
    const violations = checkTree(bad);
    assert.ok(
      violations.some((v) => v.from === 'tui'),
      `expected tui Pi-seam violation, got ${JSON.stringify(violations)}`,
    );
  });

  it('allows exec to import node:fs for the Node binding', () => {
    const dir = fixtureTree({
      'packages/exec/src/env.ts': `import { readFileSync } from 'node:fs';\n`,
    });
    assert.deepEqual(checkTree(dir), []);
  });

  it('fails when tools import node:fs directly', () => {
    const dir = fixtureTree({
      'packages/agent/src/tools.ts': `import { readFileSync } from 'node:fs';\n`,
    });
    const violations = checkTree(dir);
    assert.ok(
      violations.some((v) => v.from === 'agent'),
      `expected agent node:fs violation, got ${JSON.stringify(violations)}`,
    );
  });

  it('fails when tools import node:child_process directly', () => {
    const dir = fixtureTree({
      'packages/host/src/dispatch.ts': `import { spawn } from 'node:child_process';\n`,
    });
    const violations = checkTree(dir);
    assert.ok(
      violations.some((v) => v.from === 'host'),
      `expected host child_process violation, got ${JSON.stringify(violations)}`,
    );
  });

  it('fails when tools import bare fs directly', () => {
    const dir = fixtureTree({
      'packages/host/src/policy.ts': `import { readFileSync } from 'fs';\n`,
    });
    const violations = checkTree(dir);
    assert.ok(
      violations.some((v) => v.from === 'host'),
      `expected host bare-fs violation, got ${JSON.stringify(violations)}`,
    );
  });

  it('fails when production code imports a test-support helper', () => {
    const dir = fixtureTree({
      'packages/host/src/feature.ts': `import { fake } from './test-support/fake.js';\n`,
    });
    const violations = checkTree(dir);
    assert.ok(
      violations.some(
        (v) =>
          v.from === 'host' &&
          v.file === join('packages', 'host', 'src', 'feature.ts') &&
          v.to === './test-support/fake.js',
      ),
      `expected test-support violation, got ${JSON.stringify(violations)}`,
    );
  });

  it('fails when an app file imports test-support through a package name', () => {
    const dir = fixtureTree({
      'packages/core/src/index.ts': `export const core = 1;\n`,
      'apps/kubic/src/main.ts': `import { sandbox } from '@kubic/exec/src/test-support/git-sandbox.js';\n`,
    });
    const violations = checkTree(dir);
    assert.ok(
      violations.some(
        (v) => v.from === 'kubic' && v.to.includes('test-support'),
      ),
      `expected kubic test-support violation, got ${JSON.stringify(violations)}`,
    );
  });

  it('allows test files and test-support modules to import test-support', () => {
    const dir = fixtureTree({
      'packages/host/src/feature.test.ts': `import { fake } from './test-support/fake.js';\n`,
      'packages/host/src/test-support/fake.ts': `import { base } from './base.js';\n`,
      'packages/host/src/test-support/base.ts': `export const base = 1;\n`,
    });
    assert.deepEqual(checkTree(dir), []);
  });

  it('allows test files to import node builtins for scaffolding', () => {
    const dir = fixtureTree({
      'packages/agent/src/result.test.ts': `import { mkdtempSync } from 'node:fs';\n`,
    });
    assert.deepEqual(checkTree(dir), []);
  });

  it('fails on dynamic import() of a forbidden package', () => {
    const dir = fixtureTree({
      'packages/tui/src/views.ts': `const m = await import('@kubic/host');\n`,
    });
    const violations = checkTree(dir);
    assert.ok(
      violations.some((v) => v.from === 'tui' && v.to === 'host'),
      `expected tui->host violation, got ${JSON.stringify(violations)}`,
    );
  });

  it('fails on require() of a forbidden package', () => {
    const dir = fixtureTree({
      'packages/tui/src/views.ts': `const m = require('@kubic/agent');\n`,
    });
    const violations = checkTree(dir);
    assert.ok(
      violations.some((v) => v.from === 'tui' && v.to === 'agent'),
      `expected tui->agent violation, got ${JSON.stringify(violations)}`,
    );
  });

  it('flags every forbidden edge of each package row exactly', () => {
    const rows = {
      core: ['exec', 'agent', 'host', 'trajectory', 'eval', 'tui'],
      exec: ['agent', 'host', 'trajectory', 'eval', 'tui'],
      agent: ['host', 'tui', 'trajectory', 'eval'],
      host: ['tui'],
      trajectory: ['exec', 'agent', 'host', 'eval', 'tui'],
      eval: ['exec', 'agent', 'host', 'tui'],
      tui: ['exec', 'agent', 'host', 'trajectory', 'eval'],
    };
    for (const [owner, targets] of Object.entries(rows)) {
      const files = {};
      targets.forEach((t, i) => {
        files[`packages/${owner}/src/edge-${i}.ts`] =
          `import { x } from '@kubic/${t}';\n`;
      });
      const violations = checkTree(fixtureTree(files));
      assert.deepEqual(
        violations.map((v) => `${v.from}->${v.to}`).sort(),
        targets.map((t) => `${owner}->${t}`).sort(),
        `wrong edge set for ${owner}`,
      );
    }
  });

  it('treats a self-import as intra-package, not a violation', () => {
    const dir = fixtureTree({
      'packages/core/src/a.ts': `import { b } from '@kubic/core';\n`,
    });
    assert.deepEqual(checkTree(dir), []);
  });

  it('treats an unknown package as forbidden from importing every row', () => {
    const dir = fixtureTree({
      'packages/zzz/src/a.ts': `import { d } from '@kubic/host';\n`,
      'packages/zzz/src/b.ts': `import { c } from '@kubic/core';\n`,
    });
    const violations = checkTree(dir);
    assert.deepEqual(violations.map((v) => `${v.from}->${v.to}`).sort(), [
      'zzz->core',
      'zzz->host',
    ]);
  });

  it('returns no violations when the packages dir is missing', () => {
    const dir = fixtureTree({ 'README.md': 'nothing here\n' });
    assert.deepEqual(checkTree(dir), []);
  });

  it('ignores non-directory entries in packages/', () => {
    const dir = scratchDir();
    writeFileSync(join(dir, 'packages'), 'not a directory\n');
    assert.deepEqual(checkTree(dir), []);
  });

  it('skips node_modules and dist trees', () => {
    const dir = fixtureTree({
      'packages/tui/src/ok.ts': `import { c } from '@kubic/core';\n`,
      'packages/tui/node_modules/dep/index.ts': `import { d } from '@kubic/host';\n`,
      'packages/tui/dist/bundle.ts': `import { d } from '@kubic/host';\n`,
    });
    assert.deepEqual(checkTree(dir), []);
  });

  it('fails when a host folder imports another folder past its entry', () => {
    const dir = fixtureTree({
      'packages/host/src/doctor/doctor.ts': `import { runRunCommand } from '../run/run-cli.js';\n`,
    });
    assert.deepEqual(checkTree(dir), [
      {
        kind: 'folder',
        from: 'host/doctor',
        to: 'host/run',
        file: join('packages', 'host', 'src', 'doctor', 'doctor.ts'),
        line: 1,
      },
    ]);
  });

  it('allows a host folder to import another folder through its entry, and its own modules', () => {
    const dir = fixtureTree({
      'packages/host/src/doctor/doctor.ts': `import { runRunCommand } from '../run/index.js';\nimport { render } from './doctor-render.js';\n`,
      'packages/host/src/doctor/checks/limits.ts': `import { DoctorCheck } from '../doctor.js';\n`,
    });
    assert.deepEqual(checkTree(dir), []);
  });

  it('allows a relative import within the same package', () => {
    const dir = fixtureTree({
      'packages/tui/src/a.ts': `import { b } from './b.js';\n`,
      'packages/tui/src/b.ts': `export const b = 1;\n`,
    });
    assert.deepEqual(checkTree(dir), []);
  });

  it('reports the exact file and line of a violation', () => {
    const dir = fixtureTree({
      'packages/core/src/session.ts': `import { a } from '@kubic/core';\nimport { b } from '@kubic/exec';\n`,
    });
    const violations = checkTree(dir);
    assert.deepEqual(violations, [
      {
        kind: 'edge',
        from: 'core',
        to: 'exec',
        file: join('packages', 'core', 'src', 'session.ts'),
        line: 2,
      },
    ]);
  });

  it('flags node:fs subpaths, bare child_process, and records the spec', () => {
    const dir = fixtureTree({
      'packages/agent/src/a.ts': `import { readFile } from 'node:fs/promises';\n`,
      'packages/host/src/b.ts': `import { exec } from 'child_process';\n`,
      'packages/agent/src/c.ts': `import { spawn } from 'node:child_process/subprocess';\n`,
    });
    const violations = checkTree(dir);
    assert.deepEqual(violations.map((v) => `${v.from}->${v.to}`).sort(), [
      'agent->node:child_process/subprocess',
      'agent->node:fs/promises',
      'host->child_process',
    ]);
  });

  it('allows exec to use node subpath imports', () => {
    const dir = fixtureTree({
      'packages/exec/src/a.ts': `import { readFile } from 'node:fs/promises';\n`,
    });
    assert.deepEqual(checkTree(dir), []);
  });

  it('allows the agent Pi boundary file and flags other Pi users', () => {
    const ok = fixtureTree({
      'packages/agent/src/pi-boundary.ts': `import { createModel } from '@earendil-works/pi-ai';\n`,
    });
    assert.deepEqual(checkTree(ok), []);
    const bad = fixtureTree({
      'packages/agent/src/tools.ts': `import { createModel } from '@earendil-works/pi-ai';\n`,
    });
    const violations = checkTree(bad);
    assert.deepEqual(
      violations.map((v) => `${v.from}->${v.to}`),
      ['agent->@earendil-works/pi-ai'],
    );
  });

  it('scans .mts and .js sources but ignores non-sources', () => {
    const dir = fixtureTree({
      'packages/tui/src/a.mts': `import { d } from '@kubic/host';\n`,
      'packages/tui/src/b.js': `import { d } from '@kubic/host';\n`,
      'packages/tui/src/notes.json': `import { d } from '@kubic/host';\n`,
    });
    const violations = checkTree(dir);
    assert.deepEqual(violations.map((v) => v.file).sort(), [
      join('packages', 'tui', 'src', 'a.mts'),
      join('packages', 'tui', 'src', 'b.js'),
    ]);
  });

  it('exits 0 printing OK on a clean tree via the CLI', () => {
    const dir = fixtureTree({
      'packages/core/src/a.ts': `import { b } from '@kubic/core';\n`,
    });
    const out = execFileSync(
      process.execPath,
      [join(ROOT, 'scripts', 'dep-lint.mjs'), dir],
      { encoding: 'utf8' },
    );
    assert.match(out, /dep-direction OK/);
  });

  it('exits 1 listing violations via the CLI', () => {
    const dir = fixtureTree({
      'packages/core/src/a.ts': `import { b } from '@kubic/exec';\n`,
    });
    // spawnSync, not execFileSync in a try/catch: the catch would also
    // swallow an assert.fail thrown inside the try.
    const result = spawnSync(
      process.execPath,
      [join(ROOT, 'scripts', 'dep-lint.mjs'), dir],
      { encoding: 'utf8' },
    );
    assert.equal(result.status, 1, 'CLI must exit 1 on a violating tree');
    assert.match(result.stdout, /forbidden import core -> exec/);
    assert.match(result.stdout, /1 forbidden import\(s\)/);
    assert.doesNotMatch(result.stdout, /dep-direction OK/);
  });

  it('ignores same-package relative imports for every owner', () => {
    const dir = fixtureTree({
      'packages/tui/src/a.ts': `import { b } from './b.js';\n`,
      'packages/tui/src/b.ts': `export const b = 1;\n`,
    });
    assert.deepEqual(checkTree(dir), []);
  });

  it('short-circuits when packages/ is missing, even with a violating app', () => {
    const dir = fixtureTree({
      'apps/kubic/src/main.ts': `import { fs } from 'node:fs';\n`,
    });
    assert.deepEqual(checkTree(dir), []);
  });

  it('reads the app root for the kubic owner only', () => {
    const dir = fixtureTree({
      'apps/kubic/src/main.ts': `import { c } from '@kubic/core';\n`,
      'packages/kubic/src/a.ts': `import { fs } from 'node:fs';\n`,
      'kubic/src/b.ts': `import { fs } from 'node:fs';\n`,
    });
    assert.deepEqual(checkTree(dir), []);
  });

  it('reports exact lines for fs and Pi-seam violations', () => {
    const dir = fixtureTree({
      'packages/agent/src/a.ts': `import { a } from '@kubic/agent';\nimport { b } from '@kubic/agent';\nimport { fs } from 'node:fs';\n`,
      'packages/tui/src/b.ts': `import { a } from '@kubic/tui';\nimport { V } from '@earendil-works/pi-tui';\n`,
    });
    const byFile = {};
    for (const v of checkTree(dir)) byFile[v.file] = v;
    assert.equal(byFile[join('packages', 'agent', 'src', 'a.ts')].line, 3);
    assert.equal(
      byFile[join('packages', 'agent', 'src', 'a.ts')].to,
      'node:fs',
    );
    assert.equal(byFile[join('packages', 'tui', 'src', 'b.ts')].line, 2);
  });

  it('flags export-from and side-effect imports', () => {
    const dir = fixtureTree({
      'packages/tui/src/a.ts': `export { x } from '@kubic/host';\n`,
      'packages/tui/src/b.ts': `import '@kubic/agent';\n`,
    });
    const violations = checkTree(dir);
    assert.deepEqual(violations.map((v) => `${v.from}->${v.to}`).sort(), [
      'tui->agent',
      'tui->host',
    ]);
  });

  it('flags require() with whitespace', () => {
    const dir = fixtureTree({
      'packages/tui/src/a.ts': `const m = require ('@kubic/host');\n`,
    });
    const violations = checkTree(dir);
    assert.deepEqual(
      violations.map((v) => `${v.from}->${v.to}`),
      ['tui->host'],
    );
  });

  it('flags tui reaching the app root relatively', () => {
    const dir = fixtureTree({
      'packages/tui/src/views.ts': `import { m } from '../../../apps/kubic/src/main.js';\n`,
    });
    const violations = checkTree(dir);
    assert.ok(
      violations.some((v) => v.from === 'tui' && v.to === 'kubic'),
      `expected tui->kubic violation, got ${JSON.stringify(violations)}`,
    );
  });

  it('flags core reaching the app root relatively', () => {
    const dir = fixtureTree({
      'packages/core/src/session.ts': `import { m } from '../../../apps/kubic/src/main.js';\n`,
    });
    const violations = checkTree(dir);
    assert.ok(
      violations.some((v) => v.from === 'core' && v.to === 'kubic'),
      `expected core->kubic violation, got ${JSON.stringify(violations)}`,
    );
  });

  it('flags a package test reaching the app root', () => {
    const dir = fixtureTree({
      'packages/host/src/run-prod-path.test.ts': `import { d } from '../../../apps/kubic/src/prod-runners.js';\n`,
    });
    const violations = checkTree(dir);
    assert.ok(
      violations.some((v) => v.from === 'host' && v.to === 'kubic'),
      `expected host->kubic violation, got ${JSON.stringify(violations)}`,
    );
  });

  it('allows the agent lane to import its permission module', () => {
    const dir = fixtureTree({
      'packages/agent/src/lane/policy.ts': `import type { PermissionClasses } from '../../policy.js';\n`,
    });
    assert.deepEqual(checkTree(dir), []);
  });

  it('flags a relative import into another package, even on an allowed edge', () => {
    const dir = fixtureTree({
      'packages/host/src/config.ts': `import { c } from '../../core/src/cli/kit.js';\n`,
    });
    assert.deepEqual(
      checkTree(dir).map((v) => `${v.kind}:${v.from}->${v.to}`),
      ['relative:host->core'],
    );
  });

  it('flags the composition root reaching a package by a relative path', () => {
    const dir = fixtureTree({
      'packages/core/src/index.ts': `export const core = 1;\n`,
      'apps/kubic/src/main.ts': `import { p } from '../../../packages/core/src/cli/prompt.js';\n`,
    });
    assert.deepEqual(
      checkTree(dir).map((v) => `${v.kind}:${v.from}->${v.to}`),
      ['relative:kubic->core'],
    );
  });

  it('flags a relative vitest mock path into another package', () => {
    const dir = fixtureTree({
      'packages/host/src/models.test.ts': `vi.mock('../../agent/src/tools.js', () => ({}));\n`,
    });
    assert.deepEqual(
      checkTree(dir).map((v) => `${v.kind}:${v.from}->${v.to}`),
      ['relative:host->agent'],
    );
  });

  it('reads the app manifest name @kubic/cli as the composition root', () => {
    const dir = fixtureTree({
      'packages/tui/src/views.ts': `import { m } from '@kubic/cli/main';\n`,
    });
    assert.deepEqual(
      checkTree(dir).map((v) => `${v.kind}:${v.from}->${v.to}`),
      ['edge:tui->kubic'],
    );
  });

  it('flags root test code reaching a package by a relative path', () => {
    const dir = fixtureTree({
      'packages/tui/src/index.ts': `export const tui = 1;\n`,
      'test/fake-terminal.ts': `import type { Terminal } from '../packages/tui/src/tui-boundary.js';\n`,
    });
    assert.deepEqual(
      checkTree(dir).map((v) => `${v.kind}:${v.from}->${v.to}`),
      ['relative:root->tui'],
    );
  });

  it('flags a repo script reaching a package by a relative path', () => {
    const dir = fixtureTree({
      'packages/exec/src/index.ts': `export const exec = 1;\n`,
      'scripts/runtime-check.mjs': `import { x } from '../packages/exec/src/runtime-exclude.ts';\n`,
    });
    assert.deepEqual(
      checkTree(dir).map((v) => `${v.kind}:${v.from}->${v.to}`),
      ['relative:root->exec'],
    );
  });

  it('lets root test code import a package by name', () => {
    const dir = fixtureTree({
      'packages/tui/src/index.ts': `export const tui = 1;\n`,
      'test/fake-terminal.ts': `import type { Terminal } from '@kubic/tui/tui-boundary';\n`,
    });
    assert.deepEqual(checkTree(dir), []);
  });

  it('lets a package test import the root test fixtures by relative path', () => {
    const dir = fixtureTree({
      'packages/tui/src/screen.test.ts': `import { fake } from '../../../test/fake-terminal.js';\n`,
    });
    assert.deepEqual(checkTree(dir), []);
  });

  it('leaves scripts test files alone: their fixtures are source text', () => {
    const dir = fixtureTree({
      'packages/exec/src/index.ts': `export const exec = 1;\n`,
      'scripts/dep-fixture.test.mjs':
        "const src = `import { x } from '../packages/exec/src/a.js';`;\n",
    });
    assert.deepEqual(checkTree(dir), []);
  });

  it('dep-lint module has no import side effects', async () => {
    const writes = [];
    const original = process.stdout.write.bind(process.stdout);
    process.stdout.write = (chunk) => {
      writes.push(String(chunk));
      return true;
    };
    try {
      await import(`./dep-lint.mjs?silent=${Date.now()}`);
    } finally {
      process.stdout.write = original;
    }
    assert.deepEqual(writes, []);
  });
});
