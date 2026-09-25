// An absent `.kubic/roles/` is the NORMAL case (issue #99 wiring follow-up).
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

import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createNodeFileBridge } from '../../exec/src/file-bridge.js';
import { loadRoles, rolesDoctorProbe } from './roles/roles-boot.js';

function cwd(): string {
  return mkdtempSync(join(tmpdir(), 'kubic-roles-absent-'));
}

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
  it('loadRoles returns empty for a cwd with no .kubic/roles', () => {
    const root = cwd();
    const loaded = loadRoles({
      cwd: root,
      bridge: createNodeFileBridge(root),
    });
    expect(loaded.docs).toEqual([]);
    expect(loaded.resolved).toEqual([]);
    expect(loaded.refused).toEqual([]);
  });

  it('the doctor probe passes (or stays silent) with no roles directory', () => {
    const root = cwd();
    const checks = rolesDoctorProbe({
      cwd: root,
      bridge: createNodeFileBridge(root),
    });
    const failing = checks.filter((check) => check.status === 'fail');
    expect(failing).toEqual([]);
    // And it says WHY nothing was reported, rather than leaving the operator
    // to guess whether the role layer ran at all.
    expect(
      checks.some((check) => /no role documents/i.test(check.detail ?? '')),
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
    expect(checks.filter((check) => check.status === 'fail').length).toBe(1);
  });

  it('a consistent role document still reports clean', () => {
    const root = withRoles({ 'planner.md': PLANNER });
    const loaded = loadRoles({
      cwd: root,
      bridge: createNodeFileBridge(root),
    });
    expect(loaded.resolved.map((r) => r.name)).toEqual(['planner']);
    const checks = rolesDoctorProbe({
      cwd: root,
      bridge: createNodeFileBridge(root),
    });
    expect(checks.filter((check) => check.status === 'fail')).toEqual([]);
  });
});
