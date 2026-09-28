// Read-only skill roots (issue #173; §29.2, §29.3): the discovered skills
// outside the workspace are advertised with absolute paths, so exactly those
// paths are readable through the env — every other outside path, and every
// write, keeps the cwd confinement.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { NodeExecutionEnv } from './env.js';
import { readRootFor, withReadRoots } from './read-roots.js';

const made: string[] = [];

function tmp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  made.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of made.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

function skillTree(): { workspace: string; skillDir: string; skill: string } {
  const workspace = tmp('kubic-173-ws-');
  const home = tmp('kubic-173-home-');
  const skillDir = join(home, '.agents', 'skills', 'a');
  mkdirSync(join(skillDir, 'refs'), { recursive: true });
  const skill = join(skillDir, 'SKILL.md');
  writeFileSync(skill, '---\nname: a\ndescription: A\n---\nBody of a.\n');
  writeFileSync(join(skillDir, 'refs', 'more.md'), 'more\n');
  writeFileSync(join(home, 'secret.txt'), 'nope\n');
  return { workspace, skillDir, skill };
}

describe('read roots (issue #173)', () => {
  it('matches a path inside a root, never a sibling or a prefix-shaped name', () => {
    expect(readRootFor(['/h/skills/a'], '/h/skills/a/SKILL.md')).toBe(
      '/h/skills/a',
    );
    expect(readRootFor(['/h/skills/a'], '/h/skills/a')).toBe('/h/skills/a');
    expect(
      readRootFor(['/h/skills/a'], '/h/skills/ab/SKILL.md'),
    ).toBeUndefined();
    expect(readRootFor(['/h/skills/a'], '/h/skills/a/../b.md')).toBeUndefined();
    expect(readRootFor(['/h/skills/a'], 'SKILL.md')).toBeUndefined();
  });

  it('reads a discovered skill and its directory by absolute path', () => {
    const { workspace, skillDir, skill } = skillTree();
    const env = withReadRoots(new NodeExecutionEnv(workspace), [skillDir]);
    expect(env.fs.readFile(skill)).toContain('Body of a.');
    expect(env.fs.readFile(join(skillDir, 'refs', 'more.md'))).toBe('more\n');
    expect(env.fs.stat(skill).isFile).toBe(true);
    const range = env.fs.readFileRange?.(skill, 0, 3);
    expect(Buffer.from(range ?? []).toString('utf8')).toBe('---');
    // Survives the per-call provenance re-derivation the tools perform.
    const derived = env.withProvenance({ ...env.provenance, agentId: 'x' });
    expect(derived.fs.readFile(skill)).toContain('Body of a.');
  });

  it('keeps every write and every unrelated outside read confined', () => {
    const { workspace, skillDir, skill } = skillTree();
    const env = withReadRoots(new NodeExecutionEnv(workspace), [skillDir]);
    expect(() => env.fs.writeFile(skill, 'pwned')).toThrow(/confinement/);
    expect(() =>
      env.fs.readFile(join(skillDir, '..', '..', '..', 'secret.txt')),
    ).toThrow(/confinement/);
    expect(() => env.fs.listDir(skillDir)).toThrow(/confinement/);
    // The workspace itself is untouched.
    env.fs.writeFile('inside.txt', 'ok');
    expect(env.fs.readFile('inside.txt')).toBe('ok');
  });
});
