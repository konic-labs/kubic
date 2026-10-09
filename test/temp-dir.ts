// Temp directories for tests: `tempDir()` makes one under the OS temp dir,
// and every directory a test file made is removed after each of its tests.
// Importing this module registers the cleanup in the importing test file
// (vitest evaluates it once per file).
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach } from 'vitest';

const made: string[] = [];

afterEach(() => {
  for (const dir of made.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

/** A fresh directory, removed after the current test. */
export function tempDir(prefix = 'kubic-'): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  made.push(dir);
  return dir;
}
