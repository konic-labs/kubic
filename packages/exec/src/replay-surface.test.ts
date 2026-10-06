// Replay-surface honesty gate (issue #97).
//
// Issue #97 decided the replay-safety kernel: the Kubic-side state machine
// (`effects.ts`) and the file-backed checkpoint store (`checkpoint-store.ts`)
// were deleted rather than wired, because both duplicate machinery the Pi
// harness itself owns — the durable tool task (one ToolTask per call, whose
// recorded intent carries `replay: 'safe' | 'unsafe'`:
// `@earendil-works/pi-durable`, `harness/tool.ts`) and the abort-aware
// admission/settlement path are the harness's, and nothing ever read a
// persisted checkpoint.
//
// This file is the regression gate for that decision: a deleted surface must
// stay deleted, no tracked document may advertise it, and the exec package
// page must state what actually ships (replay re-executes; it does not replay
// recorded effects). `*.test.ts` is skipped by the repo scan below, so this
// file may name the deleted symbols.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

// Anchored to this file, not process.cwd(): the gate must not depend on where
// vitest was launched from.
const ROOT = join(import.meta.dirname, '..', '..', '..');
const EXEC_SRC = join(ROOT, 'packages', 'exec', 'src');

// The two modules #97 deleted (89 + 97 LOC of unreachable kernel).
const DELETED_MODULES = ['checkpoint-store.ts', 'effects.ts'];

// Symbols that existed only on the deleted surface. They may still appear in
// prose that *explains the deletion* (like the exec package page), but never
// in code, and never as an advertised module row on the API page.
const DELETED_SYMBOLS = [
  'FileCheckpointStore',
  'EffectGate',
  'EffectTicket',
  'REPLAY_POLICIES',
  'TOOL_CALL_STATES',
  'advanceToolCall',
  'batchTerminates',
];
const DELETED_MODULE_PATHS = [
  'effects.ts',
  'checkpoint-store.ts',
  'exec/src/effects',
  'exec/src/checkpoint-store',
];

// Directories that never participate: dependencies, upstream reference,
// build output and VCS.
const SKIP_DIRS = new Set([
  'node_modules',
  'pi',
  'dist',
  '.git',
  'coverage',
  'reports',
]);
const TEXT_EXTENSIONS = ['.ts', '.tsx', '.js', '.mjs', '.md', '.json'];

function walk(dir: string, out: string[] = []): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

// Product + tooling roots only: runtime state (`.kubic/`), scratch trees and
// vendored tooling are not claims surfaces.
const SCANNED_ROOTS = [
  'packages',
  'apps',
  'docs',
  'scripts',
  'bin',
  '.github',
  'README.md',
  'package.json',
  '.gitignore',
];

function scannedFiles(): string[] {
  const out: string[] = [];
  for (const root of SCANNED_ROOTS) {
    const full = join(ROOT, root);
    if (statSync(full).isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out.filter(
    (file) =>
      TEXT_EXTENSIONS.some((ext) => file.endsWith(ext)) &&
      !file.endsWith('.test.ts') &&
      !file.endsWith('.test.mjs') &&
      !file.endsWith('.test.tsx'),
  );
}

function exists(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

describe('replay-surface honesty (issue #97: deleted, not wired)', () => {
  it('ships no replay-safety kernel module', () => {
    for (const module of DELETED_MODULES) {
      expect(exists(join(EXEC_SRC, module))).toBe(false);
    }
  });

  it('keeps no code reference or import to the deleted kernel', () => {
    const offenders: string[] = [];
    for (const file of scannedFiles()) {
      if (file.endsWith('.md')) continue;
      const text = readFileSync(file, 'utf8');
      for (const symbol of DELETED_SYMBOLS) {
        if (text.includes(symbol)) {
          offenders.push(`${relative(ROOT, file)}: ${symbol}`);
        }
      }
      for (const path of DELETED_MODULE_PATHS) {
        // An import specifier is a live dependency; prose naming a deleted
        // file is not. Match the `from '…<path>'` / `import('…<path>')` shape.
        if (
          new RegExp(`from\\s+['"][^'"]*${path}['"]`).test(text) ||
          new RegExp(`import\\(\\s*['"][^'"]*${path}['"]`).test(text)
        ) {
          offenders.push(`${relative(ROOT, file)}: imports ${path}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it('advertises no deleted module in the exec package API rows', () => {
    const page = readFileSync(
      join(ROOT, 'docs', 'packages', 'exec.md'),
      'utf8',
    );
    // API rows are table lines starting with `| \`<module>\``. The page may
    // mention the deleted files only to record the deletion.
    const rows = page
      .split('\n')
      .filter((line) => line.startsWith('| `'))
      .join('\n');
    for (const symbol of DELETED_MODULE_PATHS) {
      expect(rows).not.toContain(symbol);
    }
    expect(rows).not.toContain('EffectGate');
  });

  it('states on the exec package page that replay re-executes', () => {
    const page = readFileSync(
      join(ROOT, 'docs', 'packages', 'exec.md'),
      'utf8',
    );
    // Normalise markdown emphasis/code spans so the sentence is matched in
    // prose form ("does **not** replay" == "does not replay").
    const prose = page.replace(/[*`_]/g, '').replace(/\s+/g, ' ');
    // The honest limit, stated where the package surface is documented:
    // the deterministic/live tiers re-run the objective through the lane;
    // no recorded effect is replayed and no checkpoint is persisted.
    expect(prose).toMatch(/re-executes|re-runs/i);
    expect(prose).toMatch(
      /does not replay recorded effects|replays no recorded effect|never replays a recorded effect/i,
    );
    expect(prose).toMatch(/persists no checkpoint|no checkpoint is persisted/i);
  });

  it('has no dead-surface ledger row for the deleted modules', () => {
    const ledger = readFileSync(join(ROOT, 'docs', 'dead-surface.md'), 'utf8');
    for (const module of DELETED_MODULES) {
      expect(ledger).not.toContain(`exec/src/${module}`);
    }
  });
});
