// The design-explorer builder must fail loudly on a dangling `§` reference
// (issue #100, item 19). README.md and docs/describe the build as validating
// cross-references and "failing loudly on a dangling reference"; before this
// test the builder printed a WARNINGS block and always exited 0.
//
// The tools live under docs/design/, which is gitignored (`.gitignore:24`) —
// a fresh clone and CI have no copy. So this test SKIPS when the builder is absent and runs
// the real script whenever it is present, which is the only arrangement in
// which "prove the builder fails" is meaningful without tracking the tooling.
//
// Behaviour pinned: a dangling `§N.M` exits non-zero, names the offending
// reference, and writes nothing (fail-closed) — the healthy document still
// builds with exit 0 and unchanged byte output for the same input.

import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const made: string[] = [];

function mkTmp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  made.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of made.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

const repoRoot = resolve(import.meta.dirname, '../../../');
const builder = join(repoRoot, 'docs/design/tools/build-explorer.mjs');
const config = join(repoRoot, 'docs/design/explorer.config.json');
const doc = join(repoRoot, 'docs/design/kubic-overview.md');
const present = existsSync(builder) && existsSync(config) && existsSync(doc);

interface RunResult {
  status: number;
  stdout: string;
  stderr: string;
}

function runBuilder(
  workDir: string,
  docPath: string,
  outPath: string,
): RunResult {
  try {
    const stdout = execFileSync(
      process.execPath,
      [builder, '--doc', docPath, '--out', outPath],
      {
        cwd: workDir,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    return { status: 0, stdout, stderr: '' };
  } catch (error) {
    const e = error as { status?: number; stdout?: string; stderr?: string };
    return {
      status: e.status ?? -1,
      stdout: String(e.stdout ?? ''),
      stderr: String(e.stderr ?? ''),
    };
  }
}

describe.skipIf(!present)(
  'design explorer builder — dangling § references (issue #100)',
  () => {
    it('exits non-zero, names the dangling reference, and writes nothing', () => {
      const dir = mkTmp('kubic-xref-');
      const source = readFileSync(doc, 'utf8');
      const broken = `${source}\n\n# 99. Probe section\n\nDangling reference to §12.99 which does not exist.\n`;
      const brokenDoc = join(dir, 'probe.md');
      const out = join(dir, 'probe.html');
      writeFileSync(brokenDoc, broken, 'utf8');

      const result = runBuilder(dir, brokenDoc, out);

      expect(result.status).not.toBe(0);
      expect(`${result.stdout}${result.stderr}`).toContain('§12.99');
      expect(existsSync(out)).toBe(false);
    });

    it('builds the real document with exit 0 and reports no dangling references', () => {
      const dir = mkTmp('kubic-xref-ok-');
      const out = join(dir, 'ok.html');

      const result = runBuilder(repoRoot, doc, out);

      expect(result.status).toBe(0);
      expect(result.stdout).toContain('no dangling references');
      expect(existsSync(out)).toBe(true);
    });
  },
);
