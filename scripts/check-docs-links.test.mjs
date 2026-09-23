import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { checkDocsDeps, checkDocsLinks } from './check-docs-links.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

function fixture(files) {
  const dir = mkdtempSync(join(tmpdir(), 'docs-links-'));
  for (const [rel, content] of Object.entries(files)) {
    const full = join(dir, rel);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, content);
  }
  return dir;
}

describe('check-docs-links', () => {
  it('passes on the real docs/ scaffold (no dangling internal links)', () => {
    const result = checkDocsLinks(ROOT);
    assert.deepEqual(result.broken, []);
    assert.ok(
      result.files >= 19,
      `expected >=19 docs pages, got ${result.files}`,
    );
    assert.ok(result.links > 0, 'expected at least one internal link');
  });

  it('reports a dangling relative link', () => {
    const dir = fixture({ 'docs/a.md': '[gone](./missing.md)\n' });
    const result = checkDocsLinks(dir);
    assert.equal(result.broken.length, 1);
    assert.match(result.broken[0], /missing\.md/);
  });

  it('ignores external URLs and same-page anchors', () => {
    const dir = fixture({
      'docs/a.md':
        '[web](https://example.com/x) [mail](mailto:a@b.c) [here](#section)\n',
    });
    const result = checkDocsLinks(dir);
    assert.deepEqual(result.broken, []);
  });
});

describe('check-docs-links deps (issue #63 review)', () => {
  const AGENTS_CORE_ONLY = `## Dep-direction neighbours

- May import: [@kubic/core](core.md) only.
- Imported by: [@kubic/worker](worker.md).

\`\`\`text
core ──→ agents
\`\`\`
`;

  it('passes on the real tree (neighbours match dep-lint edges)', () => {
    const result = checkDocsDeps(ROOT);
    assert.deepEqual(result.mismatches, []);
    assert.ok(result.edges > 0, 'expected at least one internal edge');
  });

  it('fails when May-import misses an actual edge (agents->exec)', () => {
    const dir = fixture({
      'packages/agents/src/memory.ts': `import type { FileBridge } from '../../exec/src/file-bridge.js';\n`,
      'packages/exec/src/file-bridge.ts': `export type FileBridge = {};\n`,
      'docs/packages/agents-pkg.md': AGENTS_CORE_ONLY,
    });
    const result = checkDocsDeps(dir);
    assert.ok(
      result.mismatches.some((m) =>
        m.includes('May-import missing actual edge agents -> exec'),
      ),
      `expected agents->exec drift, got ${JSON.stringify(result.mismatches)}`,
    );
  });

  it('fails on a fabricated Imported-by (trajectory imports nothing)', () => {
    const dir = fixture({
      'packages/agents/src/task.ts': `export type AgentTask = {};\n`,
      'docs/packages/agents-pkg.md': `## Dep-direction neighbours

- May import: [@kubic/core](core.md).
- Imported by: [@kubic/trajectory](trajectory.md) (structural snapshots).
`,
    });
    const result = checkDocsDeps(dir);
    assert.ok(
      result.mismatches.some((m) =>
        m.includes('no trajectory -> agents edge in tree'),
      ),
      `expected trajectory fabrication, got ${JSON.stringify(result.mismatches)}`,
    );
  });

  it('fails when the README diagram labels agents core-only', () => {
    const dir = fixture({
      'packages/agents/src/memory.ts': `import type { FileBridge } from '../../exec/src/file-bridge.js';\n`,
      'packages/exec/src/file-bridge.ts': `export type FileBridge = {};\n`,
      'docs/packages/agents-pkg.md': `## Dep-direction neighbours

- May import: [@kubic/core](core.md), [@kubic/exec](exec.md) only.
`,
      'docs/packages/README.md': `## Import direction

\`\`\`text
@kubic/exec  @kubic/agents  @kubic/trajectory   ← core only
\`\`\`
`,
    });
    const result = checkDocsDeps(dir);
    assert.ok(
      result.mismatches.some((m) =>
        m.includes('diagram says "core only" for agents'),
      ),
      `expected README drift, got ${JSON.stringify(result.mismatches)}`,
    );
  });

  it('ignores test scaffolding (host prod-path tests drive apps/kubic)', () => {
    const dir = fixture({
      'packages/host/src/run.ts': `import { x } from '@kubic/worker';\n`,
      'packages/host/src/run-prod-path.test.ts': `import { runHeadlessPrompt } from '../../../apps/kubic/src/headless-run.js';\n`,
      'packages/worker/src/tools.ts': `export const x = 1;\n`,
      'apps/kubic/src/headless-run.ts': `import { x } from '../../../packages/host/src/run.js';\nexport function runHeadlessPrompt() {}\n`,
      'docs/packages/host.md': `## Dep-direction neighbours

- May import: core, exec, [worker](worker.md), [agents](agents-pkg.md),
  [trajectory](trajectory.md), [eval](eval.md).
- Imported by: \`apps/kubic\`.
`,
    });
    const result = checkDocsDeps(dir);
    assert.deepEqual(result.mismatches, []);
  });
});
