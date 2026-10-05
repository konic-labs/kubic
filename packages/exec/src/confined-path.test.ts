// Path confinement for state files named by repo-local data (issue #437).
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { confinedStatePath } from './confined-path.js';

const created: string[] = [];

afterEach(() => {
  for (const path of created.splice(0))
    rmSync(path, { recursive: true, force: true });
});

function stateDir(tag: string): string {
  const dir = mkdtempSync(join(tmpdir(), tag));
  created.push(dir);
  const orchDir = join(dir, '.kubic', 'orchestrator');
  mkdirSync(orchDir, { recursive: true });
  return orchDir;
}

describe('confinedStatePath (issue #437)', () => {
  it('allows a plain file inside the dir', () => {
    const dir = stateDir('confined-');
    writeFileSync(join(dir, 'run-1.json'), '{}');
    const found = confinedStatePath(dir, 'run-1.json');
    expect(found.ok).toBe(true);
  });

  it('names a missing file missing, never a crash', () => {
    const dir = stateDir('confined-');
    expect(confinedStatePath(dir, 'nope.json')).toEqual({
      ok: false,
      reason: 'missing',
    });
  });

  it('refuses a `..` escape with outside-root', () => {
    const dir = stateDir('confined-');
    writeFileSync(join(dir, '..', 'decoy.json'), '{}');
    expect(confinedStatePath(dir, '../decoy.json')).toEqual({
      ok: false,
      reason: 'outside-root',
    });
  });

  it('refuses a symlink pointing outside the dir', () => {
    const dir = stateDir('confined-');
    const secret = join(dir, '..', '..', 'secret.json');
    writeFileSync(secret, '{}');
    symlinkSync(secret, join(dir, 'linked.json'));
    expect(confinedStatePath(dir, 'linked.json')).toEqual({
      ok: false,
      reason: 'outside-root',
    });
  });

  it('allows a symlink pointing inside the dir', () => {
    const dir = stateDir('confined-');
    writeFileSync(join(dir, 'real.json'), '{}');
    symlinkSync(join(dir, 'real.json'), join(dir, 'alias.json'));
    const found = confinedStatePath(dir, 'alias.json');
    expect(found.ok).toBe(true);
  });
});
