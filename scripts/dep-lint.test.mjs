import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
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

function fixtureTree(files) {
  const dir = mkdtempSync(join(tmpdir(), 'dep-lint-'));
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
});

describe('layout (issue #2)', () => {
  it('every §64 skeleton path exists', () => {
    const missing = REQUIRED_PATHS.filter((p) => !existsSync(join(ROOT, p)));
    assert.deepEqual(missing, []);
  });
});
