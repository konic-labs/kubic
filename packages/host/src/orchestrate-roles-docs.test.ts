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

import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { createNodeFileBridge } from '../../exec/src/file-bridge.js';
import { createGitSandbox } from '../../exec/src/test-support/git-sandbox.js';
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

// Every tracked markdown file. `git ls-files` is the source (never a plain
// directory walk: gitignored trees such as pi/ are not this repo's docs).
// Under Stryker the suite runs from a gitignored sandbox copy
// (.stryker-tmp/sandbox-*/) where git lists nothing; Stryker copies only
// non-ignored files there, so a walk that skips the gitignored trees IS the
// tracked set. The non-empty guard below keeps both paths honest.
const GITIGNORED_TREES = new Set([
  '.git',
  '.stryker-tmp',
  'coverage',
  'dist',
  'node_modules',
  'pi',
  'reports',
  '.kubic/artifacts',
  '.kubic/journal',
  '.kubic/orchestrator',
  '.kubic/sessions',
  '.kubic/wt',
]);

function markdownOnDisk(dir = ''): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(join(ROOT, dir), { withFileTypes: true })) {
    const rel = dir === '' ? entry.name : `${dir}/${entry.name}`;
    if (entry.isDirectory()) {
      if (!GITIGNORED_TREES.has(rel) && entry.name !== 'node_modules') {
        found.push(...markdownOnDisk(rel));
      }
    } else if (entry.isFile() && rel.endsWith('.md')) {
      found.push(rel);
    }
  }
  return found;
}

function trackedDocs(): string[] {
  let listed = '';
  try {
    // The listing still scans the real checkout, but through the shared
    // sandbox's scrubbed env (issue #420) — no developer config shapes it.
    const sandbox = createGitSandbox();
    try {
      listed = sandbox.git(['ls-files', 'docs', 'README.md', '*.md'], {
        cwd: ROOT,
      });
    } finally {
      sandbox.cleanup();
    }
  } catch {
    // Not a git checkout at all: fall through to the walk.
  }
  const files = listed
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.endsWith('.md'));
  return files.length > 0 ? files : markdownOnDisk().sort();
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
    // The rows owned by the sibling issues move with the siblings: a row may
    // stay only for a module that is STILL dead. When this pin was written,
    // `approvals/budgets.ts` (#105) and `merge/conflicts.ts` (#106) were
    // unreachable, so their rows were the right call. Both siblings have since
    // landed and wired them, and the reachability gate fails on a row for a
    // reachable file — so the surviving property is the stronger one: those
    // two must carry NO row.
    //
    // `merge/telemetry.ts` (#98) was the still-dead module this pin kept its
    // row for; issue #158 wired it (the orchestrate driver records per-agent
    // MergeTelemetry), so it moved to the same property as the two above —
    // a reachable module carries no row. #104's own rows stay absent.
    //
    // Scoped to TABLE ROWS, never the whole file: the prose below the table
    // names these paths on purpose, recording what each issue executed, and a
    // blanket `not.toContain` would fail on that honest narration (measured
    // first, then written this way). A row is what the gate reads.
    const row = (path: string): RegExp =>
      new RegExp(
        `\\|\\s*\\d+\\s*\\|\\s*\`${path.replaceAll('/', '\\/')}\`\\s*\\|`,
      );
    expect(ledger).not.toMatch(
      row('packages/host/src/orchestrator/approvals/budgets.ts'),
    );
    expect(ledger).not.toMatch(
      row('packages/host/src/orchestrator/merge/conflicts.ts'),
    );
    expect(ledger).not.toMatch(
      row('packages/host/src/orchestrator/merge/telemetry.ts'),
    );
  });
});

describe('kubic doctor prints the role refusal the run fails closed with (#104)', () => {
  it('a contradictory document is one named failing check on the doctor path', async (context) => {
    const cwd = mkdtempSync(join(tmpdir(), 'kubic-104-doctor-'));
    context.onTestFinished(() => rmSync(cwd, { recursive: true, force: true }));
    mkdirSync(join(cwd, '.kubic', 'roles'), { recursive: true });
    writeFileSync(
      join(cwd, '.kubic', 'roles', 'planner.md'),
      `---\nrole: planner\ntools: [read, write]\nfilesystem: read\nshell: false\nnetwork: none\ngit: false\ncredentials: none\n---\n\n# planner\n\n## Prompt\n\nYou claim to be read-only.\n`,
    );
    const lines: string[] = [];
    const code = await runDoctorCommand(
      { json: true },
      {
        out: (line) => lines.push(line),
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
          }),
      },
    );
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
      trusted: true,
      agents: ['alpha', 'beta'],
    });
    expect(plan.refused[0]?.reason).toBe(detail);
    // The contradictory repo document loses to nothing: its role is refused
    // while the other workers fall back to the built-in implementer preset
    // (issue #203).
    expect(plan.assignments.map((entry) => entry.role)).toEqual([
      'implementer',
      'implementer',
    ]);
  });
});
