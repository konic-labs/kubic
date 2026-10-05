// Orchestrator scope is pinned to what ships (issue #95; §5.2, §9.2, §12,
// §40, §41, §45, §54, D7/D8/D12). This issue decided the delegation model
// by measurement, then #103 closed the manager-lane gap it named. The live
// path is a CLI-driven fan-out whose root lane now REGISTERS the §40 toolset
// and authors a plan whose steps become per-worker prompts — so the docs
// must state that, and may no longer claim the lane is unwired or that every
// worker runs the same prompt. What remains unwired is still named by issue
// (#104 role prompts, #106 leftovers); #105 wired the per-worker approvals it
// owned. These tests make the claims load-bearing, the way clean-docs.test.ts
// does for `kubic clean`:
//   - the architecture page must state the shipped model — the CLI process
//     registers the manager lane and plans per-worker prompts — and name the
//     issues that own what is still missing;
//   - the CLI page must say each worker runs its own plan step and that the
//     default is two agents executed one after another;
//   - D7/D8 in the local design registry must be amended rather than left
//     contradicting the code (skipped in a fresh clone — registry is local);
//   - every runtime-dead module under packages/host/src/orchestrator/ must
//     have a ledger row that is a named issue or a deletion, and no row may
//     still be owned by an executed issue — manager.ts is WIRED by #103, so
//     it may not come back as a row;
//   - the deleted orchestrator leftovers stay deleted.

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { createGitSandbox } from '../../../exec/src/test-support/git-sandbox.js';
import type { SessionHandle } from '../../../worker/src/lane/session-store.js';
import {
  BACKGROUND_CONTEXT,
  type Context,
  createModels,
  type EntryRecord,
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
  MemoryStorage,
  SystemEntry,
  ToolResultEntry,
} from '../../../worker/src/pi-boundary.js';
import {
  EXEC_FORBIDDEN_TOOLS,
  MANAGER_ALLOWLIST,
  ManagerToolsetError,
} from './manager.js';
import {
  bootManagerLane,
  MANAGER_PROMPT_SECTION,
  type ManagerLaneHandle,
  managerToolStubs,
} from './manager-lane.js';

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

// Wired by #103 (this issue's successor on the same surface): the manager
// lane registers through the §40 allowlist and authors the plan whose steps
// become the per-worker prompts. manager.ts is reachable from the binary, so
// keeping a ledger row for it would fail the reachability gate.
const MANAGER_LANE_REACHABLE = ['packages/host/src/orchestrator/manager.ts'];

// Wired by #105 (the approvals successor, same surface): the orchestrator
// approval layer — request envelopes, the router with its bounded wait and
// durable decisions, opt-in budgets, the session-scoped skip — is constructed
// per run and consulted from the delegation path (worker-asks.ts + the CLI).
// Each of the four was a named-issue row once; none may come back as one.
const WORKER_APPROVALS_REACHABLE = [
  'packages/host/src/orchestrator/approvals/budgets.ts',
  'packages/host/src/orchestrator/approvals/request.ts',
  'packages/host/src/orchestrator/approvals/routing.ts',
  'packages/host/src/orchestrator/approvals/skip.ts',
];

// Wired by #106 (the leftovers successor, same surface): conflict delegation
// (merge/conflicts.ts), the §49.1 parallel counts + trajectory event
// (parallel/visibility.ts) and retained-worktree dirtiness (worktree/status.ts)
// all reach the shipped orchestrate path. These three ARE this issue's own
// named-issue rows, so a returning row would fail the reachability gate.
const ORCHESTRATOR_LEFTOVERS_REACHABLE = [
  'packages/host/src/orchestrator/merge/conflicts.ts',
  'packages/host/src/orchestrator/parallel/visibility.ts',
  'packages/host/src/orchestrator/worktree/status.ts',
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

// The tracked docs/ pages plus README.md. `git ls-files` is the source (never
// a plain directory walk: docs/design/ is gitignored local design work). Under
// Stryker the suite runs from a gitignored sandbox copy
// (.stryker-tmp/sandbox-*/) where git lists nothing; Stryker copies only
// non-ignored files there, so a walk of docs/ that skips docs/design/ IS the
// tracked set. The non-empty guard in the test keeps both paths honest.
function markdownOnDisk(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(join(ROOT, dir), { withFileTypes: true })) {
    const rel = `${dir}/${entry.name}`;
    if (entry.isDirectory()) {
      if (rel !== 'docs/design') found.push(...markdownOnDisk(rel));
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
      listed = sandbox.git(['ls-files', 'docs', 'README.md'], {
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
  if (files.length > 0) return files;
  const walked = markdownOnDisk('docs');
  if (existsSync(join(ROOT, 'README.md'))) walked.push('README.md');
  return walked.sort();
}

describe('orchestrator scope is honest (issue #95)', () => {
  it('the architecture page states the shipped fan-out and names the gaps', () => {
    const page = readFileSync(ARCHITECTURE_PAGE, 'utf8');
    const body = prose(page);
    // The old claim — the agent stops executing and becomes a manager — is
    // exactly the behaviour that does not ship. It must be gone.
    expect(body).not.toMatch(/the agent stops executing/i);
    expect(body).not.toMatch(/becomes a manager/i);
    // What ships instead, stated as the model: the CLI is the manager…
    expect(body).toMatch(/the CLI (process )?is the manager/i);
    // …and since #103 its lane REGISTERS the §40 toolset and plans a prompt
    // per worker, so the page may not claim the lane is unwired or that
    // every worker runs the same prompt.
    expect(body).not.toMatch(/same prompt/i);
    expect(body).not.toMatch(/no live lane registers/i);
    expect(body).toMatch(/registers? (the )?(§40|manager) lane/i);
    expect(body).toMatch(/plan step|per-worker prompt/i);
    // Each remaining gap is named with the issue that owns it.
    for (const issue of [
      ROLE_PROMPTS_ISSUE,
      WORKER_APPROVALS_ISSUE,
      ORCHESTRATOR_LEFTOVERS_ISSUE,
    ]) {
      expect(body, `architecture page must name ${issue}`).toContain(issue);
    }
    // #103 is shipped, so it appears as history, never as a promise.
    expect(body).not.toMatch(/#103\)? (is|will be|too)/i);
    // The §59.1 honest-limits line survives the rewrite.
    expect(body).toMatch(/separate concurrent writers only/i);
  });

  it('the CLI page says each worker runs its own plan step, and how many run', () => {
    const page = readFileSync(COMMANDS_PAGE, 'utf8');
    const body = prose(section(page, '## `kubic orchestrate'));
    // Prompts differ now: each worker runs its own plan step.
    expect(body).not.toMatch(/same prompt/i);
    expect(body).not.toMatch(/prompts may not differ/i);
    expect(body).toMatch(/plan step|per-worker prompt/i);
    // #206: the section states how many run and that they overlap.
    expect(body).toMatch(/concurrently|concurrent\b/i);
    // The shipped default and the remaining gaps are both named.
    expect(body).toContain('worker-1,worker-2');
    for (const issue of [ROLE_PROMPTS_ISSUE, WORKER_APPROVALS_ISSUE]) {
      expect(body, `orchestrate section must name ${issue}`).toContain(issue);
    }
  });

  it('no shipped doc claims a manager agent that the binary does not run', () => {
    // The re-scope must hold for EVERY reader-facing doc, not only the two
    // pages this issue edited. README.md and docs/architecture/solo.md
    // carried the same false claim after the merge, which is exactly the
    // defect the re-scope exists to remove — so pin the class, not the sites.
    //
    // Scope is the TRACKED docs: docs/design/ is gitignored local design work
    // that legitimately describes intent rather than shipped behaviour, and
    // it carries its own `shipped-differently` notes.
    const files = trackedDocs().map((line) => join(ROOT, line));
    expect(files.length).toBeGreaterThan(20);
    for (const file of files) {
      const body = prose(readFileSync(file, 'utf8'));
      const where = file.slice(ROOT.length + 1);
      // A claim about the AGENT becoming the manager is still false — the
      // lane registered since #103 is the run's own toolset registration,
      // not a model-driven agent. The shipped statement says the CLI process
      // is the manager, which these patterns deliberately do not match.
      expect(body, `${where} must not claim a manager agent`).not.toMatch(
        /becomes a manager/i,
      );
      expect(
        body,
        `${where} must not claim the agent stops executing`,
      ).not.toMatch(/stops executing/i);
      // A manager "fanning work out" is the same unwired lane in other words.
      expect(
        body,
        `${where} must not claim a manager fans work out`,
      ).not.toMatch(/manager fans work out|manager (then )?fans/i);
      // The lane is wired now: no doc may still promise it as future work,
      // and none may claim every worker runs one shared prompt.
      expect(body, `${where} must not call the lane unwired`).not.toMatch(
        /manager \*?agent\*? lane (is|are) not wired|not wired yet/i,
      );
      expect(body, `${where} must not claim one shared prompt`).not.toMatch(
        /same `?-p`? prompt|every worker runs the same prompt/i,
      );
    }
  });

  // The registry is gitignored local design work (see .gitignore), so a
  // fresh clone (or a Stryker sandbox) has nothing to pin: the check is
  // reported SKIPPED there rather than passing green on an early return.
  it.skipIf(!existsSync(REGISTRY))(
    'amends D7 and D8 in the design registry when the local registry is present',
    () => {
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
    },
  );

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
    // Not vacuous: a ledger format drift that parses to zero rows would make
    // every `rows.has(...)` absence check below pass for free.
    expect(rows.size).toBeGreaterThan(10);
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
    // gone, and a module that a successor issue wired must not come back as a
    // row. Every module that once carried a named-issue row is now REACHABLE
    // (manager.ts via #103; the conflict/parallel/retain trio via #106; the
    // four approvals modules via #105) — verified with the reachability report,
    // never assumed. So there is no "still dead, needs a row" list left on this
    // surface: the reachable lists below carry the whole pin. A row for any of
    // them fails the reachability gate for real.
    for (const path of DELETED) {
      expect(rows.has(path), `${path} was deleted — drop its ledger row`).toBe(
        false,
      );
      expect(existsSync(join(ROOT, path)), `${path} must be deleted`).toBe(
        false,
      );
    }
    // The modules wired since are out of the ledger (the gate fails on a row
    // that became reachable) — including manager.ts, which #103 wired, and
    // the four approvals modules, which #105 wired.
    for (const path of [
      ...NOW_REACHABLE,
      ...MANAGER_LANE_REACHABLE,
      ...WORKER_APPROVALS_REACHABLE,
      ...ORCHESTRATOR_LEFTOVERS_REACHABLE,
    ]) {
      expect(
        rows.has(path),
        `${path} is reachable — it must not stay in the ledger`,
      ).toBe(false);
    }
    expect(ledger).toMatch(/#95 re-scoped|issue #95/);
  });
});

describe('manager lane toolset (issue #413)', () => {
  const lanes: ManagerLaneHandle[] = [];

  afterEach(async () => {
    for (const lane of lanes.splice(0)) {
      await lane.close(BACKGROUND_CONTEXT);
    }
  });

  // A MemoryStorage-backed handle: no session root, no lock, no fs.
  function memoryHandle(id: string, cwd: string): SessionHandle {
    const storage = new MemoryStorage();
    let adopted = false;
    return {
      id,
      dir: `/memory-sessions/${id}`,
      storage,
      meta: { cwd, createdAt: new Date(0).toISOString() },
      adopt: () => {
        adopted = true;
        return storage;
      },
      release: async (context: Context): Promise<void> => {
        if (!adopted) await storage.close(context);
      },
    };
  }

  async function boot(
    responses: Parameters<ReturnType<typeof fauxProvider>['setResponses']>[0],
  ): Promise<ManagerLaneHandle> {
    const faux = fauxProvider();
    const models = createModels();
    models.setProvider(faux.provider);
    const model = faux.getModel();
    if (model === undefined) throw new Error('faux has no default model');
    faux.setResponses([...responses]);
    const lane = await bootManagerLane({
      session: memoryHandle('mgr-1', '/repo'),
      models,
      model,
      sessionId: 'mgr-1',
      cwd: '/repo',
    });
    lanes.push(lane);
    return lane;
  }

  async function bootWithTools(
    tools: Parameters<typeof bootManagerLane>[0]['tools'],
  ): Promise<never> {
    const faux = fauxProvider();
    const models = createModels();
    models.setProvider(faux.provider);
    const model = faux.getModel();
    if (model === undefined) throw new Error('faux has no default model');
    const lane = await bootManagerLane({
      session: memoryHandle('mgr-drift', '/repo'),
      models,
      model,
      sessionId: 'mgr-drift',
      cwd: '/repo',
      tools,
    });
    lanes.push(lane);
    throw new Error('booted with a drifted toolset');
  }

  function promptOf(entries: EntryRecord[]): string {
    for (const entry of entries) {
      if (!SystemEntry.is(entry)) continue;
      const messages = entry.model as
        | Array<{ sections?: Record<string, string | null> }>
        | undefined;
      const prompt = messages?.[0]?.sections?.[MANAGER_PROMPT_SECTION];
      if (typeof prompt === 'string' && prompt !== '') return prompt;
    }
    return '';
  }

  it('boots a lane whose active tools equal MANAGER_ALLOWLIST', async () => {
    const lane = await boot([fauxAssistantMessage('ok')]);
    const agent = await lane.conversation.agent(BACKGROUND_CONTEXT);
    const active = agent.tools.map((tool) => tool.name).sort();
    expect(active).toEqual([...MANAGER_ALLOWLIST].sort());
    for (const forbidden of EXEC_FORBIDDEN_TOOLS) {
      expect(active).not.toContain(forbidden);
    }
  });

  it('the committed prompt advertises exactly the offered set', async () => {
    const lane = await boot([fauxAssistantMessage('ok')]);
    // The system entry materializes with the first turn, as on the solo
    // lane (solo-tools-line.test.ts reads it the same way).
    const first = await lane.conversation.submit(
      { type: 'input', content: 'hi' },
      BACKGROUND_CONTEXT,
    );
    await first.wait(BACKGROUND_CONTEXT);
    const page = await lane.conversation.entries(
      {},
      500,
      undefined,
      BACKGROUND_CONTEXT,
    );
    const line =
      /^tools: (.*)$/m.exec(promptOf([...page.items].reverse()))?.[1] ?? '';
    const advertised = line
      .split(',')
      .map((name) => name.trim())
      .filter((name) => name !== '')
      .sort();
    expect(advertised).toEqual([...MANAGER_ALLOWLIST].sort());
  });

  it('a drifted toolset refuses to boot with a named reason', async () => {
    // A tool missing from the allowlist…
    await expect(
      bootWithTools([...managerToolStubs()].slice(0, 12)),
    ).rejects.toBeInstanceOf(ManagerToolsetError);
    await expect(
      bootWithTools([...managerToolStubs()].slice(0, 12)),
    ).rejects.toThrow(/manager toolset must equal the allowlist.*missing/);
    // …and an exec tool smuggled in under a renamed registration.
    const renamed = [...managerToolStubs()].map((tool, index) =>
      index === 0 ? { ...tool, name: 'bash' } : tool,
    );
    await expect(bootWithTools(renamed)).rejects.toThrow(
      /manager toolset must equal the allowlist.*extra: bash/,
    );
  });

  it('an unwired tool refuses the call by name', async () => {
    const lane = await boot([fauxAssistantMessage('ok')]);
    const tool = lane.registry
      .snapshot()
      .tools()
      .find(({ tool: candidate }) => candidate.name === 'spawn_agent')?.tool;
    if (tool === undefined) throw new Error('spawn_agent not registered');
    await expect(
      tool.execute(
        {},
        {
          callId: 'call-1',
          taskId: 'task-1',
          conversationId: lane.conversation.id,
          output: () => undefined,
          diagnostic: () => undefined,
          details: async () => undefined,
          memo: async () => undefined,
          commit: async () => undefined,
          env: undefined,
        } as never,
        BACKGROUND_CONTEXT,
      ),
    ).rejects.toThrow(/spawn_agent.*not wired yet/);
  });

  it('a faux manager tool round ends with stopReason toolUse and the lane refuses it', async () => {
    const lane = await boot([
      // A toolUse turn with no following text ends `unanswered`: the
      // trailing message is the turn's answer, as in every faux script.
      fauxAssistantMessage([fauxToolCall('spawn_agent', {})], {
        stopReason: 'toolUse',
      }),
      fauxAssistantMessage('refused as expected'),
    ]);
    const submission = await lane.conversation.submit(
      { type: 'input', content: 'go' },
      BACKGROUND_CONTEXT,
    );
    const settled = await submission.wait(BACKGROUND_CONTEXT);
    expect(settled.status).toBe('done');
    const entries = await lane.conversation.entries(
      {},
      1000,
      undefined,
      BACKGROUND_CONTEXT,
    );
    const results: string[] = [];
    for (const entry of entries.items) {
      if (!ToolResultEntry.is(entry)) continue;
      const message = (
        entry.model as unknown as
          | Array<{ role?: string; content?: Array<{ text?: string }> }>
          | undefined
      )?.[0];
      if (message?.role !== 'toolResult') continue;
      results.push(
        (message.content ?? []).map((part) => part.text ?? '').join(''),
      );
    }
    expect(results.length).toBeGreaterThan(0);
    expect(results.join('\n')).toContain('spawn_agent');
  });
});
