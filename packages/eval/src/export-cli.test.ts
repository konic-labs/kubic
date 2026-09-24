// `kubic export` command surface (issue #78): trajectory-export
// inspection plus RL dataset export over trajectory files. RED first.
import { describe, expect, it } from 'vitest';
import type { TrajectoryExport } from '../../trajectory/src/schema.js';
import { runExportCommand } from './export-cli.js';
import { makeExport } from './rl/fixtures.js';

function passing(overrides: Parameters<typeof makeExport>[0] = {}) {
  return makeExport({
    evalLabels: { 'signal:tests': 'pass' },
    summary: 'fixed cleanly',
    ...overrides,
  });
}

function failing(overrides: Parameters<typeof makeExport>[0] = {}) {
  return makeExport({
    status: 'failed',
    failureCategory: 'model_failed',
    summary: 'broken attempt',
    ...overrides,
  });
}

function files(
  entries: Record<string, TrajectoryExport>,
): (path: string) => string {
  const store = new Map(
    Object.entries(entries).map(([name, exp]) => [name, JSON.stringify(exp)]),
  );
  return (path: string): string => {
    const raw = store.get(path);
    if (raw === undefined) throw new Error(`ENOENT: ${path}`);
    return raw;
  };
}

function out(): { lines: string[]; write: (line: string) => void } {
  const lines: string[] = [];
  return { lines, write: (line: string) => lines.push(line) };
}

describe('export command (issue #78)', () => {
  it('describes a trajectory export without --type: exit 0 with provenance', async () => {
    const o = out();
    const exit = await runExportCommand(['--trajectory', 't.json'], {
      readFile: files({ 't.json': passing() }),
      out: o.write,
    });
    expect(exit).toBe(0);
    const text = o.lines.join('\n');
    expect(text).toMatch(/provenance/);
    expect(text).toMatch(/generation=3/);
    expect(text).toMatch(/completed/);
  });

  it('emits a jq-able --json describe envelope', async () => {
    const o = out();
    const exit = await runExportCommand(['--trajectory', 't.json', '--json'], {
      readFile: files({ 't.json': passing() }),
      out: o.write,
    });
    expect(exit).toBe(0);
    const envelope = JSON.parse(o.lines.join('\n')) as {
      ok: boolean;
      exitCode: number;
      trajectory: { schema: string; provenance: { gen: number } };
    };
    expect(envelope.ok).toBe(true);
    expect(envelope.exitCode).toBe(0);
    expect(envelope.trajectory.schema).toBe('1.0');
    expect(envelope.trajectory.provenance.gen).toBe(3);
  });

  it('exports an SFT record: exit 0, schema sft/1', async () => {
    const o = out();
    const exit = await runExportCommand(
      ['--trajectory', 't.json', '--type', 'sft'],
      { readFile: files({ 't.json': passing() }), out: o.write },
    );
    expect(exit).toBe(0);
    const record = JSON.parse(o.lines.join('\n')) as { schema: string };
    expect(record.schema).toBe('sft/1');
  });

  it('exports tool-use and coding records', async () => {
    for (const type of ['tooluse', 'coding']) {
      const o = out();
      const exit = await runExportCommand(
        ['--trajectory', 't.json', '--type', type],
        { readFile: files({ 't.json': passing() }), out: o.write },
      );
      expect(exit).toBe(0);
      const record = JSON.parse(o.lines.join('\n')) as { schema: string };
      expect(record.schema).toMatch(/1$/);
    }
  });

  it('exports a DPO record from --trajectory (chosen) + --against (rejected)', async () => {
    const o = out();
    const exit = await runExportCommand(
      ['--trajectory', 'chosen.json', '--type', 'dpo', '--against', 'rej.json'],
      {
        readFile: files({ 'chosen.json': passing(), 'rej.json': failing() }),
        out: o.write,
      },
    );
    expect(exit).toBe(0);
    const record = JSON.parse(o.lines.join('\n')) as { schema: string };
    expect(record.schema).toBe('dpo/1');
  });

  it('reports an excluded pair (env failure) as excluded, exit 0, never a record', async () => {
    const envFail = makeExport({
      status: 'failed',
      failureCategory: 'tool_failed',
      summary: 'tool exploded',
    });
    const o = out();
    const exit = await runExportCommand(
      [
        '--trajectory',
        'chosen.json',
        '--type',
        'preference',
        '--against',
        'rej.json',
        '--json',
      ],
      {
        readFile: files({ 'chosen.json': passing(), 'rej.json': envFail }),
        out: o.write,
      },
    );
    expect(exit).toBe(0);
    const envelope = JSON.parse(o.lines.join('\n')) as {
      ok: boolean;
      excluded: { tag: string };
      record?: unknown;
    };
    expect(envelope.ok).toBe(true);
    expect(envelope.record).toBeUndefined();
    expect(envelope.excluded.tag).toBe('env-failure-excluded');
  });

  it('exports a 2-candidate GRPO group from --trajectory + --against', async () => {
    const o = out();
    const exit = await runExportCommand(
      ['--trajectory', 'a.json', '--type', 'grpo', '--against', 'b.json'],
      {
        readFile: files({ 'a.json': passing(), 'b.json': failing() }),
        out: o.write,
      },
    );
    expect(exit).toBe(0);
    const record = JSON.parse(o.lines.join('\n')) as {
      schema: string;
      candidates: unknown[];
    };
    expect(record.schema).toBe('grpo/1');
    expect(record.candidates).toHaveLength(2);
  });

  it('refuses stripped provenance (exit 2), never an emitted record', async () => {
    const stripped = passing();
    stripped.worktree.baseRevision = '';
    const o = out();
    const exit = await runExportCommand(
      ['--trajectory', 't.json', '--type', 'sft', '--json'],
      { readFile: files({ 't.json': stripped }), out: o.write },
    );
    expect(exit).toBe(2);
    const envelope = JSON.parse(o.lines.join('\n')) as {
      ok: boolean;
      exitCode: number;
    };
    expect(envelope.ok).toBe(false);
    expect(envelope.exitCode).toBe(2);
  });

  it('exits 2 on missing --trajectory, unknown --type, missing --against, and stray --against', async () => {
    for (const args of [
      ['--type', 'sft'],
      ['--trajectory', 't.json', '--type', 'bogus'],
      ['--trajectory', 't.json', '--type', 'dpo'],
      ['--trajectory', 't.json', '--type', 'grpo'],
      ['--trajectory', 't.json', '--type', 'sft', '--against', 'b.json'],
      ['--trajectory', 't.json', '--bogus'],
    ]) {
      const o = out();
      const exit = await runExportCommand(args, {
        readFile: files({ 't.json': passing(), 'b.json': failing() }),
        out: o.write,
      });
      expect(exit, JSON.stringify(args)).toBe(2);
      expect(o.lines.join('\n')).toMatch(/usage|error/i);
    }
  });

  it('exits 2 on unreadable and malformed trajectory files', async () => {
    const missing = out();
    expect(
      await runExportCommand(['--trajectory', 'nope.json'], {
        readFile: files({}),
        out: missing.write,
      }),
    ).toBe(2);
    const malformed = out();
    expect(
      await runExportCommand(['--trajectory', 'bad.json'], {
        readFile: () => '{not json',
        out: malformed.write,
      }),
    ).toBe(2);
  });
});
