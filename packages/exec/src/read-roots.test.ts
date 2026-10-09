// Read-only skill roots: the discovered skills
// outside the workspace are advertised with absolute paths, so exactly those
// paths are readable through the env — every other outside path, and every
// write, keeps the cwd confinement.
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { type FileSystem, NodeExecutionEnv } from './env/index.js';
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
  const workspace = tmp('kubic-read-roots-ws-');
  const home = tmp('kubic-read-roots-home-');
  const skillDir = join(home, '.agents', 'skills', 'a');
  mkdirSync(join(skillDir, 'refs'), { recursive: true });
  const skill = join(skillDir, 'SKILL.md');
  writeFileSync(skill, '---\nname: a\ndescription: A\n---\nBody of a.\n');
  writeFileSync(join(skillDir, 'refs', 'more.md'), 'more\n');
  writeFileSync(join(home, 'secret.txt'), 'nope\n');
  return { workspace, skillDir, skill };
}

describe('read roots', () => {
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

  it('forwards lstat so symlinks stay visible in the workspace and inside a root', () => {
    const { workspace, skillDir } = skillTree();
    symlinkSync('.', join(workspace, 'loop'));
    writeFileSync(join(workspace, 'real.txt'), 'x');
    symlinkSync('SKILL.md', join(skillDir, 'link.md'));
    const env = withReadRoots(new NodeExecutionEnv(workspace), [skillDir]);
    // A workspace path falls through to the base seam …
    expect(env.fs.lstat?.('loop')).toMatchObject({
      isSymbolicLink: true,
      isDirectory: false,
    });
    expect(env.fs.lstat?.('real.txt')).toMatchObject({
      isSymbolicLink: false,
      isFile: true,
    });
    // … and a path inside a read root goes through the root's own seam.
    expect(env.fs.lstat?.(join(skillDir, 'link.md'))?.isSymbolicLink).toBe(
      true,
    );
    expect(env.fs.lstat?.(join(skillDir, 'SKILL.md'))).toMatchObject({
      isSymbolicLink: false,
      isFile: true,
    });
    // Survives the per-call provenance re-derivation the tools perform.
    const derived = env.withProvenance({ ...env.provenance, agentId: 'x' });
    expect(derived.fs.lstat?.('loop')?.isSymbolicLink).toBe(true);
  });

  it('keeps lstat confined outside every root', () => {
    const { workspace, skillDir } = skillTree();
    const env = withReadRoots(new NodeExecutionEnv(workspace), [skillDir]);
    expect(() =>
      env.fs.lstat?.(join(skillDir, '..', '..', '..', 'secret.txt')),
    ).toThrow(/confinement/);
  });

  it('forwards realpath and unlink so the write path resolves and cleans up through the wrapper', () => {
    const { workspace, skillDir, skill } = skillTree();
    writeFileSync(join(workspace, 'real.txt'), 'x\n');
    symlinkSync('real.txt', join(workspace, 'link.txt'));
    const env = withReadRoots(new NodeExecutionEnv(workspace), [skillDir]);
    // A workspace path falls through to the base seam …
    expect(env.fs.realpath?.('link.txt')).toBe(
      realpathSync(join(workspace, 'real.txt')),
    );
    // … and a path inside a read root resolves through the root's own seam.
    expect(env.fs.realpath?.(skill)).toBe(realpathSync(skill));
    // Cleanup reaches the base seam too: without the forward, every failed
    // write in a run with read roots would leak its tmp.
    env.fs.unlink?.('link.txt');
    expect(existsSync(join(workspace, 'link.txt'))).toBe(false);
    // Survives the per-call provenance re-derivation the tools perform.
    const derived = env.withProvenance({ ...env.provenance, agentId: 'x' });
    expect(derived.fs.realpath?.('real.txt')).toBe(
      realpathSync(join(workspace, 'real.txt')),
    );
  });

  it('offers lstat, realpath and unlink only when the base seam does, never inventing one', () => {
    const { workspace, skillDir } = skillTree();
    const bare: FileSystem = {
      readFile: () => '',
      writeFile: () => undefined,
      rename: () => undefined,
      listDir: () => [],
      stat: () => ({ isFile: true, isDirectory: false, size: 0 }),
    };
    const base = new NodeExecutionEnv(workspace);
    const env = withReadRoots(
      {
        cwd: base.cwd,
        fs: bare,
        shell: base.shell,
        provenance: base.provenance,
        withProvenance: () => base,
      },
      [skillDir],
    );
    expect(env.fs.lstat).toBeUndefined();
    expect(env.fs.realpath).toBeUndefined();
    expect(env.fs.unlink).toBeUndefined();
  });
});
