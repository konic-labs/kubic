// `kubic cost` CLI tests (issue #79; §62). RED first: cost-cli.ts lands
// after this file. Faux-only, zero network — rows are injected.
import { describe, expect, it } from 'vitest';
import { REDACTED_SECRET } from '../../policy/secret-shapes.js';
import { runCostCommand } from './cost-cli.js';
import {
  formatAgentCostRow,
  summarizePerAgentCost,
  toCostJson,
} from './per-agent-cost.js';

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

function capture() {
  const lines: string[] = [];
  return {
    lines,
    out: (line: string): void => {
      lines.push(line);
    },
  };
}

describe('kubic cost text view (issue #79)', () => {
  it('prints one row per agent plus the task total', async () => {
    const cap = capture();
    const code = await runCostCommand([], {
      loadRows: () => ROWS,
      out: cap.out,
    });
    expect(code).toBe(0);
    const first = ROWS[0];
    const second = ROWS[1];
    if (first === undefined || second === undefined) {
      throw new Error('missing fixture agent');
    }
    expect(cap.lines).toContain(formatAgentCostRow(first));
    expect(cap.lines).toContain(formatAgentCostRow(second));
    const total = cap.lines.find((line) => line.startsWith('task total'));
    expect(total).toMatch(/0\.50/);
    expect(total).toMatch(/2 agents/);
  });

  it('reports no cost rows on an empty rollup', async () => {
    const cap = capture();
    const code = await runCostCommand([], {
      loadRows: () => [],
      out: cap.out,
    });
    expect(code).toBe(0);
    expect(cap.lines).toEqual(['no cost rows']);
  });
});

describe('kubic cost --json (issue #79)', () => {
  it('matches the in-code toCostJson shape field-for-field', async () => {
    const cap = capture();
    const code = await runCostCommand(['--json'], {
      loadRows: () => ROWS,
      out: cap.out,
    });
    expect(code).toBe(0);
    expect(cap.lines).toHaveLength(1);
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
    await runCostCommand(['--json'], {
      loadRows: () => ROWS,
      out: cap.out,
    });
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
  it('exits 2 on an unknown flag', async () => {
    const cap = capture();
    const code = await runCostCommand(['--bogus'], {
      loadRows: () => ROWS,
      out: cap.out,
    });
    expect(code).toBe(2);
    expect(cap.lines[0]).toMatch(/^usage: kubic cost/);
  });

  it('exits 2 when --session has no value', async () => {
    const cap = capture();
    const code = await runCostCommand(['--session'], {
      loadRows: () => ROWS,
      out: cap.out,
    });
    expect(code).toBe(2);
  });

  it('exits 2 on an invalid session id before any store is touched', async () => {
    let touched = false;
    const cap = capture();
    const code = await runCostCommand(['--session', '../evil'], {
      loadRows: () => {
        touched = true;
        return ROWS;
      },
      out: cap.out,
    });
    expect(code).toBe(2);
    expect(touched).toBe(false);
  });

  it('forwards the session id to the loader', async () => {
    let seen: string | undefined;
    const cap = capture();
    const code = await runCostCommand(['--session', 'sess-1'], {
      loadRows: (sessionId) => {
        seen = sessionId;
        return ROWS;
      },
      out: cap.out,
    });
    expect(code).toBe(0);
    expect(seen).toBe('sess-1');
  });

  it('exits 1 when the session is unknown', async () => {
    const cap = capture();
    const code = await runCostCommand(['--session', 'missing'], {
      loadRows: () => {
        const error = new Error('unknown session: missing');
        error.name = 'SessionAttachError';
        throw error;
      },
      out: cap.out,
    });
    expect(code).toBe(1);
    expect(cap.lines[0]).toMatch(/unknown session/);
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
    const code = await runCostCommand([], {
      loadRows: () => CACHED_ROWS,
      out: cap.out,
    });
    expect(code).toBe(0);
    const text = cap.lines.join('\n');
    // 1 of 2 sessions had a cache read > 0: a real measurement over the
    // rows the loader returned, never an invented number.
    expect(text).toMatch(/cache: 1\/2 sessions with prefix hits/);
    expect(text).toMatch(/50%/);
  });

  it('states that caching is transparent on the same readout', async () => {
    const cap = capture();
    await runCostCommand([], { loadRows: () => CACHED_ROWS, out: cap.out });
    expect(cap.lines.join('\n')).toMatch(/caching is transparent/);
  });

  it('keeps the --json top-level shape field-for-field and adds cache per row', async () => {
    const cap = capture();
    const code = await runCostCommand(['--json'], {
      loadRows: () => CACHED_ROWS,
      out: cap.out,
    });
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
    await runCostCommand([], { loadRows: () => ROWS, out: cap.out });
    expect(cap.lines.join('\n')).not.toMatch(/prefix hits/);
  });
});

describe('kubic cost secret backstop (issue #79 fix cycle 1)', () => {
  // Passes SESSION_ID_PATTERN ([A-Za-z0-9_-]) yet matches the sk secret
  // shape: the unknown-session echo must not carry it.
  const SHAPED_SESSION = 'SK-FAUX-TEST-KEY-0001';

  it('redacts a secret-shaped session id in the unknown-session error', async () => {
    const cap = capture();
    const code = await runCostCommand(['--session', SHAPED_SESSION], {
      loadRows: () => {
        const error = new Error(`unknown session: ${SHAPED_SESSION}`);
        error.name = 'SessionAttachError';
        throw error;
      },
      out: cap.out,
    });
    expect(code).toBe(1);
    const text = cap.lines.join('\n');
    expect(text).not.toContain(SHAPED_SESSION);
    expect(text).toContain(REDACTED_SECRET);
  });

  it('redacts secret-shaped material in store error messages', async () => {
    const cap = capture();
    const code = await runCostCommand([], {
      loadRows: () => {
        throw new Error(`store boom ${SHAPED_SESSION}`);
      },
      out: cap.out,
    });
    expect(code).toBe(1);
    const text = cap.lines.join('\n');
    expect(text).not.toContain(SHAPED_SESSION);
    expect(text).toContain(REDACTED_SECRET);
  });

  it('redacts secret-shaped material in the invalid-session-id echo', async () => {
    // A bearer-shaped value carries a space, so it fails the id pattern
    // and lands in the invalid-id echo — which must not carry it.
    const shaped = 'Bearer abcdefghij1234567890';
    const cap = capture();
    const code = await runCostCommand(['--session', shaped], {
      loadRows: () => ROWS,
      out: cap.out,
    });
    expect(code).toBe(2);
    const text = cap.lines.join('\n');
    expect(text).not.toContain(shaped);
    expect(text).toContain(REDACTED_SECRET);
  });
});
