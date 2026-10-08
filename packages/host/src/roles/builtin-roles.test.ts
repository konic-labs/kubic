// Built-in roles as data — loader test. Reads the built-in presets (the
// documents the binary ships) through the resolver and proves: all five validate,
// the tool sets match each role's job, and reviewer read-only-ness holds by
// tool absence.
import { describe, expect, it } from 'vitest';
import { BUILTIN_ROLE_NAMES, BUILTIN_ROLE_PRESETS } from './builtin-presets.js';

import {
  type ParsedRoleDoc,
  parseRoleDocument,
  resolveRole,
  roleDoctorChecks,
  validateResolvedRole,
} from './resolver.js';

function docNamed(docs: ParsedRoleDoc[], name: string): ParsedRoleDoc {
  const found = docs.find((doc) => doc.name === name);
  if (found === undefined) throw new Error(`missing role document '${name}'`);
  return found;
}

// The built-in role documents, parsed from the presets the boot loads.
const presetDocs = (): ParsedRoleDoc[] =>
  [...BUILTIN_ROLE_NAMES]
    .sort()
    .map((name) => parseRoleDocument(BUILTIN_ROLE_PRESETS[name]));

describe('built-in role documents', () => {
  it('loads exactly the five built-in roles', () => {
    const docs = presetDocs();
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
    const docs = presetDocs();
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
    const docs = presetDocs();
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
    const docs = presetDocs();
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
    const docs = presetDocs();
    for (const name of ['implementer', 'tester', 'debugger']) {
      const resolved = resolveRole(docNamed(docs, name), []);
      expect(resolved.tools).toContain('write');
      expect(resolved.tools).toContain('bash');
    }
  });
});
