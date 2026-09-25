// Orchestrator scope is pinned to what ships (issue #95; §5.2, §9.2, §12,
// §40, §41, §45, §54, D7/D8/D12). This issue decided the delegation model
// by measurement: the live path is a CLI-driven fan-out (the CLI process
// plans N agents, spawns one worker per agent in its own worktree, merges
// what they committed) and there is NO manager agent lane, no plan-derived
// per-worker prompt, no role-driven prompt, and no per-worker approval
// routing. Those four are re-scoped into named issues; these tests make the
// claims load-bearing, the way clean-docs.test.ts does for `kubic clean`:
//   - the architecture page must state the shipped model and name the
//     future issues instead of promising the manager;
//   - the CLI page must say plainly that every worker runs the same prompt
//     and that the default is two agents executed one after another;
//   - D7/D8 in the local design registry must be amended rather than left
//     contradicting the code (skipped in a fresh clone — registry is local);
//   - every runtime-dead module under packages/host/src/orchestrator/ must
//     have a ledger row that is a named issue or a deletion, and no row may
//     still be owned by this issue (its dispositions are executed);
//   - the deleted orchestrator leftovers stay deleted.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// packages/host/src/orchestrator/ → repo root is four levels up.
const ROOT = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
  '..',
);
const ARCHITECTURE_PAGE = join(ROOT, 'docs', 'architecture', 'orchestrator.md');
const COMMANDS_PAGE = join(ROOT, 'docs', 'cli', 'commands.md');
const LEDGER = join(ROOT, 'docs', 'dead-surface.md');
const REGISTRY = join(ROOT, 'docs', 'design', 'design-decisions.json');

// The four named successors this issue's re-scope created.
const MANAGER_LANE_ISSUE = '#103';
const ROLE_PROMPTS_ISSUE = '#104';
const WORKER_APPROVALS_ISSUE = '#105';
const ORCHESTRATOR_LEFTOVERS_ISSUE = '#106';

// Deleted by this issue: barrels over dead modules — no importer anywhere
// (verified by the reachability gate), and a barrel that re-exports dead
// modules is not a seam worth keeping.
const DELETED = [
  'packages/host/src/orchestrator/approvals/index.ts',
  'packages/host/src/orchestrator/merge/index.ts',
  'packages/host/src/orchestrator/parallel/index.ts',
  'packages/host/src/orchestrator/worktree/index.ts',
  'packages/host/src/policy/index.ts',
];

// Wired by this issue: the §54 delegation DAG now projects the run's shape
// (`delegationGraphLines`), so the graph module it was designed for is
// reachable. It may not come back as a ledger row.
const NOW_REACHABLE = [
  'packages/agents/src/graph.ts',
  'packages/host/src/orchestrate-cli.ts',
];

function section(page: string, heading: string): string {
  const start = page.indexOf(heading);
  expect(start, `missing section ${heading}`).toBeGreaterThan(-1);
  const rest = page.slice(start);
  const end = rest.indexOf('\n## ', 1);
  return end === -1 ? rest : rest.slice(0, end);
}

// Markdown wraps prose and blockquote markers interrupt a sentence, so a
// claim must be matched on normalized text (blockquote markers dropped,
// all whitespace collapsed) — otherwise a line break would hide a false
// claim from the check.
function prose(page: string): string {
  return page
    .split('\n')
    .map((line) => line.replace(/^\s*>\s?/, ''))
    .join(' ')
    .replace(/\s+/g, ' ');
}

describe('orchestrator scope is honest (issue #95)', () => {
  it('the architecture page states the shipped fan-out and names the gaps', () => {
    const page = readFileSync(ARCHITECTURE_PAGE, 'utf8');
    const body = prose(page);
    // The old claim — the agent stops executing and becomes a manager — is
    // exactly the behaviour that does not ship. It must be gone.
    expect(body).not.toMatch(/the agent stops executing/i);
    expect(body).not.toMatch(/becomes a manager/i);
    // What ships instead, stated as the model: the CLI is the manager.
    expect(body).toMatch(/the CLI (process )?is the manager/i);
    expect(body).toMatch(/same prompt/i);
    // Each re-scoped gap is named with the issue that owns it.
    for (const issue of [
      MANAGER_LANE_ISSUE,
      ROLE_PROMPTS_ISSUE,
      WORKER_APPROVALS_ISSUE,
      ORCHESTRATOR_LEFTOVERS_ISSUE,
    ]) {
      expect(body, `architecture page must name ${issue}`).toContain(issue);
    }
    // The §59.1 honest-limits line survives the rewrite.
    expect(body).toMatch(/separate concurrent writers only/i);
  });

  it('the CLI page says every worker runs the same prompt, and how many run', () => {
    const page = readFileSync(COMMANDS_PAGE, 'utf8');
    const body = prose(section(page, '## `kubic orchestrate'));
    // Prompts may not differ: the shipped run copies -p to every worker.
    expect(body).toMatch(/same prompt|prompt every worker runs/i);
    expect(body).toMatch(/one after another|sequentially|serially/i);
    // The shipped default and the re-scoped gaps are both named.
    expect(body).toContain('worker-1,worker-2');
    for (const issue of [
      MANAGER_LANE_ISSUE,
      ROLE_PROMPTS_ISSUE,
      WORKER_APPROVALS_ISSUE,
    ]) {
      expect(body, `orchestrate section must name ${issue}`).toContain(issue);
    }
  });

  it('amends D7 and D8 in the design registry when the local registry is present', () => {
    // The registry is gitignored local design work (see .gitignore), so a
    // fresh clone has nothing to pin and this check skips — the same
    // absent-file rule packages/exec/src/replay-surface.test.ts uses.
    if (!existsSync(REGISTRY)) return;
    const parsed = JSON.parse(readFileSync(REGISTRY, 'utf8')) as {
      decisions?: Array<{
        id?: string;
        status?: string;
        decision?: string;
        rationale?: string;
      }>;
    };
    const byId = new Map(
      (parsed.decisions ?? []).map((entry) => [entry.id ?? '', entry]),
    );
    for (const id of ['D7', 'D8']) {
      const entry = byId.get(id);
      expect(entry, `${id} must exist in the registry`).toBeDefined();
      const text = `${entry?.decision ?? ''}\n${entry?.rationale ?? ''}`;
      // An amendment is dated and names the issue that records the reality.
      expect(text, `${id} must be amended`).toMatch(
        /Amended \d{4}-\d{2}-\d{2}/,
      );
      expect(text, `${id} must name the manager-lane issue`).toContain(
        MANAGER_LANE_ISSUE,
      );
    }
    // D7's amendment states what the mode actually ships.
    expect(byId.get('D7')?.decision ?? '').toMatch(/CLI/);
    // D8's amendment states the shipped session-scoped entry point.
    expect(byId.get('D8')?.decision ?? '').toMatch(
      /kubic orchestrate|--session/,
    );
  });

  it('gives every runtime-dead orchestrator module a ledger row it can execute', () => {
    const ledger = readFileSync(LEDGER, 'utf8');
    // Rows are `<loc> | <path> | <owner> | <disposition>`.
    const rows = new Map<string, string>();
    for (const line of ledger.split('\n')) {
      const cells = line
        .trim()
        .replace(/^\|/, '')
        .replace(/\|$/, '')
        .split('|')
        .map((cell) => cell.trim());
      if (cells.length < 4) continue;
      const path = cells[1].replace(/^`|`$/g, '');
      if (!path.startsWith('packages/')) continue;
      rows.set(path, cells.slice(2).join(' | '));
    }
    // EVERY module under packages/host/src/orchestrator/ (non-test sources)
    // has a three-way disposition: reachable (in no ledger row), named-issue
    // (a row whose owner is an open issue), or deleted (gone from the tree).
    // Nothing may stay undisposed, and no row may be owned by #95.
    const dir = join(ROOT, 'packages', 'host', 'src', 'orchestrator');
    const modules: string[] = [];
    const walk = (current: string): void => {
      for (const entry of readdirSync(current, { withFileTypes: true })) {
        const full = join(current, entry.name);
        if (entry.isDirectory()) {
          walk(full);
          continue;
        }
        if (!entry.name.endsWith('.ts') || entry.name.endsWith('.test.ts')) {
          continue;
        }
        modules.push(full.slice(ROOT.length + 1));
      }
    };
    walk(dir);
    expect(modules.length).toBeGreaterThan(20);
    for (const path of modules) {
      const row = rows.get(path);
      if (row === undefined) continue; // reachable: no row is the disposition
      expect(row, `${path} must not stay owned by #95`).not.toMatch(/#95\b/);
      expect(row, `${path} must name its future issue`).toMatch(/#\d+/);
    }
    // The modules this issue disposed of stay disposed: deleted barrels are
    // gone, and the dead modules keep their named-issue owners.
    const deadNow = [
      'packages/host/src/orchestrator/approvals/budgets.ts',
      'packages/host/src/orchestrator/approvals/request.ts',
      'packages/host/src/orchestrator/approvals/routing.ts',
      'packages/host/src/orchestrator/approvals/skip.ts',
      'packages/host/src/orchestrator/manager.ts',
      'packages/host/src/orchestrator/merge/conflicts.ts',
      'packages/host/src/orchestrator/parallel/visibility.ts',
      'packages/host/src/orchestrator/worktree/status.ts',
    ];
    for (const path of deadNow) {
      const row = rows.get(path);
      expect(row, `${path} needs a ledger row`).toBeDefined();
      expect(row, `${path} must name a future issue or a deletion`).toMatch(
        new RegExp(
          `${MANAGER_LANE_ISSUE}|${WORKER_APPROVALS_ISSUE}|${ORCHESTRATOR_LEFTOVERS_ISSUE}|#98|delete`,
        ),
      );
      expect(row, `${path} must not stay owned by #95`).not.toMatch(/#95\b/);
    }
    // The orchestrator rows this issue executed are gone, and no row names a
    // deleted file (the gate fails on both, this pins the intent).
    for (const path of DELETED) {
      expect(rows.has(path), `${path} was deleted — drop its ledger row`).toBe(
        false,
      );
      expect(existsSync(join(ROOT, path)), `${path} must be deleted`).toBe(
        false,
      );
    }
    // The modules this issue wired are out of the ledger (the gate fails on
    // a row that became reachable).
    for (const path of NOW_REACHABLE) {
      expect(
        rows.has(path),
        `${path} is reachable — it must not stay in the ledger`,
      ).toBe(false);
    }
    expect(ledger).toMatch(/#95 re-scoped|issue #95/);
  });
});
