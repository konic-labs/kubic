// A read through a symlink resolves like a write does: a path inside the
// workspace that a link leads outside it is refused (`symlink_escape`), so
// a link — shipped in a cloned repository or made with `ln -s` — cannot
// carry `read`, `ls`, `grep` or `find` past the workspace. A link that stays
// inside still works, and a dangling link or a link loop fails without
// hanging. Real trees under mkdtemp, driven through NodeExecutionEnv.

import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NodeExecutionEnv } from '@kubic/exec/env';
import { afterEach, describe, expect, it } from 'vitest';
import { inv } from '../test-support/invocation.js';
import { callOperation } from './registry.js';
import type { OpContext } from './types.js';

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

function tmp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

function ctx(root: string): OpContext {
  return { env: new NodeExecutionEnv(root), sessionId: 's1', agentId: 'a1' };
}

// A workspace with an outside secret, and links to it and around it.
function tree(): { workspace: string; secret: string } {
  const workspace = tmp('link-reads-ws-');
  const outside = tmp('link-reads-outside-');
  const secret = join(outside, 'key.txt');
  writeFileSync(secret, 'TOP SECRET\n');
  writeFileSync(join(workspace, 'inner.txt'), 'inside\n');
  mkdirSync(join(workspace, 'docs'));
  symlinkSync(secret, join(workspace, 'docs', 'link'));
  symlinkSync(outside, join(workspace, 'away'));
  symlinkSync(join(workspace, 'inner.txt'), join(workspace, 'alias'));
  symlinkSync(join(workspace, 'nowhere'), join(workspace, 'dangling'));
  symlinkSync(join(workspace, 'loop-b'), join(workspace, 'loop-a'));
  symlinkSync(join(workspace, 'loop-a'), join(workspace, 'loop-b'));
  return { workspace, secret };
}

describe('reads through a symlink', () => {
  it.each([
    ['read', { path: 'docs/link' }],
    ['read', { path: 'away/key.txt' }],
    ['ls', { path: 'away' }],
    ['grep', { pattern: 'SECRET', root: 'away' }],
    ['find', { root: 'away' }],
  ])('%s %j is refused when the link leads outside', async (name, args) => {
    const { workspace } = tree();
    const out = await callOperation(name, args, inv(), ctx(workspace));
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.error.code).toBe('symlink_escape');
    expect(out.error.message).toContain('outside the workspace');
    expect(out.error.message.includes('TOP SECRET')).toBe(false);
  });

  it('reads a link that stays inside the workspace', async () => {
    const { workspace } = tree();
    const out = await callOperation(
      'read',
      { path: 'alias' },
      inv(),
      ctx(workspace),
    );
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect((out.result as { content: string }).content).toContain('inside');
  });

  it('fails a dangling link and a link loop without hanging', async () => {
    const { workspace } = tree();
    for (const path of ['dangling', 'loop-a']) {
      const out = await callOperation('read', { path }, inv(), ctx(workspace));
      expect(out.ok, path).toBe(false);
    }
  });
});
