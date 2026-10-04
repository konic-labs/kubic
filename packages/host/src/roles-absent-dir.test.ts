// An absent `.kubic/roles/` is the NORMAL case (issue #99 wiring follow-up;
// since issue #203 it resolves to the presets embedded in the binary).
//
// `rolesDoctorProbe` was wired into `kubic doctor`, and in a workspace with no
// roles directory it reported `FAIL role:documents (policy-mismatch): ENOENT
// ... scandir '.kubic/roles'` — measured on the built binary. Most workspaces
// have no roles directory, so the newly-wired check made doctor red for
// everyone. Root cause: `loadRoles` only translates `RoleParseError`; a
// filesystem error escapes it, and the probe's catch-all renders any thrown
// error as a policy mismatch. Two distinct conditions were conflated:
//   - absent directory      → nothing to report (the solo default is intact)
//   - unreadable/corrupt    → a real failure the operator must see
// These tests pin the distinction so the fix cannot just swallow errors.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createNodeFileBridge } from '../../exec/src/file-bridge.js';
import { loadRoles, rolesDoctorProbe } from './roles/roles-boot.js';

const roots: string[] = [];

function cwd(): string {
  const root = mkdtempSync(join(tmpdir(), 'kubic-roles-absent-'));
  roots.push(root);
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function withRoles(files: Record<string, string>): string {
  const root = cwd();
  mkdirSync(join(root, '.kubic', 'roles'), { recursive: true });
  for (const [name, body] of Object.entries(files)) {
    writeFileSync(join(root, '.kubic', 'roles', name), body);
  }
  return root;
}

const PLANNER = `---
role: planner
tools: [read, ls, find, grep]
filesystem: read
shell: false
network: none
git: false
credentials: none
---

# planner

Decompose the objective.
`;

describe('an absent roles directory is not an error (#99 wiring follow-up)', () => {
  it('loadRoles falls back to the embedded presets for a cwd with no .kubic/roles (issue #203)', () => {
    const root = cwd();
    const loaded = loadRoles({
      cwd: root,
      bridge: createNodeFileBridge(root),
    });
    expect(loaded.resolved.map((role) => role.name)).toEqual([
      'debugger',
      'implementer',
      'planner',
      'reviewer',
      'tester',
    ]);
    expect(loaded.refused).toEqual([]);
    // Every one of them is reported as coming from the binary, and its
    // markdown is the embedded text (no repo file exists to read).
    for (const name of loaded.resolved.map((role) => role.name)) {
      expect(loaded.sources[name]).toBe('builtin');
      expect(loaded.texts[name]).toContain(`role: ${name}`);
    }
  });

  it('the doctor probe reports the presets, not silence, with no roles directory (issue #203)', () => {
    const root = cwd();
    const checks = rolesDoctorProbe({
      cwd: root,
      bridge: createNodeFileBridge(root),
    });
    expect(checks.filter((check) => check.status === 'fail')).toEqual([]);
    expect(checks.map((check) => check.id)).toEqual([
      'role:debugger',
      'role:implementer',
      'role:planner',
      'role:reviewer',
      'role:tester',
    ]);
    // The detail names the layer the role came from, so an operator can tell
    // a shipped preset from a repo override.
    expect(
      checks.every((check) => /builtin role/.test(check.detail ?? '')),
    ).toBe(true);
  });

  it('the same holds when .kubic exists but has no roles subdirectory', () => {
    const root = cwd();
    mkdirSync(join(root, '.kubic'), { recursive: true });
    const checks = rolesDoctorProbe({
      cwd: root,
      bridge: createNodeFileBridge(root),
    });
    expect(checks.filter((check) => check.status === 'fail')).toEqual([]);
  });

  it('a REAL role problem still fails: the fix is not a swallow', () => {
    // A document with an unknown frontmatter key is a parse refusal. The
    // absent-directory fix must not turn this into a pass.
    const root = withRoles({
      'broken.md': '---\nrole: broken\nnot_a_key: 1\n---\n\n# broken\n\nx\n',
    });
    const checks = rolesDoctorProbe({
      cwd: root,
      bridge: createNodeFileBridge(root),
    });
    const failing = checks.filter((check) => check.status === 'fail');
    expect(failing).toHaveLength(1);
    expect(failing[0]?.detail).toMatch(/unknown frontmatter key 'not_a_key'/);
  });

  it('a consistent role document still reports clean', () => {
    const root = withRoles({ 'planner.md': PLANNER });
    const loaded = loadRoles({
      cwd: root,
      bridge: createNodeFileBridge(root),
    });
    // The repo document REPLACES its embedded preset; the other four presets
    // are still there, and the overridden one is reported as `repo`.
    expect(loaded.resolved.map((r) => r.name)).toEqual([
      'debugger',
      'implementer',
      'planner',
      'reviewer',
      'tester',
    ]);
    expect(loaded.sources.planner).toBe('repo');
    expect(loaded.texts.planner).toContain('Decompose the objective.');
    const checks = rolesDoctorProbe({
      cwd: root,
      bridge: createNodeFileBridge(root),
    });
    expect(checks.filter((check) => check.status === 'fail')).toEqual([]);
    expect(checks.find((check) => check.id === 'role:planner')?.detail).toMatch(
      /^repo role/,
    );
  });
});
