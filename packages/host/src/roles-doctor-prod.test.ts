// §40.3 role posture on the PRODUCTION doctor path (issue #99's named gap).
//
// The child implementing #99 built `rolesDoctorProbe` and its seam but could
// not inject it: the only injection site was apps/kubic/src/main.ts, which
// was fenced to a sibling. So the probe was complete and the binary's
// `kubic doctor` had no role section. This pins the wire — since #135 the
// production wiring lives in apps/kubic/src/prod-runners.ts.
//
// Driven through the real doctor command with the real probe, over a real
// `.kubic/roles/` tree — not a stub — because the gap this closes was exactly
// "the piece exists but nothing calls it".

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createNodeFileBridge } from '../../exec/src/file-bridge.js';
import { type DoctorDeps, runDoctorCommand } from './doctor.js';
import { rolesDoctorProbe } from './roles/roles-boot.js';

const roots: string[] = [];

function tmpRoot(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function roleDir(role: string, frontmatter: string, prompt = 'Go.'): string {
  const cwd = tmpRoot('kubic-doctor-roles-');
  mkdirSync(join(cwd, '.kubic', 'roles'), { recursive: true });
  writeFileSync(
    join(cwd, '.kubic', 'roles', `${role}.md`),
    `---\nrole: ${role}\n${frontmatter}---\n\n# ${role}\n\n${prompt}\n`,
  );
  return cwd;
}

function doctorDeps(cwd: string, lines: string[]): DoctorDeps {
  return {
    out: (line: string) => lines.push(line),
    probeProviders: () => [
      { id: 'faux', reachable: true, dialled: true, models: ['faux-1'] },
    ],
    checkDeps: () => [{ id: 'node', ok: true }],
    loadPolicy: () => ({ route: 'ask-user', autoApprove: [] }),
    probeRoles: () =>
      rolesDoctorProbe({ cwd, bridge: createNodeFileBridge(cwd) }),
  };
}

interface Report {
  ok: boolean;
  checks: Array<{ id: string; status: string; detail?: string }>;
}

async function report(cwd: string): Promise<Report> {
  const lines: string[] = [];
  await runDoctorCommand({ json: true }, doctorDeps(cwd, lines));
  return JSON.parse(lines.join('\n')) as Report;
}

describe('doctor reports the §40.3 role posture on the production path (#99)', () => {
  it('a contradictory role document fails the run with a named reason', async () => {
    // `tools: [read, write]` with `filesystem: read` — the document declares a
    // write tool under a read-only filesystem class. That is the §40.3
    // contradiction the resolver refuses; doctor must show it, not discovery.
    const cwd = roleDir(
      'liar',
      'tools: [read, write]\nfilesystem: read\nshell: false\nnetwork: none\ngit: false\ncredentials: none\n',
    );
    const parsed = await report(cwd);
    // Refused documents are reported per-name as `role:<name>`; a contradictory
    // one never reaches roleDoctorChecks because resolveRole throws first.
    const failing = parsed.checks.filter((c) => c.status === 'fail');
    expect(failing.length).toBe(1);
    expect(failing[0]?.id).toBe('role:liar');
    expect(failing[0]?.detail ?? '').toMatch(
      /filesystem is 'read' but write tool 'write'/,
    );
    // The probe reports refusals rather than throwing, so doctor still emitted
    // a complete report — the check is a finding, not a crash. (Doctor names
    // dep checks `dep:<id>`, hence the prefix.)
    expect(parsed.checks.some((c) => c.id === 'dep:node')).toBe(true);
  });

  it('a consistent role directory reports its documents as ok', async () => {
    const cwd = roleDir(
      'planner',
      'tools: [read, ls, find, grep]\nfilesystem: read\nshell: false\nnetwork: none\ngit: false\ncredentials: none\n',
      'Decompose the objective.',
    );
    const parsed = await report(cwd);
    const roles = parsed.checks.filter((c) => c.id.startsWith('role:'));
    expect(roles.length).toBeGreaterThan(0);
    expect(roles.every((c) => c.status !== 'fail')).toBe(true);
    expect(
      roles.some((c) => c.id === 'role:planner' && c.status === 'pass'),
    ).toBe(true);
  });

  it('an absent role directory is not a failure', async () => {
    // Most workspaces have no `.kubic/roles/`; doctor must stay green there.
    const cwd = tmpRoot('kubic-doctor-noroles-');
    const parsed = await report(cwd);
    const roles = parsed.checks.filter((c) => c.id.startsWith('role:'));
    expect(roles.filter((c) => c.status === 'fail')).toEqual([]);
    // The probe ran and says why nothing was found, and doctor stays green.
    expect(roles).toContainEqual(
      expect.objectContaining({
        id: 'role:documents',
        status: 'pass',
        detail: expect.stringMatching(/no role documents/),
      }),
    );
    expect(parsed.ok).toBe(true);
  });

  it('the wiring itself: the production runners inject the probe', async () => {
    // The gap being closed is "nothing calls it". Import-level is not enough —
    // assert the injection exists in the production wiring (the composition
    // root's runner module since issue #135).
    const source = await import('node:fs').then((fs) =>
      fs.readFileSync(
        join(
          import.meta.dirname,
          '..',
          '..',
          '..',
          'apps',
          'kubic',
          'src',
          'prod-runners.ts',
        ),
        'utf8',
      ),
    );
    expect(source).toMatch(/probeRoles:\s*\(\)\s*=>/);
    expect(source).toMatch(/rolesDoctorProbe\(/);
  });
});
