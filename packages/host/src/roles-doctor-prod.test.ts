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
import {
  type EffectivePolicy,
  resolveEffectivePolicy,
} from './policy/enterprise.js';
import type { RoleLayerInput } from './roles/resolver.js';
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

function doctorDeps(
  cwd: string,
  lines: string[],
  toolPolicy?: EffectivePolicy,
  layers?: RoleLayerInput[],
): DoctorDeps {
  return {
    out: (line: string) => lines.push(line),
    probeProviders: () => [
      { id: 'faux', reachable: true, dialled: true, models: ['faux-1'] },
    ],
    checkDeps: () => [{ id: 'node', ok: true }],
    loadPolicy: () => ({ route: 'ask-user', autoApprove: [] }),
    probeRoles: () =>
      rolesDoctorProbe({
        cwd,
        bridge: createNodeFileBridge(cwd),
        trusted: true,
        ...(toolPolicy === undefined ? {} : { toolPolicy }),
        ...(layers === undefined ? {} : { layers }),
      }),
  };
}

interface Report {
  ok: boolean;
  checks: Array<{ id: string; status: string; detail?: string }>;
}

async function report(
  cwd: string,
  toolPolicy?: EffectivePolicy,
  layers?: RoleLayerInput[],
): Promise<Report> {
  const lines: string[] = [];
  await runDoctorCommand(
    { json: true },
    doctorDeps(cwd, lines, toolPolicy, layers),
  );
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

  // §58 enterprise tool policy (issue #288): `kubic run --role` refuses a
  // role that declares a denied tool, so doctor must show it red instead of
  // green — through the real doctor command, over a real `.kubic/roles/`.
  it('a role declaring an enterprise-denied tool is red; an innocuous one stays green', async () => {
    const cwd = roleDir(
      'implementer',
      'tools: [read, ls, write, bash]\nfilesystem: workspace-write\nshell: true\nnetwork: none\ngit: false\ncredentials: none\n',
    );
    writeFileSync(
      join(cwd, '.kubic', 'roles', 'planner.md'),
      '---\nrole: planner\ntools: [read, ls, find, grep]\nfilesystem: read\nshell: false\nnetwork: none\ngit: false\ncredentials: none\n---\n\n# planner\n\nGo.\n',
    );
    const denyBash = resolveEffectivePolicy([
      { layer: 'enterprise', policy: { tools: { deny: ['bash'] } } },
    ]).policy;
    const gated = await report(cwd, denyBash);
    const failing = gated.checks.filter((c) => c.status === 'fail');
    // The repo's implementer (bash) and the embedded presets that run a shell
    // are refused by name; the repo's own planner declares no bash and stays
    // green (issue #203 adds the presets to the tree).
    expect(failing.map((c) => c.id)).toEqual([
      'role:debugger',
      'role:implementer',
      'role:reviewer',
      'role:tester',
    ]);
    expect(
      failing.find((c) => c.id === 'role:implementer')?.detail ?? '',
    ).toMatch(/role 'implementer'.*'bash' denied.*enterprise denial holds/);
    expect(
      gated.checks.some((c) => c.id === 'role:planner' && c.status === 'pass'),
    ).toBe(true);
    expect(gated.ok).toBe(false);
    // Control: without the policy the same tree is green.
    const open = await report(cwd);
    expect(open.checks.filter((c) => c.status === 'fail')).toEqual([]);
    expect(open.ok).toBe(true);
  });

  it('a config [roles.<name>] layer that narrows the denied tool away keeps the role green', async () => {
    // Doctor judges the role as `kubic run --role` resolves it — document
    // AFTER the config layers — so a layer replacing the tool list with [read]
    // passes the enterprise deny instead of being shown red.
    const cwd = roleDir(
      'implementer',
      'tools: [read, ls, write, bash]\nfilesystem: workspace-write\nshell: true\nnetwork: none\ngit: false\ncredentials: none\n',
    );
    const denyBash = resolveEffectivePolicy([
      { layer: 'enterprise', policy: { tools: { deny: ['bash'] } } },
    ]).policy;
    const layers: RoleLayerInput[] = [
      { layer: 'project', roles: { implementer: { tools: ['read'] } } },
    ];
    const layered = await report(cwd, denyBash, layers);
    expect(
      layered.checks.some(
        (c) => c.id === 'role:implementer' && c.status === 'pass',
      ),
    ).toBe(true);
    // The layer covers only the implementer: the roles it does not touch
    // still declare bash and are still refused (issue #203).
    expect(
      layered.checks.filter((c) => c.status === 'fail').map((c) => c.id),
    ).toEqual([
      'role:debugger',
      'role:planner',
      'role:reviewer',
      'role:tester',
    ]);
    // Control: without the layer the deny turns the implementer red too.
    const bare = await report(cwd, denyBash);
    expect(
      bare.checks.filter((c) => c.status === 'fail').map((c) => c.id),
    ).toEqual([
      'role:debugger',
      'role:implementer',
      'role:planner',
      'role:reviewer',
      'role:tester',
    ]);
  });

  it('an absent role directory reports the embedded presets, not a failure (issue #203)', async () => {
    // Most workspaces have no `.kubic/roles/`; doctor must stay green there,
    // and it must name what the run would actually assign — the five presets
    // that ship with the binary, each marked `builtin`.
    const cwd = tmpRoot('kubic-doctor-noroles-');
    const parsed = await report(cwd);
    const roles = parsed.checks.filter((c) => c.id.startsWith('role:'));
    expect(roles.filter((c) => c.status === 'fail')).toEqual([]);
    expect(roles.map((c) => c.id)).toEqual([
      'role:debugger',
      'role:implementer',
      'role:planner',
      'role:reviewer',
      'role:tester',
    ]);
    expect(roles.every((c) => /builtin role/.test(c.detail ?? ''))).toBe(true);
    expect(parsed.ok).toBe(true);
  });
});
