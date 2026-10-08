// Built-in roles as data — loader test. Reads the built-in presets (the
// documents the binary ships) through the resolver and proves: all five validate,
// the tool sets match each role's job, and reviewer read-only-ness holds by
// tool absence.
import { basename, dirname } from 'node:path';
import { describe, expect, it } from 'vitest';
import { BUILTIN_ROLE_NAMES, BUILTIN_ROLE_PRESETS } from './builtin-presets.js';
import {
  createRoleToolGuard,
  loadRoleDocuments,
  type ParsedRoleDoc,
  resolveRole,
  roleDoctorChecks,
  validateResolvedRole,
} from './resolver.js';

// The presets as an in-memory role directory: the loader reads the exact text
// the binary ships, with no filesystem access.
const PRESETS_DIR = '/builtin/roles';

function presetBridge(): {
  listDir: (dir: string) => Array<{
    name: string;
    path: string;
    isDirectory: boolean;
    isSymbolicLink: boolean;
    size: number;
    mtimeMs: number;
  }>;
  readTextFile: (path: string) => string;
} {
  const files = new Map<string, string>(
    BUILTIN_ROLE_NAMES.map((name): [string, string] => [
      `${PRESETS_DIR}/${name}.md`,
      BUILTIN_ROLE_PRESETS[name],
    ]),
  );
  return {
    listDir: (dir) =>
      [...files.keys()]
        .filter((path) => dirname(path) === dir)
        .map((path) => ({
          name: basename(path),
          path,
          isDirectory: false,
          isSymbolicLink: false,
          size: 0,
          mtimeMs: 0,
        })),
    readTextFile: (path) => {
      const text = files.get(path);
      if (text === undefined) throw new Error(`no preset at ${path}`);
      return text;
    },
  };
}

function docNamed(docs: ParsedRoleDoc[], name: string): ParsedRoleDoc {
  const found = docs.find((doc) => doc.name === name);
  if (found === undefined) throw new Error(`missing role document '${name}'`);
  return found;
}

describe('built-in role documents', () => {
  it('loads exactly the five built-in roles', () => {
    const docs = loadRoleDocuments(presetBridge(), PRESETS_DIR);
    // Sorted by filename (loader contract: deterministic), covering the
    // five built-ins exactly once.
    expect(docs.map((doc) => doc.name)).toEqual([
      'debugger',
      'implementer',
      'planner',
      'reviewer',
      'tester',
    ]);
    expect(new Set(docs.map((doc) => doc.name))).toEqual(
      new Set(BUILTIN_ROLE_NAMES),
    );
  });

  it('every role resolves and validates; doctor passes clean', () => {
    const docs = loadRoleDocuments(presetBridge(), PRESETS_DIR);
    const resolved = docs.map((doc) => resolveRole(doc, []));
    for (const role of resolved) {
      expect(() => validateResolvedRole(role)).not.toThrow();
    }
    const checks = roleDoctorChecks(resolved);
    expect(checks).toHaveLength(5);
    for (const check of checks) {
      expect(check).toMatchObject({ status: 'pass', reason: 'ok' });
    }
  });
});

describe('built-in tool sets', () => {
  it('planner is read-only: no write/edit/git tools, bash only via the read-only shell', () => {
    const docs = loadRoleDocuments(presetBridge(), PRESETS_DIR);
    const planner = resolveRole(docNamed(docs, 'planner'), []);
    expect(planner.tools).toContain('read');
    // Gives the planner read-only inspection commands: bash is present,
    // and the read-only shell level is what keeps it from writing.
    expect(planner.tools).toContain('bash');
    expect(planner.classes.shell).toBe('read-only-allowlist');
    for (const banned of ['write', 'edit', 'git_status', 'git_commit']) {
      expect(planner.tools).not.toContain(banned);
    }
  });

  it('reviewer is read-only: no write/edit/commit/git tools, bash only via the read-only shell', () => {
    const docs = loadRoleDocuments(presetBridge(), PRESETS_DIR);
    const reviewer = resolveRole(docNamed(docs, 'reviewer'), []);
    expect(reviewer.tools).toContain('read');
    expect(reviewer.tools).toContain('bash');
    expect(reviewer.classes.shell).toBe('read-only-allowlist');
    // `git: false` — read-only git runs through the allowlisted shell.
    expect(reviewer.classes.git).toBe(false);
    for (const banned of [
      'write',
      'edit',
      'git_commit',
      'git_status',
      'git_diff',
    ]) {
      expect(reviewer.tools).not.toContain(banned);
    }
  });

  it('implementer, tester, and debugger hold write + bash tools', () => {
    const docs = loadRoleDocuments(presetBridge(), PRESETS_DIR);
    for (const name of ['implementer', 'tester', 'debugger']) {
      const resolved = resolveRole(docNamed(docs, name), []);
      expect(resolved.tools).toContain('write');
      expect(resolved.tools).toContain('bash');
    }
  });

  it('reviewer write calls fail tool-absent, never approval-gated', () => {
    const docs = loadRoleDocuments(presetBridge(), PRESETS_DIR);
    const reviewer = resolveRole(docNamed(docs, 'reviewer'), []);
    const guard = createRoleToolGuard(reviewer.name, reviewer.tools);
    const verdict = guard({
      toolCallId: 'call-1',
      toolName: 'write',
      args: { path: 'notes.txt' },
    });
    expect(verdict).toEqual({
      block: {
        reason: expect.stringContaining('tool-absent'),
        terminate: false,
      },
    });
    expect((verdict as { block: { reason: string } }).block.reason).not.toMatch(
      /approval/i,
    );
  });
});
