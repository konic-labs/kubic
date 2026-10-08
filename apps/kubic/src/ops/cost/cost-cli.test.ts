// `kubic cost` CLI tests. Cost-cli.ts lands
// after this file. Faux-only, zero network — rows are injected.
import {
  appendFileSync,
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
import {
  EXIT_FAILED,
  EXIT_OK,
  EXIT_USAGE,
} from '../../../../../packages/core/src/cli/exit-codes.js';
import { REDACTED_SECRET } from '../../../../../packages/core/src/secret-shapes.js';
import { createNodeFileBridge } from '../../../../../packages/exec/src/file-bridge.js';
import { FAUX_PROVIDER_ID } from '../../../../../packages/host/src/faux-provider.js';
import {
  loadSessionCostRows,
  readSessionRunUsage,
  readSessionUsage,
  runCostCommand,
  totalSessionUsage,
} from '../../../../../packages/host/src/ops/cost/cost-cli.js';
import {
  summarizeSessionCost,
  toCostJson,
} from '../../../../../packages/host/src/ops/cost/session-cost.js';
import {
  attachSession,
  createSession,
  openSessionStore,
} from '../../../../../packages/worker/src/lane/session-store.js';
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
} from '../../../../../packages/worker/src/pi-boundary.js';

const attached = vi.hoisted(() => ({
  calls: [] as Array<readonly unknown[]>,
  // Scripted `sessionLockIsLive` answers, consumed in order
  // (a mid-read-liveness test scripts [undefined, live]). Empty means
  // passthrough to the real probe, so every other test is unaffected.
  lockScript: [] as Array<{ pid: number; startedAt?: number } | undefined>,
}));

vi.mock(
  '../../../../../packages/worker/src/lane/session-store.js',
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import('../../../../../packages/worker/src/lane/session-store.js')
      >();
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
  },
);

const ROWS = [
  {
    session: 'sess-1',
    model: 'cheap/small',
    costUsd: 0.2,
    input: 100,
    output: 50,
  },
  {
    session: 'sess-2',
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

describe('kubic cost text view', () => {
  it('prints one row per session plus the task total', async () => {
    const cap = capture();
    const code = (
      await runCostCommand(
        {},
        {
          loadRows: () => ROWS,
          out: cap.out,
          err: cap.err,
        },
      )
    ).exitCode;
    expect(code).toBe(EXIT_OK);
    // One plain (uncoloured, unboxed) table, then the task total: the group
    // column names the session, and the in/out/cache counters sit apart at
    // sub-cent precision.
    expect(cap.lines[0]).toBe(
      [
        'SESSION  MODEL         IN  OUT  CACHE-R  CACHE-W     COST',
        'sess-1   cheap/small  100   50        0        0  $0.2000',
        'sess-2   pro/large    200   60        0        0  $0.3000',
      ].join('\n'),
    );
    expect(cap.lines[1]).toBe('task total $0.5000 (2 sessions)');
    expect(cap.errs).toEqual([]);
  });

  it('counts a session with two buckets once in the total and the cache line', async () => {
    const cap = capture();
    const code = (
      await runCostCommand(
        {},
        {
          loadRows: () => [
            {
              session: 'sess-1',
              model: 'cheap/small',
              costUsd: 0.2,
              input: 100,
              output: 50,
              cacheRead: 100,
              cacheWrite: 0,
            },
            {
              session: 'sess-1',
              model: 'tool:bash',
              costUsd: 0.3,
              input: 0,
              output: 0,
              cacheRead: 0,
              cacheWrite: 0,
            },
          ],
          out: cap.out,
          err: cap.err,
        },
      )
    ).exitCode;
    expect(code).toBe(EXIT_OK);
    const text = cap.lines.join('\n');
    expect(text).toContain('task total $0.5000 (1 session)');
    expect(text).toContain('cache: 1/1 session with prefix hits');
    expect(text).not.toContain('sessions');
  });

  it('draws the kit table only when fancy', async () => {
    const cap = capture();
    await runCostCommand(
      {},
      { loadRows: () => ROWS, out: cap.out, err: cap.err, fancy: true },
    );
    expect(cap.lines.join('\n')).toMatch(/\n─+\n/);
    expect(cap.lines.join('\n')).not.toContain('┌');
    expect(cap.lines[0]).toContain('SESSION');
    expect(cap.lines.join('\n')).toContain('sess-2');
  });

  it('reports no cost rows on an empty rollup', async () => {
    const cap = capture();
    const code = (
      await runCostCommand(
        {},
        {
          loadRows: () => [],
          out: cap.out,
          err: cap.err,
        },
      )
    ).exitCode;
    expect(code).toBe(EXIT_OK);
    expect(cap.lines).toEqual(['no cost rows']);
  });
});

describe('kubic cost --json', () => {
  it('matches the in-code toCostJson shape field-for-field', async () => {
    const cap = capture();
    const code = (
      await runCostCommand(
        { json: true },
        {
          loadRows: () => ROWS,
          out: cap.out,
          err: cap.err,
        },
      )
    ).exitCode;
    expect(code).toBe(EXIT_OK);
    expect(cap.lines).toHaveLength(1);
    expect(cap.errs).toEqual([]);
    const head = cap.lines[0];
    if (head === undefined) throw new Error('missing cost --json line');
    const parsed: unknown = JSON.parse(head);
    const expected = toCostJson(summarizeSessionCost(ROWS));
    expect(parsed).toEqual(expected);
    expect(Object.keys(parsed as Record<string, unknown>).sort()).toEqual([
      'rows',
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
      rows: Array<{ costUsd: number }>;
      taskTotal: number;
    };
    const parts = parsed.rows.reduce((acc, row) => acc + row.costUsd, 0);
    expect(parts).toBeCloseTo(parsed.taskTotal);
  });
});

describe('kubic cost usage', () => {
  // Argv syntax (unknown flags, a missing --session value, --help) is
  // commander's: apps/kubic/src/commands/analysis.test.ts pins it.
  it('exits 2 on an invalid session id before any store is touched', async () => {
    let touched = false;
    const cap = capture();
    const code = (
      await runCostCommand(
        { session: '../evil' },
        {
          loadRows: () => {
            touched = true;
            return ROWS;
          },
          out: cap.out,
          err: cap.err,
        },
      )
    ).exitCode;
    expect(code).toBe(EXIT_USAGE);
    expect(touched).toBe(false);
    expect(cap.lines).toEqual([]);
    expect(cap.errs).toEqual([
      'error: invalid --session id "../evil" (use [A-Za-z0-9_-])',
    ]);
  });

  it('forwards the session id to the loader', async () => {
    let seen: string | undefined;
    const cap = capture();
    const code = (
      await runCostCommand(
        { session: 'sess-1' },
        {
          loadRows: (sessionId) => {
            seen = sessionId;
            return ROWS;
          },
          out: cap.out,
          err: cap.err,
        },
      )
    ).exitCode;
    expect(code).toBe(EXIT_OK);
    expect(seen).toBe('sess-1');
  });

  it('exits 1 when the session is unknown', async () => {
    const cap = capture();
    const code = (
      await runCostCommand(
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
      )
    ).exitCode;
    expect(code).toBe(EXIT_FAILED);
    expect(cap.lines).toEqual([]);
    expect(cap.errs).toEqual(['error: unknown session: missing']);
  });
});

describe('kubic cost cache aggregation', () => {
  const CACHED_ROWS = [
    {
      session: 'sess-hit',
      model: 'aggregate',
      costUsd: 0.4,
      input: 100,
      output: 20,
      cacheRead: 900,
      cacheWrite: 0,
    },
    {
      session: 'sess-miss',
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
    const code = (
      await runCostCommand(
        {},
        {
          loadRows: () => CACHED_ROWS,
          out: cap.out,
          err: cap.err,
        },
      )
    ).exitCode;
    expect(code).toBe(EXIT_OK);
    const text = [...cap.lines, ...cap.errs].join('\n');
    // 1 of 2 sessions had a cache read > 0: a real measurement over the
    // rows the loader returned, never an invented number. The unit follows
    // the grouping level (per session by default).
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
    const code = (
      await runCostCommand(
        { json: true },
        {
          loadRows: () => CACHED_ROWS,
          out: cap.out,
          err: cap.err,
        },
      )
    ).exitCode;
    expect(code).toBe(EXIT_OK);
    const head = cap.lines[0];
    if (head === undefined) throw new Error('missing cost --json line');
    const parsed = JSON.parse(head) as {
      rows: Array<Record<string, unknown>>;
      taskTotal: number;
    };
    // The documented top-level shape is untouched.
    expect(Object.keys(parsed).sort()).toEqual(['rows', 'taskTotal']);
    // The new aggregation is additive: inside the existing per-row entries.
    expect(parsed.rows[0]?.cacheRead).toBe(900);
    expect(parsed.rows[1]?.cacheWrite).toBe(500);
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

describe('kubic cost secret backstop', () => {
  // Passes SESSION_ID_PATTERN ([A-Za-z0-9_-]) yet matches the sk secret
  // shape: the unknown-session echo must not carry it.
  const SHAPED_SESSION = 'SK-FAUX-TEST-KEY-0001';

  it('redacts a secret-shaped session id in the unknown-session error', async () => {
    const cap = capture();
    const code = (
      await runCostCommand(
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
      )
    ).exitCode;
    expect(code).toBe(EXIT_FAILED);
    const text = [...cap.lines, ...cap.errs].join('\n');
    expect(text).not.toContain(SHAPED_SESSION);
    expect(text).toContain(REDACTED_SECRET);
  });

  it('redacts secret-shaped material in store error messages', async () => {
    const cap = capture();
    const code = (
      await runCostCommand(
        {},
        {
          loadRows: () => {
            throw new Error(`store boom ${SHAPED_SESSION}`);
          },
          out: cap.out,
          err: cap.err,
        },
      )
    ).exitCode;
    expect(code).toBe(EXIT_FAILED);
    const text = [...cap.lines, ...cap.errs].join('\n');
    expect(text).not.toContain(SHAPED_SESSION);
    expect(text).toContain(REDACTED_SECRET);
  });

  it('redacts secret-shaped material in the invalid-session-id echo', async () => {
    // A bearer-shaped value carries a space, so it fails the id pattern
    // and lands in the invalid-id echo — which must not carry it.
    const shaped = 'Bearer abcdefghij1234567890';
    const cap = capture();
    const code = (
      await runCostCommand(
        { session: shaped },
        {
          loadRows: () => ROWS,
          out: cap.out,
          err: cap.err,
        },
      )
    ).exitCode;
    expect(code).toBe(EXIT_USAGE);
    const text = [...cap.lines, ...cap.errs].join('\n');
    expect(text).not.toContain(shaped);
    expect(text).toContain(REDACTED_SECRET);
  });
});

describe('kubic cost durable usage', () => {
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
      session: session.id,
      model: MODEL_REF,
    });
    expect(rows[0]?.input).toBeGreaterThan(0);
    expect(rows[0]?.costUsd).toBeGreaterThanOrEqual(0);
    expect(rows[0]?.cacheRead).toBeGreaterThanOrEqual(0);
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

  it('refuses an explicit --session that has no session storage as unknown', async () => {
    const root = tmpRoot();
    const dir = join(root, '--work--');
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, '2026-01-01T00-00-00-000Z_stray-1.jsonl'),
      `${JSON.stringify({ v: 4, kind: 'header', id: 'stray-1', cwd: '/work' })}\n`,
    );
    await expect(loadSessionCostRows(root, 'stray-1')).rejects.toMatchObject({
      name: 'SessionAttachError',
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
      // Marker rows carry the same locating identity as real
      // rows (the session that could not be read, and its project).
      expect(rows).toEqual([
        {
          session: session.id,
          project: '/work',
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
