// `kubic cost` CLI tests. Cost-cli.ts lands
// after this file. Faux-only, zero network — rows are injected.
import {
  appendFileSync,
  mkdtempSync,
  rmSync,
  statSync,
  utimesSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  attachSession,
  createSession,
  openSessionStore,
} from '@kubic/agent/lane/session-store';
import {
  BACKGROUND_CONTEXT,
  createModels,
  createRegistry,
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
  Harness,
  type Storage,
} from '@kubic/agent/pi-boundary';
import { EXIT_OK, EXIT_USAGE } from '@kubic/core/cli/exit-codes';
import { createNodeFileBridge } from '@kubic/exec/file-bridge';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FAUX_PROVIDER_ID } from '../models/index.js';
import { loadSessionCostRows, runCostCommand } from './index.js';

const attached = vi.hoisted(() => ({
  calls: [] as Array<readonly unknown[]>,
  // Scripted `sessionLockIsLive` answers, consumed in order
  // (a mid-read-liveness test scripts [undefined, live]). Empty means
  // passthrough to the real probe, so every other test is unaffected.
  lockScript: [] as Array<{ pid: number; startedAt?: number } | undefined>,
}));

vi.mock('@kubic/agent/lane/session-store', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@kubic/agent/lane/session-store')>();
  return {
    ...actual,
    attachSession: (...args: Parameters<typeof actual.attachSession>) => {
      attached.calls.push(args);
      return actual.attachSession(...args);
    },
    sessionLockIsLive: (sessionDir: string) => {
      if (attached.lockScript.length > 0) return attached.lockScript.shift();
      return actual.sessionLockIsLive(sessionDir);
    },
  };
});

// stdout (`lines`) and stderr (`errs`) captured separately: data and
// diagnostics never share a channel.
function capture() {
  const lines: string[] = [];
  const errs: string[] = [];
  return {
    lines,
    errs,
    out: (line: string): void => {
      lines.push(line);
    },
    err: (line: string): void => {
      errs.push(line);
    },
  };
}

describe('kubic cost lock-free reads', () => {
  const made: string[] = [];
  const open: Harness[] = [];

  function tmpRoot(): string {
    const dir = mkdtempSync(join(tmpdir(), 'cost-cli-'));
    made.push(dir);
    return dir;
  }

  afterEach(async () => {
    for (const harness of open.splice(0)) {
      await harness.close(BACKGROUND_CONTEXT).catch(() => undefined);
    }
    for (const dir of made.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  async function fauxRun(storage: Storage) {
    const faux = fauxProvider();
    const models = createModels();
    models.setProvider(faux.provider);
    const harness = await Harness.open(
      storage,
      { models, registry: createRegistry() },
      BACKGROUND_CONTEXT,
    );
    open.push(harness);
    const conversation = await harness.root(BACKGROUND_CONTEXT, {
      agent: { model: { provider: 'faux', modelId: 'faux-1' } },
    });
    faux.setResponses([
      fauxAssistantMessage([fauxToolCall('read', { path: 'a.txt' })], {
        stopReason: 'toolUse',
      }),
      fauxAssistantMessage('done'),
    ]);
    await (
      await conversation.submit(
        { type: 'input', content: 'read a.txt' },
        BACKGROUND_CONTEXT,
      )
    ).wait(BACKGROUND_CONTEXT);
    return harness;
  }

  it('leaves every session dir mtime untouched', async () => {
    const root = tmpRoot();
    const store = openSessionStore(root, createNodeFileBridge(root));
    const ids: string[] = [];
    for (let i = 0; i < 2; i += 1) {
      const session = await createSession(
        store,
        { cwd: '/work' },
        BACKGROUND_CONTEXT,
      );
      await fauxRun(session.adopt());
      await session.release(BACKGROUND_CONTEXT);
      ids.push(session.id);
    }
    // Pin the age signal prune reads: any lock.json create/remove bumps
    // the dir mtime off this baseline (attach+release does both).
    const baseline = 1_700_000_000_000;
    for (const id of ids) {
      utimesSync(join(root, id), baseline / 1000, baseline / 1000);
    }
    const rows = await loadSessionCostRows(root);
    expect(rows.length).toBeGreaterThan(0);
    for (const id of ids) {
      expect(statSync(join(root, id)).mtimeMs).toBe(baseline);
    }
  });

  it('never attaches while reading, so a concurrent attach is not blocked', async () => {
    const root = tmpRoot();
    const store = openSessionStore(root, createNodeFileBridge(root));
    const session = await createSession(
      store,
      { cwd: '/work' },
      BACKGROUND_CONTEXT,
    );
    await fauxRun(session.adopt());
    await session.release(BACKGROUND_CONTEXT);

    attached.calls.length = 0;
    const rows = await loadSessionCostRows(root);
    expect(rows.length).toBeGreaterThan(0);
    // The old attach+release path held each session's lock while reading
    // it, so a concurrent `kubic run --session` refused with
    // SessionLockError. The lock-free path never attaches at all.
    expect(attached.calls).toEqual([]);
    const holder = await attachSession(store, session.id, BACKGROUND_CONTEXT);
    try {
      expect(holder.id).toBe(session.id);
    } finally {
      await holder.release(BACKGROUND_CONTEXT);
    }
  });

  it('exits 0 and reports the locked session in the text view', async () => {
    const cap = capture();
    const code = (
      await runCostCommand(
        {},
        {
          loadRows: () => [
            {
              session: 'sess-live',
              model: '(locked)',
              costUsd: 0,
              input: 0,
              output: 0,
            },
          ],
          out: cap.out,
          err: cap.err,
        },
      )
    ).exitCode;
    expect(code).toBe(EXIT_OK);
    expect(cap.lines.join('\n')).toContain('(locked)');
    expect(cap.errs).toEqual([]);
  });

  // Between the `sessionLockIsLive`
  // probe and the read, a session can go live — cost then reads a store
  // another process is appending to. The torn tail must not fail the
  // report, and a row that went live mid-read must say it may be
  // incomplete.
  it('skips a torn trailing record instead of failing the report', async () => {
    const root = tmpRoot();
    const store = openSessionStore(root, createNodeFileBridge(root));
    const session = await createSession(
      store,
      { cwd: '/work' },
      BACKGROUND_CONTEXT,
    );
    await fauxRun(session.adopt());
    await session.release(BACKGROUND_CONTEXT);
    // The mid-append instant, frozen: a partial trailing record with no
    // terminating newline — the writer's uncommitted tail.
    appendFileSync(
      join(root, session.id, 'main.jsonl'),
      '{"type":"entry","seq":999999,"incompl',
    );

    const rows = await loadSessionCostRows(root, session.id);
    // Complete report: the intact usage row survives, the torn tail is
    // in-flight and skipped.
    expect(rows).toHaveLength(1);
    expect(rows[0]?.session).toBe(session.id);
    expect(rows[0]?.model.startsWith('(')).toBe(false);
    expect(rows[0]?.input).toBeGreaterThan(0);
  });

  it('marks a session that goes live during the read (live)', async () => {
    const root = tmpRoot();
    const store = openSessionStore(root, createNodeFileBridge(root));
    const session = await createSession(
      store,
      { cwd: '/work' },
      BACKGROUND_CONTEXT,
    );
    await fauxRun(session.adopt());
    await session.release(BACKGROUND_CONTEXT);
    // Dead at the pre-read probe, live at the post-read probe: the race
    // this test simulates. Our own pid is trivially alive.
    attached.lockScript.push(undefined, { pid: process.pid });
    try {
      const rows = await loadSessionCostRows(root, session.id);
      // The read rows stay; a zero marker row says they may be partial.
      const read = rows.find((row) => !row.model.startsWith('('));
      expect(read).toMatchObject({ session: session.id });
      expect(read?.input).toBeGreaterThan(0);
      expect(rows.find((row) => row.model === '(live)')).toMatchObject({
        session: session.id,
        costUsd: 0,
        input: 0,
        output: 0,
      });
    } finally {
      attached.lockScript.length = 0;
    }
  });
});

describe('kubic cost project scope and grouping', () => {
  const made: string[] = [];
  const open: Harness[] = [];
  const MODEL_REF = `${FAUX_PROVIDER_ID}/faux-1`;

  function tmpRoot(): string {
    const dir = mkdtempSync(join(tmpdir(), 'cost-cli-'));
    made.push(dir);
    return dir;
  }

  afterEach(async () => {
    for (const harness of open.splice(0)) {
      await harness.close(BACKGROUND_CONTEXT).catch(() => undefined);
    }
    for (const dir of made.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  async function fauxRun(storage: Storage) {
    const faux = fauxProvider();
    const models = createModels();
    models.setProvider(faux.provider);
    const harness = await Harness.open(
      storage,
      { models, registry: createRegistry() },
      BACKGROUND_CONTEXT,
    );
    open.push(harness);
    const conversation = await harness.root(BACKGROUND_CONTEXT, {
      agent: { model: { provider: 'faux', modelId: 'faux-1' } },
    });
    faux.setResponses([
      fauxAssistantMessage([fauxToolCall('read', { path: 'a.txt' })], {
        stopReason: 'toolUse',
      }),
      fauxAssistantMessage('done'),
    ]);
    await (
      await conversation.submit(
        { type: 'input', content: 'read a.txt' },
        BACKGROUND_CONTEXT,
      )
    ).wait(BACKGROUND_CONTEXT);
    return harness;
  }

  async function storedRun(
    root: string,
    opts: {
      id: string;
      cwd: string;
      workspace?: string;
    },
  ): Promise<string> {
    const store = openSessionStore(root, createNodeFileBridge(root));
    const session = await createSession(store, opts, BACKGROUND_CONTEXT);
    await fauxRun(session.adopt());
    await session.release(BACKGROUND_CONTEXT);
    return session.id;
  }

  it('shows only sessions touching the workspace by default', async () => {
    const root = tmpRoot();
    await storedRun(root, {
      id: 'proj-a-1',
      cwd: '/proj-a',
      workspace: '/proj-a',
    });
    await storedRun(root, {
      id: 'proj-b-1',
      cwd: '/proj-b',
      workspace: '/proj-b',
    });
    const rows = await loadSessionCostRows(root, undefined, {
      workspace: '/proj-a',
    });
    expect(rows.map((row) => row.session)).toEqual(['proj-a-1']);
  });

  it('shows every project with --all', async () => {
    const root = tmpRoot();
    await storedRun(root, {
      id: 'proj-a-1',
      cwd: '/proj-a',
      workspace: '/proj-a',
    });
    await storedRun(root, {
      id: 'proj-b-1',
      cwd: '/proj-b',
      workspace: '/proj-b',
    });
    const rows = await loadSessionCostRows(root, undefined, {
      workspace: '/proj-a',
      all: true,
    });
    expect(rows.map((row) => row.session).sort()).toEqual([
      'proj-a-1',
      'proj-b-1',
    ]);
  });

  it('matches nested workspaces in both directions', async () => {
    const root = tmpRoot();
    await storedRun(root, {
      id: 'root-run',
      cwd: '/repo',
      workspace: '/repo',
    });
    await storedRun(root, {
      id: 'sub-run',
      cwd: '/repo/sub',
      workspace: '/repo/sub',
    });
    // From a subdirectory, the root run still belongs to the project…
    const fromSub = await loadSessionCostRows(root, undefined, {
      workspace: '/repo/sub',
    });
    expect(fromSub.map((row) => row.session).sort()).toEqual([
      'root-run',
      'sub-run',
    ]);
    // …and from the root, the subdir run does too.
    const fromRoot = await loadSessionCostRows(root, undefined, {
      workspace: '/repo',
    });
    expect(fromRoot.map((row) => row.session).sort()).toEqual([
      'root-run',
      'sub-run',
    ]);
  });

  it("names a session's project and model", async () => {
    const root = tmpRoot();
    await storedRun(root, {
      id: 's-model',
      cwd: '/repo',
      workspace: '/repo',
    });
    const rows = await loadSessionCostRows(root, 's-model');
    expect(rows.map((row) => row.session)).toEqual(['s-model']);
    expect(rows.map((row) => row.project)).toEqual(['/repo']);
    expect(rows.map((row) => row.model)).toEqual([MODEL_REF]);
  });

  it('aggregates to one row per session with --by session', async () => {
    const root = tmpRoot();
    await storedRun(root, { id: 's-one', cwd: '/w', workspace: '/w' });
    await storedRun(root, { id: 's-two', cwd: '/w', workspace: '/w' });
    const rows = await loadSessionCostRows(root, undefined, {
      workspace: '/w',
      by: 'session',
    });
    expect(rows.map((row) => row.session).sort()).toEqual(['s-one', 's-two']);
    const total = rows.reduce((acc, row) => acc + row.costUsd, 0);
    const projectRows = await loadSessionCostRows(root, undefined, {
      workspace: '/w',
      by: 'project',
    });
    expect(total).toBeCloseTo(
      projectRows.reduce((acc, row) => acc + row.costUsd, 0),
    );
    // The per-request rows carry each response's model spend; for these runs
    // they must add up to the session total as well.
    const requestRows = await loadSessionCostRows(root, undefined, {
      workspace: '/w',
      by: 'request',
    });
    expect(total).toBeCloseTo(
      requestRows.reduce((acc, row) => acc + row.costUsd, 0),
    );
  });

  it('aggregates to one row per project with --by project', async () => {
    const root = tmpRoot();
    await storedRun(root, { id: 's-one', cwd: '/w', workspace: '/w' });
    await storedRun(root, { id: 's-two', cwd: '/w', workspace: '/w' });
    const rows = await loadSessionCostRows(root, undefined, {
      workspace: '/w',
      by: 'project',
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.project).toBe('/w');
    expect(rows[0]?.model).toBe('-');
    expect(rows[0]?.costUsd).toBeGreaterThanOrEqual(0);
    const sessionRows = await loadSessionCostRows(root, undefined, {
      workspace: '/w',
      by: 'session',
    });
    expect(rows[0]?.costUsd).toBeCloseTo(
      sessionRows.reduce((acc, row) => acc + row.costUsd, 0),
    );
  });

  it('lists one row per request with --by request', async () => {
    const root = tmpRoot();
    const id = await storedRun(root, {
      id: 'req-run',
      cwd: '/w',
      workspace: '/w',
    });
    const rows = await loadSessionCostRows(root, undefined, {
      workspace: '/w',
      by: 'request',
    });
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row.session).toBe(id);
      expect(row.request).toMatch(/^\d+$/);
      expect(row.model).toBe(MODEL_REF);
    }
    // Request rows carry the responses' own model spend: their sum matches
    // the session's model bucket (tools report no spend here).
    const [sessionRow] = await loadSessionCostRows(root, id);
    expect(sessionRow?.model).toBe(MODEL_REF);
    expect(rows.reduce((acc, row) => acc + row.costUsd, 0)).toBeCloseTo(
      sessionRow?.costUsd ?? NaN,
    );
  });

  it('exits 2 on an invalid --by level', async () => {
    const out: string[] = [];
    const err: string[] = [];
    const code = (
      await runCostCommand(
        { by: 'model' },
        {
          loadRows: () => [],
          out: (line) => out.push(line),
          err: (line) => err.push(line),
        },
      )
    ).exitCode;
    expect(code).toBe(EXIT_USAGE);
    expect(err.join('\n')).toMatch(/invalid --by/);
    expect(out).toEqual([]);
  });

  it('prints in/out/cache columns at sub-cent precision with a total that equals the rows', async () => {
    const out: string[] = [];
    const err: string[] = [];
    const code = (
      await runCostCommand(
        {},
        {
          loadRows: () => [
            {
              session: 'w-1',
              project: '/w',
              model: 'cheap/small',
              costUsd: 0.0023,
              input: 12400,
              output: 1900,
              cacheRead: 4000,
              cacheWrite: 200,
            },
          ],
          out: (line) => out.push(line),
          err: (line) => err.push(line),
        },
      )
    ).exitCode;
    expect(code).toBe(EXIT_OK);
    expect(out[0]).toMatch(
      /^SESSION +MODEL +IN +OUT +CACHE-R +CACHE-W +COST$/m,
    );
    const body = out.join('\n');
    expect(body).toMatch(/w-1/);
    expect(body).toMatch(/12400/);
    expect(body).toMatch(/1900/);
    expect(body).toMatch(/4000/);
    expect(body).toMatch(/\$0\.0023/);
    expect(body).toMatch(/task total \$0\.0023 \(1 session\)/);
    expect(err).toEqual([]);
  });
});
