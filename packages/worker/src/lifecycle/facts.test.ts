// Worker tool facts (issue #464): the line protocol a worker reports its
// tool calls on, the scanner that follows a capped stream, and the batcher
// that bounds the event rate.
import { describe, expect, it } from 'vitest';
import type { WorkerToolActivity } from '../../../core/src/presentation.js';
import {
  batchFacts,
  createFactScanner,
  FACT_DIFF_MAX_CHARS,
  FACT_PREFIX,
  factLine,
  parseFactLine,
  stripFactLines,
} from './facts.js';

const fact = (id: string, at = 1): WorkerToolActivity => ({
  id,
  tool: 'bash',
  target: 'npm test',
  state: 'running',
  at,
});

describe('worker fact lines (issue #464)', () => {
  it('round-trips a fact as one line', () => {
    const full: WorkerToolActivity = {
      id: 'c1',
      tool: 'edit',
      target: 'src/cart.js',
      state: 'done',
      outcome: '+2 −1',
      diff: { text: '-12 a\n+12 b\n+13 c', firstChangedLine: 12 },
      at: 5,
    };
    const line = factLine(full);
    expect(line.startsWith(`${FACT_PREFIX} `)).toBe(true);
    expect(line).not.toContain('\n');
    expect(parseFactLine(line)).toEqual(full);
  });

  it('bounds what crosses', () => {
    const line = factLine({
      ...fact('c1'),
      target: 'x'.repeat(5000),
      diff: { text: 'd'.repeat(FACT_DIFF_MAX_CHARS * 2) },
    });
    const parsed = parseFactLine(line);
    expect(parsed?.target?.length).toBeLessThanOrEqual(200);
    expect(parsed?.diff?.text.length).toBe(FACT_DIFF_MAX_CHARS);
  });

  it('refuses anything but a well-formed fact', () => {
    const json = (value: unknown): string =>
      `${FACT_PREFIX} ${JSON.stringify(value)}`;
    expect(parseFactLine('hello')).toBeUndefined();
    expect(parseFactLine(`${FACT_PREFIX} {nope`)).toBeUndefined();
    expect(parseFactLine(json([1]))).toBeUndefined();
    expect(parseFactLine(json({ ...fact('c1'), args: 'raw' }))).toBeUndefined();
    expect(
      parseFactLine(json({ ...fact('c1'), state: 'maybe' })),
    ).toBeUndefined();
    expect(parseFactLine(json({ ...fact('c1'), at: 'now' }))).toBeUndefined();
    expect(parseFactLine(json({ ...fact('c1'), id: '' }))).toBeUndefined();
    expect(
      parseFactLine(json({ ...fact('c1'), target: 'x'.repeat(201) })),
    ).toBeUndefined();
    expect(
      parseFactLine(json({ ...fact('c1'), diff: { text: 'x', extra: 1 } })),
    ).toBeUndefined();
  });

  it('strips fact lines and nothing else', () => {
    const report = '{"status":"completed"}';
    const text = [
      'KUBIC_WORKER_READY w1',
      factLine(fact('c1')),
      factLine(fact('c2')),
      report,
    ].join('\n');
    expect(stripFactLines(text)).toBe(`KUBIC_WORKER_READY w1\n${report}`);
    expect(stripFactLines(report)).toBe(report);
  });
});

describe('the fact scanner (issue #464)', () => {
  it('reads each complete line once across growing snapshots', () => {
    const seen: string[] = [];
    const scan = createFactScanner((f) => seen.push(f.id));
    const one = factLine(fact('c1'));
    const two = factLine(fact('c2'));
    let stream = `KUBIC_WORKER_READY w\n${one.slice(0, 20)}`;
    scan(stream);
    expect(seen).toEqual([]);
    stream += `${one.slice(20)}\n`;
    scan(stream);
    scan(stream);
    expect(seen).toEqual(['c1']);
    stream += `${two}\nnoise\n`;
    scan(stream);
    expect(seen).toEqual(['c1', 'c2']);
  });

  it('follows a capped stream by its dropped count', () => {
    const seen: string[] = [];
    const scan = createFactScanner((f) => seen.push(f.id));
    const lines = Array.from({ length: 6 }, (_, i) => factLine(fact(`c${i}`)));
    const all = `${lines.join('\n')}\n`;
    // The accumulator keeps the last 2.5 lines' worth, head moving.
    const keep = Math.floor((lines[0]?.length ?? 0) * 2.5);
    const cut = (end: number): [string, number] => {
      const dropped = Math.max(0, end - keep);
      return [all.slice(dropped, end), dropped];
    };
    const ends = [1, 2, 3, 4, 5, 6].map((n) =>
      lines.slice(0, n).reduce((sum, line) => sum + line.length + 1, 0),
    );
    for (const end of ends) scan(...cut(end));
    expect(seen).toEqual(['c0', 'c1', 'c2', 'c3', 'c4', 'c5']);
  });

  it('resumes at the next whole line when a trim cut unread output', () => {
    const seen: string[] = [];
    const scan = createFactScanner((f) => seen.push(f.id));
    const lines = [
      factLine(fact('c0')),
      factLine(fact('c1')),
      factLine(fact('c2')),
    ];
    const all = `${lines.join('\n')}\n`;
    // Nothing read yet, and the head was trimmed mid-way through c0.
    scan(all.slice(10), 10);
    expect(seen).toEqual(['c1', 'c2']);
  });
});

describe('fact batching (issue #464)', () => {
  function timers() {
    let next: (() => void) | undefined;
    return {
      setTimer: (run: () => void) => {
        next = run;
        return 1;
      },
      clearTimer: () => {
        next = undefined;
      },
      tick: () => {
        const run = next;
        next = undefined;
        run?.();
      },
      armed: () => next !== undefined,
    };
  }

  it('sends the first fact at once and batches the rest per interval', () => {
    const t = timers();
    const batches: string[][] = [];
    const batcher = batchFacts(
      (facts) => batches.push(facts.map((f) => f.id)),
      t,
    );
    batcher.push(fact('a'));
    expect(batches).toEqual([['a']]);
    for (const id of ['b', 'c', 'd']) batcher.push(fact(id));
    expect(batches).toEqual([['a']]);
    t.tick();
    expect(batches).toEqual([['a'], ['b', 'c', 'd']]);
    // A quiet interval closes the window: the next fact goes out at once.
    t.tick();
    expect(t.armed()).toBe(false);
    batcher.push(fact('e'));
    expect(batches).toEqual([['a'], ['b', 'c', 'd'], ['e']]);
  });

  it('a flush delivers what is pending now', () => {
    const t = timers();
    const batches: string[][] = [];
    const batcher = batchFacts(
      (facts) => batches.push(facts.map((f) => f.id)),
      t,
    );
    batcher.push(fact('a'));
    batcher.push(fact('b'));
    batcher.flush();
    expect(batches).toEqual([['a'], ['b']]);
    expect(t.armed()).toBe(false);
    batcher.flush();
    expect(batches).toEqual([['a'], ['b']]);
  });

  it('never delivers more than once per interval under a flood', () => {
    let now = 0;
    const scheduled: Array<{ at: number; run: () => void }> = [];
    const deliveries: number[] = [];
    const batcher = batchFacts(() => deliveries.push(now), {
      intervalMs: 100,
      setTimer: (run, ms) => {
        const entry = { at: now + ms, run };
        scheduled.push(entry);
        return entry;
      },
      clearTimer: (entry) => {
        const at = scheduled.indexOf(entry as (typeof scheduled)[number]);
        if (at !== -1) scheduled.splice(at, 1);
      },
    });
    for (now = 0; now < 1000; now += 5) {
      for (const entry of scheduled.filter((e) => e.at <= now)) {
        scheduled.splice(scheduled.indexOf(entry), 1);
        entry.run();
      }
      batcher.push(fact(`f${now}`, now));
    }
    expect(deliveries.length).toBeLessThanOrEqual(11);
    for (let i = 1; i < deliveries.length; i += 1) {
      expect(
        (deliveries[i] ?? 0) - (deliveries[i - 1] ?? 0),
      ).toBeGreaterThanOrEqual(100);
    }
  });
});
