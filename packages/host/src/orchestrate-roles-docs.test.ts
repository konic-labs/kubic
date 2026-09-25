// Role-driven delegation: the docs and the doctor must state what the
// binary now does (issue #104; §12/§12.1, §40.3, §41.4). Three claims are
// pinned load-bearing, the way clean-docs.test.ts pins `kubic clean`:
//   1. every tracked doc that describes the delegation path may no longer
//      say roles are absent from it — the wiring exists, so the old
//      "not on this path" wording would be a false claim;
//   2. the architecture and CLI pages must state the shipped behaviour
//      (role prompt + plan step compose the worker prompt, the role's tool
//      set is what the lane registers);
//   3. `kubic doctor`, over a REAL `.kubic/roles/` tree on the composition
//      root's own path, prints a contradictory role's named reason — the
//      same refusal the orchestrate run fails closed with.
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { createNodeFileBridge } from '../../exec/src/file-bridge.js';
import { runDoctorCommand } from './doctor.js';
import { rolesDoctorProbe } from './roles/roles-boot.js';
import { planWorkerRoles } from './roles/worker-roles.js';

// packages/host/src/ → repo root is three levels up.
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

// Markdown wraps prose, so claims are matched on normalized text — a claim
// split across two lines is still the claim, and matching raw text would let
// it through (a vacuous pass).
function prose(file: string): string {
  return readFileSync(join(ROOT, file), 'utf8').replace(/\s+/g, ' ');
}

function trackedDocs(): string[] {
  const out = execFileSync('git', ['ls-files', 'docs', 'README.md', '*.md'], {
    cwd: ROOT,
    encoding: 'utf8',
  });
  return out
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.endsWith('.md'));
}

describe('no tracked doc claims roles are absent from the delegation path (#104)', () => {
  it('the absence scan is not vacuous and sees the docs that used to carry the claim', () => {
    const docs = trackedDocs();
    expect(docs.length).toBeGreaterThan(20);
    expect(docs).toContain('docs/architecture/orchestrator.md');
    expect(docs).toContain('docs/cli/commands.md');
    expect(docs).toContain('README.md');
  });

  it('no tracked doc says role-driven prompts are unwired, and none says workers run the same prompt', () => {
    const offenders: string[] = [];
    const patterns = [
      /roles are not on this path/i,
      /no role prompt is composed/i,
      /role-driven prompts? (?:is|are) still issue/i,
      /role-driven prompt text \(§12\) is still/i,
      /worker assigned a role and no role prompt/i,
    ];
    for (const file of trackedDocs()) {
      const text = prose(file);
      for (const pattern of patterns) {
        if (pattern.test(text)) offenders.push(`${file}: ${pattern.source}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('the architecture page states the shipped role behaviour', () => {
    const page = prose('docs/architecture/orchestrator.md');
    // The role half is stated as shipped, not as a promise.
    expect(page).toMatch(/assigned one of the five §12 roles/i);
    expect(page).toMatch(/#104/);
    // Both halves of the composition, and absence (not approval) as what
    // withholds a tool.
    expect(page).toMatch(/`## Prompt` text plus the worker's step/i);
    expect(page).toMatch(/absence, not approval/i);
    // The old future-tense claim cannot come back.
    expect(page).not.toMatch(/role-driven prompts are issue/i);
  });

  it('the CLI page states the role-composed worker prompt and the child role flag', () => {
    const page = prose('docs/cli/commands.md');
    const start = page.indexOf('**The delegation model, as shipped');
    expect(start).toBeGreaterThan(-1);
    const section = page.slice(start, start + 3000);
    expect(section).toMatch(/assigned role/i);
    expect(section).toMatch(/`--role <name>`/);
    expect(section).toMatch(/role_refused/);
    // The composition order is stated: the role text opens the prompt.
    expect(section).toMatch(/opens with the `## Prompt` text/i);
  });

  it('the ledger no longer carries the rows this issue wired', () => {
    const ledger = prose('docs/dead-surface.md');
    expect(ledger).not.toContain('packages/agents/src/spec.ts');
    expect(ledger).not.toContain('packages/host/src/roles/roles-data.ts');
    // The rows owned by the sibling issues stay untouched.
    expect(ledger).toContain(
      'packages/host/src/orchestrator/approvals/budgets.ts',
    );
    expect(ledger).toContain(
      'packages/host/src/orchestrator/merge/conflicts.ts',
    );
  });
});

describe('kubic doctor prints the role refusal the run fails closed with (#104)', () => {
  it('a contradictory document is one named failing check on the doctor path', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'kubic-104-doctor-'));
    mkdirSync(join(cwd, '.kubic', 'roles'), { recursive: true });
    writeFileSync(
      join(cwd, '.kubic', 'roles', 'planner.md'),
      `---\nrole: planner\ntools: [read, write]\nfilesystem: read\nshell: false\nnetwork: none\ngit: false\ncredentials: none\n---\n\n# planner\n\n## Prompt\n\nYou claim to be read-only.\n`,
    );
    const lines: string[] = [];
    const code = await runDoctorCommand(['--json'], {
      out: (line) => lines.push(line),
      probeProviders: () => [
        { id: 'faux', reachable: true, dialled: true, models: ['faux-1'] },
      ],
      checkDeps: () => [{ id: 'node', ok: true }],
      loadPolicy: () => ({ route: 'ask-user', autoApprove: [] }),
      probeRoles: () =>
        rolesDoctorProbe({ cwd, bridge: createNodeFileBridge(cwd) }),
    });
    const report = JSON.parse(lines.join('\n')) as {
      ok: boolean;
      checks: Array<{ id: string; status: string; detail?: string }>;
    };
    const failing = report.checks.filter((check) => check.status === 'fail');
    expect(failing.map((check) => check.id)).toContain('role:planner');
    const detail =
      failing.find((check) => check.id === 'role:planner')?.detail ?? '';
    expect(detail).toContain(
      "filesystem is 'read' but write tool 'write' is registered",
    );
    expect(code).toBe(1);
    expect(report.ok).toBe(false);

    // The same tree, through the delegation-side loader: same named reason,
    // nothing assigned — doctor and the run cannot disagree about a
    // document's validity.
    const plan = planWorkerRoles({
      bridge: createNodeFileBridge(cwd),
      cwd,
      agents: ['alpha', 'beta'],
    });
    expect(plan.refused[0]?.reason).toBe(detail);
    expect(plan.assignments).toEqual([]);
  });
});
