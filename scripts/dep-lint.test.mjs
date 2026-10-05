import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { checkTree } from './dep-lint.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// §64 skeleton paths required by issue #2 (relative to repo root).
const REQUIRED_PATHS = [
  'packages/core/src/index.ts',
  'packages/core/src/session.ts',
  'packages/core/src/protocol.ts',
  'packages/core/src/policy.ts',
  'packages/exec/src/index.ts',
  'packages/exec/src/workspace.ts',
  'packages/exec/src/paths.ts',
  'packages/exec/src/env.ts',
  'packages/worker/src/index.ts',
  'packages/worker/src/session.ts',
  'packages/worker/src/tools.ts',
  'packages/worker/src/approval-client.ts',
  'packages/host/src/index.ts',
  'packages/host/src/dispatch.ts',
  'packages/host/src/worker-manager.ts',
  'packages/host/src/credentials.ts',
  'packages/host/src/root-agent.ts',
  'packages/agents/src/index.ts',
  'packages/agents/src/roles.ts',
  'packages/agents/src/lifecycle.ts',
  'packages/agents/src/graph.ts',
  'packages/agents/src/budget.ts',
  'packages/trajectory/src/index.ts',
  'packages/eval/src/index.ts',
  'packages/tui/src/index.ts',
  'packages/tui/src/views.ts',
  'packages/tui/src/components.ts',
  'apps/kubic/src/main.ts',
  'apps/kubic/package.json',
  'package.json',
  'tsconfig.base.json',
  'biome.json',
];

// Every fixture is removed after the file: this suite builds ~50 trees per
// run (and Stryker's tap run repeats it per mutant), so leaking them piles
// up six-figure dir counts in the OS temp dir.
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

describe('dep-lint (issue #2)', () => {
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

  it('fails when packages/tui imports worker implementation via relative path', () => {
    const dir = fixtureTree({
      'packages/tui/src/views.ts': `import { tools } from '../../worker/src/tools.js';\n`,
    });
    const violations = checkTree(dir);
    assert.ok(
      violations.some((v) => v.from === 'tui' && v.to === 'worker'),
      `expected tui->worker violation, got ${JSON.stringify(violations)}`,
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

  it('fails when packages/worker imports host', () => {
    const dir = fixtureTree({
      'packages/worker/src/session.ts': `import { dispatch } from '@kubic/host';\n`,
    });
    const violations = checkTree(dir);
    assert.ok(
      violations.some((v) => v.from === 'worker' && v.to === 'host'),
      `expected worker->host violation, got ${JSON.stringify(violations)}`,
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
      'packages/worker/src/tools.ts': `import { readFileSync } from 'node:fs';\n`,
    });
    const violations = checkTree(dir);
    assert.ok(
      violations.some((v) => v.from === 'worker'),
      `expected worker node:fs violation, got ${JSON.stringify(violations)}`,
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

  it('allows test files to import node builtins for scaffolding', () => {
    const dir = fixtureTree({
      'packages/worker/src/result.test.ts': `import { mkdtempSync } from 'node:fs';\n`,
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
      'packages/tui/src/views.ts': `const m = require('@kubic/worker');\n`,
    });
    const violations = checkTree(dir);
    assert.ok(
      violations.some((v) => v.from === 'tui' && v.to === 'worker'),
      `expected tui->worker violation, got ${JSON.stringify(violations)}`,
    );
  });

  it('flags every forbidden edge of each package row exactly', () => {
    const rows = {
      core: ['exec', 'worker', 'host', 'agents', 'trajectory', 'eval', 'tui'],
      exec: ['worker', 'host', 'agents', 'trajectory', 'eval', 'tui'],
      worker: ['host', 'tui'],
      host: ['tui'],
      agents: ['host', 'worker', 'tui', 'trajectory', 'eval'],
      trajectory: ['exec', 'worker', 'host', 'agents', 'eval', 'tui'],
      eval: ['exec', 'worker', 'host', 'tui'],
      tui: ['exec', 'worker', 'host', 'agents', 'trajectory', 'eval'],
      extensions: ['worker', 'host', 'tui', 'kubic'],
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

  it('flags an extensions file reaching the app root relatively', () => {
    const dir = fixtureTree({
      'packages/extensions/src/facets.ts': `import { m } from '../../../apps/kubic/src/main.js';\n`,
    });
    const violations = checkTree(dir);
    assert.ok(
      violations.some((v) => v.from === 'extensions' && v.to === 'kubic'),
      `expected extensions->kubic violation, got ${JSON.stringify(violations)}`,
    );
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
        from: 'core',
        to: 'exec',
        file: join('packages', 'core', 'src', 'session.ts'),
        line: 2,
      },
    ]);
  });

  it('flags node:fs subpaths, bare child_process, and records the spec', () => {
    const dir = fixtureTree({
      'packages/worker/src/a.ts': `import { readFile } from 'node:fs/promises';\n`,
      'packages/host/src/b.ts': `import { exec } from 'child_process';\n`,
      'packages/worker/src/c.ts': `import { spawn } from 'node:child_process/subprocess';\n`,
    });
    const violations = checkTree(dir);
    assert.deepEqual(violations.map((v) => `${v.from}->${v.to}`).sort(), [
      'host->child_process',
      'worker->node:child_process/subprocess',
      'worker->node:fs/promises',
    ]);
  });

  it('allows exec to use node subpath imports', () => {
    const dir = fixtureTree({
      'packages/exec/src/a.ts': `import { readFile } from 'node:fs/promises';\n`,
    });
    assert.deepEqual(checkTree(dir), []);
  });

  it('allows the worker Pi boundary file and flags other Pi users', () => {
    const ok = fixtureTree({
      'packages/worker/src/pi-boundary.ts': `import { createModel } from '@earendil-works/pi-ai';\n`,
    });
    assert.deepEqual(checkTree(ok), []);
    const bad = fixtureTree({
      'packages/worker/src/tools.ts': `import { createModel } from '@earendil-works/pi-ai';\n`,
    });
    const violations = checkTree(bad);
    assert.deepEqual(
      violations.map((v) => `${v.from}->${v.to}`),
      ['worker->@earendil-works/pi-ai'],
    );
  });

  it('fires both package and facet violations for a tui facet importing host', () => {
    const dir = fixtureTree({
      'packages/extensions/src/tui/panel.ts': `import { d } from '@kubic/host';\n`,
    });
    const violations = checkTree(dir);
    assert.deepEqual(violations.map((v) => `${v.from}->${v.to}`).sort(), [
      'extensions->host',
      'extensions->host (tui facet)',
    ]);
  });

  it('fires only the package violation outside a tui facet', () => {
    const dir = fixtureTree({
      'packages/extensions/src/facets.ts': `import { d } from '@kubic/host';\n`,
    });
    const violations = checkTree(dir);
    assert.deepEqual(
      violations.map((v) => `${v.from}->${v.to}`),
      ['extensions->host'],
    );
  });

  it('fires the facet rule on host-like relative specs, not on lookalikes', () => {
    const dir = fixtureTree({
      'packages/extensions/src/tui/a.ts': `import { h } from './host/util.js';\n`,
      'packages/extensions/src/tui/b.ts': `import { h } from './hostile/util.js';\n`,
    });
    const violations = checkTree(dir);
    assert.deepEqual(
      violations.map((v) => `${v.from}->${v.to}`),
      ['extensions->host (tui facet)'],
    );
  });

  it('matches tui facets by filename prefix, not by substring', () => {
    const prefixed = fixtureTree({
      'packages/extensions/src/tui.panel.ts': `import { d } from '@kubic/host';\n`,
    });
    assert.deepEqual(
      checkTree(prefixed)
        .map((v) => `${v.from}->${v.to}`)
        .sort(),
      ['extensions->host', 'extensions->host (tui facet)'],
    );
    const substring = fixtureTree({
      'packages/extensions/src/mytui.ts': `import { d } from '@kubic/host';\n`,
    });
    assert.deepEqual(
      checkTree(substring).map((v) => `${v.from}->${v.to}`),
      ['extensions->host'],
    );
  });

  it('reports only the package violation for a Pi import (seam rule short-circuits)', () => {
    const dir = fixtureTree({
      'packages/extensions/src/worker/agent.ts': `import { V } from '@earendil-works/pi-tui';\n`,
    });
    const violations = checkTree(dir);
    assert.deepEqual(
      violations.map((v) => `${v.from}->${v.to}`),
      ['extensions->@earendil-works/pi-tui'],
    );
  });

  it('fires the worker facet rule on a relative pi-tui spec', () => {
    const dir = fixtureTree({
      'packages/extensions/src/worker/agent.ts': `import { V } from '../pi-tui/panel.js';\n`,
    });
    const violations = checkTree(dir);
    assert.deepEqual(
      violations.map((v) => `${v.from}->${v.to}`),
      ['extensions->../pi-tui/panel.js (worker facet)'],
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
      'packages/extensions/src/a.ts': `import { b } from './b.js';\n`,
      'packages/extensions/src/b.ts': `export const b = 1;\n`,
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

  it('reports exact lines for fs, Pi-seam, and facet violations', () => {
    const dir = fixtureTree({
      'packages/worker/src/a.ts': `import { a } from '@kubic/worker';\nimport { b } from '@kubic/worker';\nimport { fs } from 'node:fs';\n`,
      'packages/tui/src/b.ts': `import { a } from '@kubic/tui';\nimport { V } from '@earendil-works/pi-tui';\n`,
      'packages/extensions/src/tui/c.ts': `import { d } from '@kubic/host';\n`,
    });
    const byFile = {};
    for (const v of checkTree(dir)) byFile[v.file] = v;
    assert.equal(byFile[join('packages', 'worker', 'src', 'a.ts')].line, 3);
    assert.equal(
      byFile[join('packages', 'worker', 'src', 'a.ts')].to,
      'node:fs',
    );
    assert.equal(byFile[join('packages', 'tui', 'src', 'b.ts')].line, 2);
    assert.equal(
      byFile[join('packages', 'extensions', 'src', 'tui', 'c.ts')].line,
      1,
    );
  });

  it('flags export-from and side-effect imports', () => {
    const dir = fixtureTree({
      'packages/tui/src/a.ts': `export { x } from '@kubic/host';\n`,
      'packages/tui/src/b.ts': `import '@kubic/worker';\n`,
    });
    const violations = checkTree(dir);
    assert.deepEqual(violations.map((v) => `${v.from}->${v.to}`).sort(), [
      'tui->host',
      'tui->worker',
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

  it('flags tui importing the extensions package (issue #369)', () => {
    const dir = fixtureTree({
      'packages/tui/src/views.ts': `import { b } from '@kubic/extensions';\n`,
    });
    const violations = checkTree(dir);
    assert.ok(
      violations.some((v) => v.from === 'tui' && v.to === 'extensions'),
      `expected tui->extensions violation, got ${JSON.stringify(violations)}`,
    );
  });

  it('flags tui reaching the app root relatively (issue #369)', () => {
    const dir = fixtureTree({
      'packages/tui/src/views.ts': `import { m } from '../../../apps/kubic/src/main.js';\n`,
    });
    const violations = checkTree(dir);
    assert.ok(
      violations.some((v) => v.from === 'tui' && v.to === 'kubic'),
      `expected tui->kubic violation, got ${JSON.stringify(violations)}`,
    );
  });

  it('flags core importing the extensions package (issue #369)', () => {
    const dir = fixtureTree({
      'packages/core/src/session.ts': `import { b } from '@kubic/extensions';\n`,
    });
    const violations = checkTree(dir);
    assert.ok(
      violations.some((v) => v.from === 'core' && v.to === 'extensions'),
      `expected core->extensions violation, got ${JSON.stringify(violations)}`,
    );
  });

  it('flags core reaching the app root relatively (issue #369)', () => {
    const dir = fixtureTree({
      'packages/core/src/session.ts': `import { m } from '../../../apps/kubic/src/main.js';\n`,
    });
    const violations = checkTree(dir);
    assert.ok(
      violations.some((v) => v.from === 'core' && v.to === 'kubic'),
      `expected core->kubic violation, got ${JSON.stringify(violations)}`,
    );
  });

  it('still lets prod-path tests reach extensions but not the app root (issues #369, #387)', () => {
    // Test scaffolding is exempt for the extensions facade only: host/tui
    // prod-path tests wire the real builders from packages/extensions.
    // Since #387 the composition root's behaviour tests live under
    // apps/kubic, so a package test reaching the app root is a
    // dependency inversion and fails the gate.
    const dir = fixtureTree({
      'packages/host/src/run-prod-path.test.ts': `import { b } from '@kubic/extensions';\n`,
      'packages/tui/src/tui-command.test.ts': `import { b } from '@kubic/extensions';\n`,
    });
    assert.deepEqual(checkTree(dir), []);
  });

  it('flags a package test reaching the app root (issue #387)', () => {
    const dir = fixtureTree({
      'packages/host/src/run-prod-path.test.ts': `import { d } from '../../../apps/kubic/src/prod-runners.js';\n`,
    });
    const violations = checkTree(dir);
    assert.ok(
      violations.some((v) => v.from === 'host' && v.to === 'kubic'),
      `expected host->kubic violation, got ${JSON.stringify(violations)}`,
    );
  });

  it('still flags an extensions test reaching the app root (issue #369)', () => {
    const dir = fixtureTree({
      'packages/extensions/src/e.test.ts': `import { m } from '../../../apps/kubic/src/main.js';\n`,
    });
    const violations = checkTree(dir);
    assert.ok(
      violations.some((v) => v.from === 'extensions' && v.to === 'kubic'),
      `expected extensions->kubic violation, got ${JSON.stringify(violations)}`,
    );
  });

  it('allows worker importing agents: recorded drift (issue #369)', () => {
    // Beyond the §64 diagram's `worker ──▶ exec, core`: the lane builds on
    // agents roles/policy/task contracts (design-drift item 17).
    const dir = fixtureTree({
      'packages/worker/src/lane/policy.ts': `import type { PermissionClasses } from '../../../agents/src/policy.js';\n`,
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

describe('layout (issue #2)', () => {
  it('every §64 skeleton path exists', () => {
    const missing = REQUIRED_PATHS.filter((p) => !existsSync(join(ROOT, p)));
    assert.deepEqual(missing, []);
  });
});
