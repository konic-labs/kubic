// An absent `.kubic/roles/` is the NORMAL case.
//
// `rolesDoctorProbe` is wired into `kubic doctor`, and in a workspace with no
// roles directory it must not report `FAIL role:documents (policy-mismatch):
// ENOENT ... scandir '.kubic/roles'`. Most workspaces have no roles directory,
// and that state must not make doctor red for everyone. `loadRoles` only
// translates `RoleParseError`; a
// filesystem error escapes it, and the probe's catch-all renders any thrown
// error as a policy mismatch. Two distinct conditions must stay distinct:
// - absent directory → nothing to report (the default is intact)
//   - unreadable/corrupt    → a real failure the operator must see
// These tests pin the distinction, so the probe cannot just swallow errors.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createNodeFileBridge } from '@kubic/exec/file-bridge';
import { afterEach, describe, expect, it } from 'vitest';
import { loadRoles, rolesDoctorProbe } from './roles-boot.js';

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

describe('an absent roles directory is not an error', () => {
  it('loadRoles falls back to the embedded presets for a cwd with no .kubic/roles', () => {
    const root = cwd();
    const loaded = loadRoles({
      cwd: root,
      bridge: createNodeFileBridge(root),
      trusted: true,
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

  it('the doctor probe reports the presets, not silence, with no roles directory', () => {
    const root = cwd();
    const checks = rolesDoctorProbe({
      cwd: root,
      bridge: createNodeFileBridge(root),
      trusted: true,
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
      trusted: true,
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
      trusted: true,
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
      trusted: true,
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
      trusted: true,
    });
    expect(checks.filter((check) => check.status === 'fail')).toEqual([]);
    expect(checks.find((check) => check.id === 'role:planner')?.detail).toMatch(
      /^repo role/,
    );
  });

  // The repo text must not be re-read from
  // `.kubic/roles/<parsed role name>.md`, so a document whose file stem
  // differs from its `role:` line (a rename, a copy whose frontmatter was not
  // updated) would throw a raw ENOENT for EVERY consumer — doctor red, every
  // `--role` boot dead. The text must come from the path that
  // was listed, and the role registers under its DECLARED name.
  it('reads a document whose file stem differs from its declared role', () => {
    const root = withRoles({
      'myplanner.md': PLANNER.replace(
        'Decompose the objective.',
        'Renamed but declared.',
      ),
    });
    const loaded = loadRoles({
      cwd: root,
      bridge: createNodeFileBridge(root),
      trusted: true,
    });
    // Registered under the DECLARED name (`planner`), replacing its preset.
    expect(loaded.sources.planner).toBe('repo');
    expect(loaded.texts.planner).toContain('Renamed but declared.');
    expect(loaded.resolved.map((r) => r.name)).toContain('planner');
    // No `planner.md` exists, so a probe that re-read the file would throw.
    const checks = rolesDoctorProbe({
      cwd: root,
      bridge: createNodeFileBridge(root),
      trusted: true,
    });
    expect(checks.filter((check) => check.status === 'fail')).toEqual([]);
    expect(checks.find((check) => check.id === 'role:planner')?.detail).toMatch(
      /^repo role/,
    );
  });

  it('reports an unreadable document with its own path, not an ENOENT', () => {
    // The listed path is what is read; a document that cannot be read fails
    // with that path named (never as another document's missing file).
    const root = withRoles({ 'planner.md': PLANNER });
    const bridge = createNodeFileBridge(root);
    const broken = {
      listDir: (dir: string) => bridge.listDir(dir),
      readTextFile: (path: string) => {
        if (path.endsWith('planner.md')) throw new Error('EIO: i/o error');
        return bridge.readTextFile(path);
      },
    };
    expect(() =>
      loadRoles({ cwd: root, bridge: broken, trusted: true }),
    ).toThrow(/role document .*planner\.md is unreadable: EIO/);
  });
});
