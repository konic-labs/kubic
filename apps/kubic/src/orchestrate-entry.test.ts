// Worker entry resolution (issue #179): the child `kubic run` is spawned
// through the same bin wrapper that launched this manager — resolved from
// the composition root's own module, never argv[1] or the cwd. Pure unit
// test: no filesystem, no child process, no temp dirs.
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { resolveWorkerEntryScript } from './orchestrate-run.js';

describe('worker entry resolution (issue #179)', () => {
  it('resolves bin/kubic.js from the built module, ignoring argv[1] and cwd', () => {
    // A bin symlink named `kubic` (no .js suffix) from a foreign cwd: the
    // old argv[1]/cwd fallback spawned a nonexistent <cwd>/bin/kubic.js.
    const entry = resolveWorkerEntryScript(
      join('/install', 'dist', 'apps', 'kubic', 'src', 'orchestrate-run.js'),
      (dir: string) => dir === '/install',
    );
    expect(entry).toBe(join('/install', 'bin', 'kubic.js'));
  });

  it('resolves bin/kubic.js from the source tree the same way', () => {
    const entry = resolveWorkerEntryScript(
      join('/repo', 'apps', 'kubic', 'src', 'orchestrate-run.ts'),
      (dir: string) => dir === '/repo',
    );
    expect(entry).toBe(join('/repo', 'bin', 'kubic.js'));
  });

  it('returns undefined when no ancestor carries the wrapper — never a cwd-derived path', () => {
    expect(
      resolveWorkerEntryScript('/nowhere/deep/mod.js', () => false),
    ).toBeUndefined();
  });
});
