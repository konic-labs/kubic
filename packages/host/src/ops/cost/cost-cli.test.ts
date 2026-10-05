// `kubic cost` CLI tests (issue #79; §62). RED first: cost-cli.ts lands
// after this file. Faux-only, zero network — rows are injected.
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createNodeFileBridge } from '../../../../exec/src/file-bridge.js';
import {
  attachSession,
  createSession,
  openSessionStore,
} from '../../../../worker/src/lane/session-store.js';
import {
  BACKGROUND_CONTEXT,
  createModels,
  createRegistry,
  defineExtension,
  defineTool,
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
  Harness,
  MemoryStorage,
  type Storage,
  Type,
  UsageDoc,
} from '../../../../worker/src/pi-boundary.js';
import { FAUX_PROVIDER_ID } from '../../faux-provider.js';
import { REDACTED_SECRET } from '../../policy/secret-shapes.js';
import {
  loadSessionCostRows,
  readSessionRunUsage,
  readSessionUsage,
  runCostCommand,
  totalSessionUsage,
} from './cost-cli.js';
import { summarizePerAgentCost, toCostJson } from './per-agent-cost.js';

const attached = vi.hoisted(() => ({ calls: [] as Array<readonly unknown[]> }));

vi.mock(
  '../../../../worker/src/lane/session-store.js',
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import('../../../../worker/src/lane/session-store.js')
      >();
    return {
      ...actual,
      attachSession: (...args: Parameters<typeof actual.attachSession>) => {
        attached.calls.push(args);
        return actual.attachSession(...args);
      },
    };
  },
);

const ROWS = [
  {
    agentId: 'worker-1',
    model: 'cheap/small',
    costUsd: 0.2,
    input: 100,
    output: 50,
  },
  {
    agentId: 'worker-2',
    model: 'pro/large',
    costUsd: 0.3,
    input: 200,
    output: 60,
  },
];

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

describe('kubic cost text view (issue #79)', () => {
  it('prints one row per agent plus the task total', async () => {
    const cap = capture();
    const code = await runCostCommand(
      {},
      {
        loadRows: () => ROWS,
        out: cap.out,
        err: cap.err,
      },
    );
    expect(code).toBe(0);
    // One plain (uncoloured, unboxed) table, then the task total.
    expect(cap.lines[0]).toBe(
      [
        'AGENT     MODEL        TOKENS   COST',
        'worker-1  cheap/small     150  $0.20',
        'worker-2  pro/large       260  $0.30',
      ].join('\n'),
    );
    expect(cap.lines[1]).toBe('task total $0.50 (2 agents)');
    expect(cap.errs).toEqual([]);
  });

  it('draws a box table only when fancy', async () => {
    const cap = capture();
    await runCostCommand(
      {},
      { loadRows: () => ROWS, out: cap.out, err: cap.err, fancy: true },
    );
    expect(cap.lines[0]).toContain('┌');
    expect(cap.lines[0]).toContain('worker-2');
  });

  it('reports no cost rows on an empty rollup', async () => {
    const cap = capture();
    const code = await runCostCommand(
      {},
      {
        loadRows: () => [],
        out: cap.out,
        err: cap.err,
      },
    );
    expect(code).toBe(0);
    expect(cap.lines).toEqual(['no cost rows']);
  });
});

describe('kubic cost --json (issue #79)', () => {
  it('matches the in-code toCostJson shape field-for-field', async () => {
    const cap = capture();
    const code = await runCostCommand(
      { json: true },
      {
        loadRows: () => ROWS,
        out: cap.out,
        err: cap.err,
      },
    );
    expect(code).toBe(0);
    expect(cap.lines).toHaveLength(1);
    expect(cap.errs).toEqual([]);
    const head = cap.lines[0];
    if (head === undefined) throw new Error('missing cost --json line');
    const parsed: unknown = JSON.parse(head);
    const expected = toCostJson(summarizePerAgentCost(ROWS));
    expect(parsed).toEqual(expected);
    expect(Object.keys(parsed as Record<string, unknown>).sort()).toEqual([
      'agents',
      'taskTotal',
    ]);
  });

  it('sums to exactly the task total (Σ verified)', async () => {
    const cap = capture();
    await runCostCommand(
      { json: true },
      {
        loadRows: () => ROWS,
        out: cap.out,
        err: cap.err,
      },
    );
    const head = cap.lines[0];
    if (head === undefined) throw new Error('missing cost --json line');
    const parsed = JSON.parse(head) as {
      agents: Array<{ costUsd: number }>;
      taskTotal: number;
    };
    const parts = parsed.agents.reduce((acc, row) => acc + row.costUsd, 0);
    expect(parts).toBeCloseTo(parsed.taskTotal);
  });
});

describe('kubic cost usage (issue #79, §78)', () => {
  // Argv syntax (unknown flags, a missing --session value, --help) is
  // commander's: apps/kubic/src/commands/analysis.test.ts pins it.
  it('exits 2 on an invalid session id before any store is touched', async () => {
    let touched = false;
    const cap = capture();
    const code = await runCostCommand(
      { session: '../evil' },
      {
        loadRows: () => {
          touched = true;
          return ROWS;
        },
        out: cap.out,
        err: cap.err,
      },
    );
    expect(code).toBe(2);
    expect(touched).toBe(false);
    expect(cap.lines).toEqual([]);
    expect(cap.errs).toEqual([
      'error: invalid --session id "../evil" (use [A-Za-z0-9_-])',
    ]);
  });

  it('forwards the session id to the loader', async () => {
    let seen: string | undefined;
    const cap = capture();
    const code = await runCostCommand(
      { session: 'sess-1' },
      {
        loadRows: (sessionId) => {
          seen = sessionId;
          return ROWS;
        },
        out: cap.out,
        err: cap.err,
      },
    );
    expect(code).toBe(0);
    expect(seen).toBe('sess-1');
  });

  it('exits 1 when the session is unknown', async () => {
    const cap = capture();
    const code = await runCostCommand(
      { session: 'missing' },
      {
        loadRows: () => {
          const error = new Error('unknown session: missing');
          error.name = 'SessionAttachError';
          throw error;
        },
        out: cap.out,
        err: cap.err,
      },
    );
    expect(code).toBe(1);
    expect(cap.lines).toEqual([]);
    expect(cap.errs).toEqual(['error: unknown session: missing']);
  });
});

describe('kubic cost cache aggregation (issue #98, criterion 4)', () => {
  const CACHED_ROWS = [
    {
      agentId: 'sess-hit',
      model: 'aggregate',
      costUsd: 0.4,
      input: 100,
      output: 20,
      cacheRead: 900,
      cacheWrite: 0,
    },
    {
      agentId: 'sess-miss',
      model: 'aggregate',
      costUsd: 0.1,
      input: 80,
      output: 10,
      cacheRead: 0,
      cacheWrite: 500,
    },
  ];

  it('reports the prefix hit-rate from the real usage rows it loaded', async () => {
    const cap = capture();
    const code = await runCostCommand(
      {},
      {
        loadRows: () => CACHED_ROWS,
        out: cap.out,
        err: cap.err,
      },
    );
    expect(code).toBe(0);
    const text = [...cap.lines, ...cap.errs].join('\n');
    // 1 of 2 sessions had a cache read > 0: a real measurement over the
    // rows the loader returned, never an invented number.
    expect(text).toMatch(/cache: 1\/2 sessions with prefix hits/);
    expect(text).toMatch(/50%/);
  });

  it('states that caching is transparent on the same readout', async () => {
    const cap = capture();
    await runCostCommand(
      {},
      { loadRows: () => CACHED_ROWS, out: cap.out, err: cap.err },
    );
    expect(cap.lines.join('\n')).toMatch(/caching is transparent/);
  });

  it('keeps the --json top-level shape field-for-field and adds cache per row', async () => {
    const cap = capture();
    const code = await runCostCommand(
      { json: true },
      {
        loadRows: () => CACHED_ROWS,
        out: cap.out,
        err: cap.err,
      },
    );
    expect(code).toBe(0);
    const head = cap.lines[0];
    if (head === undefined) throw new Error('missing cost --json line');
    const parsed = JSON.parse(head) as {
      agents: Array<Record<string, unknown>>;
      taskTotal: number;
    };
    // Criterion 5: the documented top-level shape is untouched.
    expect(Object.keys(parsed).sort()).toEqual(['agents', 'taskTotal']);
    // The new aggregation is additive: inside the existing per-agent rows.
    expect(parsed.agents[0]?.cacheRead).toBe(900);
    expect(parsed.agents[1]?.cacheWrite).toBe(500);
    expect(parsed.taskTotal).toBeCloseTo(0.5);
  });

  it('stays quiet about cache when the loader returned no cache data', async () => {
    const cap = capture();
    await runCostCommand(
      {},
      { loadRows: () => ROWS, out: cap.out, err: cap.err },
    );
    expect(cap.lines.join('\n')).not.toMatch(/prefix hits/);
  });
});

describe('kubic cost secret backstop (issue #79 fix cycle 1)', () => {
  // Passes SESSION_ID_PATTERN ([A-Za-z0-9_-]) yet matches the sk secret
  // shape: the unknown-session echo must not carry it.
  const SHAPED_SESSION = 'SK-FAUX-TEST-KEY-0001';

  it('redacts a secret-shaped session id in the unknown-session error', async () => {
    const cap = capture();
    const code = await runCostCommand(
      { session: SHAPED_SESSION },
      {
        loadRows: () => {
          const error = new Error(`unknown session: ${SHAPED_SESSION}`);
          error.name = 'SessionAttachError';
          throw error;
        },
        out: cap.out,
        err: cap.err,
      },
    );
    expect(code).toBe(1);
    const text = [...cap.lines, ...cap.errs].join('\n');
    expect(text).not.toContain(SHAPED_SESSION);
    expect(text).toContain(REDACTED_SECRET);
  });

  it('redacts secret-shaped material in store error messages', async () => {
    const cap = capture();
    const code = await runCostCommand(
      {},
      {
        loadRows: () => {
          throw new Error(`store boom ${SHAPED_SESSION}`);
        },
        out: cap.out,
        err: cap.err,
      },
    );
    expect(code).toBe(1);
    const text = [...cap.lines, ...cap.errs].join('\n');
    expect(text).not.toContain(SHAPED_SESSION);
    expect(text).toContain(REDACTED_SECRET);
  });

  it('redacts secret-shaped material in the invalid-session-id echo', async () => {
    // A bearer-shaped value carries a space, so it fails the id pattern
    // and lands in the invalid-id echo — which must not carry it.
    const shaped = 'Bearer abcdefghij1234567890';
    const cap = capture();
    const code = await runCostCommand(
      { session: shaped },
      {
        loadRows: () => ROWS,
        out: cap.out,
        err: cap.err,
      },
    );
    expect(code).toBe(2);
    const text = [...cap.lines, ...cap.errs].join('\n');
    expect(text).not.toContain(shaped);
    expect(text).toContain(REDACTED_SECRET);
  });
});

describe('kubic cost durable usage (issue #400)', () => {
  // The faux provider's default model (not the host fixture's `echo`).
  const MODEL_REF = `${FAUX_PROVIDER_ID}/faux-1`;
  const made: string[] = [];
  const open: Harness[] = [];

  function tmpRoot(): string {
    const dir = mkdtempSync(join(tmpdir(), 'cost-'));
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

  // A real faux harness over one storage, with one tool-call turn stored.
  async function fauxRun(storage: Storage, registry = createRegistry()) {
    const faux = fauxProvider();
    const models = createModels();
    models.setProvider(faux.provider);
    const harness = await Harness.open(
      storage,
      { models, registry },
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

  it('reads the same totals harness.usage() reports for a faux run', async () => {
    const storage = new MemoryStorage();
    const harness = await fauxRun(storage);
    const expected = await harness.usage(BACKGROUND_CONTEXT);
    const rows = await readSessionUsage(storage, BACKGROUND_CONTEXT);
    const totals = totalSessionUsage(rows);

    // One row per `pi.usage` bucket, and the same numbers in the totals.
    expect(rows.map((row) => `${row.kind}:${row.key}`)).toEqual(
      Object.entries(expected.models).map(([key]) => `model:${key}`),
    );
    const summed = Object.values(expected.models).reduce(
      (acc, usage) => ({
        input: acc.input + usage.input,
        output: acc.output + usage.output,
        cacheRead: acc.cacheRead + usage.cacheRead,
        cacheWrite: acc.cacheWrite + usage.cacheWrite,
        costUsd: acc.costUsd + usage.cost.total,
      }),
      { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, costUsd: 0 },
    );
    expect(totals).toEqual(summed);
    // The faux run really did spend tokens (not a vacuous match).
    expect(totals.input).toBeGreaterThan(0);
    expect(rows[0]?.key).toBe(MODEL_REF);
  });

  it('reports a tool that spends its own tokens as a tool:<name> row', async () => {
    // A tool that reports `usage` on its result lands in `pi.usage.tools`
    // (pi-durable), so the readout must carry it beside the model rows.
    const spend = defineTool({
      name: 'spend',
      description: 'reports its own usage',
      parameters: Type.Object({}),
      execute: async () => ({
        content: [{ type: 'text', text: 'ok' }],
        usage: {
          input: 5,
          output: 2,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 7,
          cost: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            total: 0.0005,
          },
        },
      }),
    });
    const registry = createRegistry();
    registry.install(
      defineExtension({ name: 'spending-tool', tools: [spend] }),
    );
    const storage = new MemoryStorage();
    const faux = fauxProvider();
    const models = createModels();
    models.setProvider(faux.provider);
    const harness = await Harness.open(
      storage,
      { models, registry },
      BACKGROUND_CONTEXT,
    );
    open.push(harness);
    const conversation = await harness.root(BACKGROUND_CONTEXT, {
      agent: { model: { provider: 'faux', modelId: 'faux-1' } },
    });
    faux.setResponses([
      fauxAssistantMessage([fauxToolCall('spend', {})], {
        stopReason: 'toolUse',
      }),
      fauxAssistantMessage('spent'),
    ]);
    await (
      await conversation.submit(
        { type: 'input', content: 'spend something' },
        BACKGROUND_CONTEXT,
      )
    ).wait(BACKGROUND_CONTEXT);

    const expected = await harness.usage(BACKGROUND_CONTEXT);
    expect(Object.keys(expected.tools)).toEqual(['spend']);
    const rows = await readSessionUsage(storage, BACKGROUND_CONTEXT);
    const tool = rows.find((row) => row.kind === 'tool');
    expect(tool?.key).toBe('spend');
    expect(tool?.usage.cost.total).toBeCloseTo(0.0005);
    // The totals include the tool's own spend.
    expect(totalSessionUsage(rows).input).toBe(
      Object.values(expected.models).reduce(
        (acc, usage) => acc + usage.input,
        0,
      ) + 5,
    );
  });

  it('loads one row per usage bucket from a stored session', async () => {
    const root = tmpRoot();
    const store = openSessionStore(root, createNodeFileBridge(root));
    const session = await createSession(
      store,
      { cwd: '/work' },
      BACKGROUND_CONTEXT,
    );
    await fauxRun(session.adopt());
    // The harness closed the storage with it; the lock is still held.
    await session.release(BACKGROUND_CONTEXT);

    const rows = await loadSessionCostRows(root, session.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      agentId: session.id,
      model: MODEL_REF,
    });
    expect(rows[0]?.input).toBeGreaterThan(0);
    expect(rows[0]?.costUsd).toBeGreaterThanOrEqual(0);
    expect(rows[0]?.cacheRead).toBeGreaterThanOrEqual(0);
  });

  it('rolls one orchestrate run up: --session <orch> sums the children (issue #164)', async () => {
    const root = tmpRoot();
    const store = openSessionStore(root, createNodeFileBridge(root));
    const parent = await createSession(
      store,
      { id: 'orch-1', cwd: '/repo' },
      BACKGROUND_CONTEXT,
    );
    await parent.release(BACKGROUND_CONTEXT);
    const childTotals: number[] = [];
    for (const agent of ['aaa', 'bbb']) {
      const worker = await createSession(
        store,
        {
          id: `orch-1-${agent}`,
          cwd: `/repo/.kubic/wt/${agent}`,
          parentSessionId: 'orch-1',
          role: 'implementer',
          agentId: agent,
        },
        BACKGROUND_CONTEXT,
      );
      await fauxRun(worker.adopt());
      await worker.release(BACKGROUND_CONTEXT);
      const readable = await attachSession(
        store,
        `orch-1-${agent}`,
        BACKGROUND_CONTEXT,
      );
      try {
        childTotals.push(
          totalSessionUsage(
            await readSessionUsage(readable.storage, BACKGROUND_CONTEXT),
          ).costUsd,
        );
      } finally {
        await readable.release(BACKGROUND_CONTEXT);
      }
    }
    const rows = await loadSessionCostRows(root, 'orch-1');
    // Per-child rows, keyed by the worker session — never the parent id.
    expect(rows.map((row) => row.agentId).sort()).toEqual([
      'orch-1-aaa',
      'orch-1-bbb',
    ]);
    const expected = (childTotals[0] ?? 0) + (childTotals[1] ?? 0);
    expect(rows.reduce((sum, row) => sum + row.costUsd, 0)).toBeCloseTo(
      expected,
    );
    expect(expected).toBeGreaterThanOrEqual(0);
  });

  it('a live-locked manager still reports its children (review #164)', async () => {
    const root = tmpRoot();
    const store = openSessionStore(root, createNodeFileBridge(root));
    // The manager stays attached: a live run holds the Kubic lock exactly
    // like this, so the old contract would refuse the whole report.
    const parent = await createSession(
      store,
      { id: 'orch-1', cwd: '/repo' },
      BACKGROUND_CONTEXT,
    );
    try {
      for (const agent of ['aaa', 'bbb']) {
        const worker = await createSession(
          store,
          {
            id: `orch-1-${agent}`,
            cwd: `/repo/.kubic/wt/${agent}`,
            parentSessionId: 'orch-1',
            role: 'implementer',
            agentId: agent,
          },
          BACKGROUND_CONTEXT,
        );
        await fauxRun(worker.adopt());
        await worker.release(BACKGROUND_CONTEXT);
      }
      const rows = await loadSessionCostRows(root, 'orch-1');
      expect(rows.map((row) => row.agentId).sort()).toEqual([
        'orch-1-aaa',
        'orch-1-bbb',
      ]);
    } finally {
      await parent.release(BACKGROUND_CONTEXT);
    }
  });

  it('still refuses an unknown explicit --session (exit 1), never a marker row', async () => {
    const root = tmpRoot();
    await expect(loadSessionCostRows(root, 'missing')).rejects.toMatchObject({
      name: 'SessionAttachError',
    });
  });

  it('refuses an explicit --session held live, instead of a zero (locked) row', async () => {
    const root = tmpRoot();
    const store = openSessionStore(root, createNodeFileBridge(root));
    const session = await createSession(
      store,
      { cwd: '/work' },
      BACKGROUND_CONTEXT,
    );
    try {
      await expect(loadSessionCostRows(root, session.id)).rejects.toMatchObject(
        { name: 'SessionLockError' },
      );
    } finally {
      await session.release(BACKGROUND_CONTEXT);
    }
  });

  it('refuses an explicit --session written by Pi 0.87, instead of an (unreadable) row', async () => {
    const root = tmpRoot();
    // Exactly what 0.87's JsonlSessionRepo wrote.
    const dir = join(root, '--work--');
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, '2026-01-01T00-00-00-000Z_legacy-1.jsonl'),
      `${JSON.stringify({
        v: 4,
        kind: 'header',
        id: 'legacy-1',
        storageVersion: 1,
        createdAt: 1_700_000_000_000,
        cwd: '/work',
      })}\n`,
    );
    await expect(loadSessionCostRows(root, 'legacy-1')).rejects.toMatchObject({
      name: 'SessionFormatError',
    });
  });

  it('skips a torn usage bucket instead of dying on it', async () => {
    const storage = new MemoryStorage();
    const harness = await fauxRun(storage);
    // A committed document whose bucket is not an object: the reader must
    // skip it and still report the real rows.
    const conversation = await harness.root(BACKGROUND_CONTEXT);
    await harness.commit(async (tx) => {
      const usage = await tx.doc(UsageDoc, conversation.id);
      (usage.models as Record<string, unknown>)['broken/model'] = null;
    }, BACKGROUND_CONTEXT);
    const rows = await readSessionUsage(storage, BACKGROUND_CONTEXT);
    expect(rows.some((row) => row.key === 'broken/model')).toBe(false);
    expect(rows.some((row) => row.key === `${FAUX_PROVIDER_ID}/faux-1`)).toBe(
      true,
    );
  });

  it('skips a session whose storage a live run owns, without opening it', async () => {
    const root = tmpRoot();
    const store = openSessionStore(root, createNodeFileBridge(root));
    // Still attached: the Kubic lock is held by this live process, exactly
    // as a running `kubic run` holds it.
    const session = await createSession(
      store,
      { cwd: '/work' },
      BACKGROUND_CONTEXT,
    );
    try {
      const rows = await loadSessionCostRows(root);
      expect(rows).toEqual([
        {
          agentId: session.id,
          model: '(locked)',
          costUsd: 0,
          input: 0,
          output: 0,
        },
      ]);
    } finally {
      await session.release(BACKGROUND_CONTEXT);
    }
  });

  it('reads a run envelope usage and the last answering model from the transcript', async () => {
    const root = tmpRoot();
    const store = openSessionStore(root, createNodeFileBridge(root));
    const session = await createSession(
      store,
      { cwd: '/work' },
      BACKGROUND_CONTEXT,
    );
    await fauxRun(session.adopt());
    await session.release(BACKGROUND_CONTEXT);

    const measured = await readSessionRunUsage(root, session.id);
    expect(measured.model).toBe(MODEL_REF);
    expect(measured.usage.toolCalls).toBe(1);
    expect(measured.usage.input).toBeGreaterThan(0);
    expect(measured.usage.costUsd).toBeGreaterThanOrEqual(0);
  });
});

describe('kubic cost lock-free reads (issue #251)', () => {
  const made: string[] = [];
  const open: Harness[] = [];

  function tmpRoot(): string {
    const dir = mkdtempSync(join(tmpdir(), 'cost-251-'));
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
    const code = await runCostCommand(
      {},
      {
        loadRows: () => [
          {
            agentId: 'sess-live',
            model: '(locked)',
            costUsd: 0,
            input: 0,
            output: 0,
          },
        ],
        out: cap.out,
        err: cap.err,
      },
    );
    expect(code).toBe(0);
    expect(cap.lines.join('\n')).toContain('(locked)');
    expect(cap.errs).toEqual([]);
  });
});
