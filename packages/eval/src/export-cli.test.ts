// `kubic export` command surface (issue #78): trajectory-export
// inspection plus RL dataset export over trajectory files. RED first.
import { describe, expect, it } from 'vitest';
import type { TrajectoryExport } from '../../trajectory/src/schema.js';
import { type ExportCommandOptions, runExportCommand } from './export-cli.js';
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

// stdout (`lines`) and stderr (`errs`) captured separately.
function out(): {
  lines: string[];
  errs: string[];
  write: (line: string) => void;
  err: (line: string) => void;
} {
  const lines: string[] = [];
  const errs: string[] = [];
  return {
    lines,
    errs,
    write: (line: string) => lines.push(line),
    err: (line: string) => errs.push(line),
  };
}

describe('export command (issue #78)', () => {
  it('describes a trajectory export without --type: exit 0 with provenance', async () => {
    const o = out();
    const exit = await runExportCommand(
      { trajectory: 't.json' },
      {
        readFile: files({ 't.json': passing() }),
        out: o.write,
        err: o.err,
      },
    );
    expect(exit).toBe(0);
    const text = o.lines.join('\n');
    expect(text).toMatch(/provenance/);
    expect(text).toMatch(/generation=3/);
    expect(text).toMatch(/completed/);
  });

  it('emits a jq-able --json describe envelope', async () => {
    const o = out();
    const exit = await runExportCommand(
      { trajectory: 't.json', json: true },
      {
        readFile: files({ 't.json': passing() }),
        out: o.write,
        err: o.err,
      },
    );
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
      { trajectory: 't.json', type: 'sft' },
      { readFile: files({ 't.json': passing() }), out: o.write, err: o.err },
    );
    expect(exit).toBe(0);
    const record = JSON.parse(o.lines.join('\n')) as { schema: string };
    expect(record.schema).toBe('sft/1');
  });

  it('exports tool-use and coding records', async () => {
    for (const [type, schema] of [
      ['tooluse', 'tool-use/1'],
      ['coding', 'coding/1'],
    ]) {
      const o = out();
      const exit = await runExportCommand(
        { trajectory: 't.json', type: type },
        { readFile: files({ 't.json': passing() }), out: o.write, err: o.err },
      );
      expect(exit).toBe(0);
      const record = JSON.parse(o.lines.join('\n')) as { schema: string };
      expect(record.schema).toBe(schema);
    }
  });

  it('exports a DPO record from --trajectory (chosen) + --against (rejected)', async () => {
    const o = out();
    const exit = await runExportCommand(
      { trajectory: 'chosen.json', type: 'dpo', against: 'rej.json' },
      {
        readFile: files({ 'chosen.json': passing(), 'rej.json': failing() }),
        out: o.write,
        err: o.err,
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
      {
        trajectory: 'chosen.json',
        type: 'preference',
        against: 'rej.json',
        json: true,
      },
      {
        readFile: files({ 'chosen.json': passing(), 'rej.json': envFail }),
        out: o.write,
        err: o.err,
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

  it('--type dpo over mismatched prompts prints the exclusion, exit 0, no record (#269)', async () => {
    const o = out();
    const exit = await runExportCommand(
      { trajectory: 'chosen.json', type: 'dpo', against: 'rej.json' },
      {
        readFile: files({
          'chosen.json': passing({ promptText: 'task A' }),
          'rej.json': failing({ promptText: 'task B' }),
        }),
        out: o.write,
        err: o.err,
      },
    );
    expect(exit).toBe(0);
    expect(o.lines).toHaveLength(1);
    expect(o.lines[0]).toMatch(/^excluded: prompt-mismatch-excluded — /);
    expect(o.lines.join('\n')).not.toMatch(/dpo\/1/);
  });

  it('--type grpo over mismatched prompts is refused with exit 2 (#269)', async () => {
    const o = out();
    const exit = await runExportCommand(
      { trajectory: 'a.json', type: 'grpo', against: 'b.json' },
      {
        readFile: files({
          'a.json': passing({ promptText: 'task A' }),
          'b.json': failing({ promptText: 'task B' }),
        }),
        out: o.write,
        err: o.err,
      },
    );
    expect(exit).toBe(2);
    expect(o.lines).toEqual([]);
    expect(o.errs.join('\n')).toMatch(/different prompt or task/);
  });

  it('exports a 2-candidate GRPO group from --trajectory + --against', async () => {
    const o = out();
    const exit = await runExportCommand(
      { trajectory: 'a.json', type: 'grpo', against: 'b.json' },
      {
        readFile: files({ 'a.json': passing(), 'b.json': failing() }),
        out: o.write,
        err: o.err,
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
      { trajectory: 't.json', type: 'sft', json: true },
      { readFile: files({ 't.json': stripped }), out: o.write, err: o.err },
    );
    expect(exit).toBe(2);
    const envelope = JSON.parse(o.lines.join('\n')) as {
      ok: boolean;
      exitCode: number;
    };
    expect(envelope.ok).toBe(false);
    expect(envelope.exitCode).toBe(2);
    expect(envelope).not.toHaveProperty('record');
    expect(o.lines.join('\n')).not.toMatch(/"schema":\s*"sft\/1"/);
  });

  // Argv syntax (an unknown flag, a missing value, the required
  // --trajectory under commander, --help) is pinned in
  // apps/kubic/src/commands/analysis.test.ts; the semantic refusals are
  // this handler's, on stderr — even under --json no envelope is printed
  // for a bad invocation, and no file is read.
  it('exits 2 on missing --trajectory, unknown --type, missing --against, and stray --against', async () => {
    const cases: [ExportCommandOptions, string][] = [
      [
        { type: 'sft' },
        "error: required option '--trajectory <file>' not specified",
      ],
      [
        { trajectory: 't.json', type: 'bogus' },
        'error: unknown --type (want sft|dpo|grpo|preference|tooluse|coding)',
      ],
      [
        { trajectory: 't.json', type: 'dpo' },
        'error: --type dpo needs --against <other.json>',
      ],
      [
        { trajectory: 't.json', type: 'grpo', json: true },
        'error: --type grpo needs --against <other.json>',
      ],
      [
        { trajectory: 't.json', type: 'sft', against: 'b.json' },
        'error: --against applies only to --type dpo|grpo|preference',
      ],
      [
        { trajectory: 't.json', against: 'b.json' },
        'error: --against applies only to --type dpo|grpo|preference',
      ],
    ];
    for (const [options, message] of cases) {
      const o = out();
      const exit = await runExportCommand(options, {
        readFile: () => {
          throw new Error('a refused invocation must not read files');
        },
        out: o.write,
        err: o.err,
      });
      const label = JSON.stringify(options);
      expect(exit, label).toBe(2);
      expect(o.lines, label).toEqual([]);
      expect(o.errs, label).toEqual([message]);
    }
  });

  it('exits 2 on unreadable and malformed trajectory files', async () => {
    const missing = out();
    expect(
      await runExportCommand(
        { trajectory: 'nope.json' },
        {
          readFile: files({}),
          out: missing.write,
          err: missing.err,
        },
      ),
    ).toBe(2);
    const malformed = out();
    expect(
      await runExportCommand(
        { trajectory: 'bad.json' },
        {
          readFile: () => '{not json',
          out: malformed.write,
          err: malformed.err,
        },
      ),
    ).toBe(2);
    expect(missing.lines).toEqual([]);
    expect(missing.errs).toHaveLength(1);
    expect(missing.errs[0]).toMatch(
      /^error: \[trajectory-unreadable\] cannot read trajectory "nope\.json"/,
    );
    expect(malformed.lines).toEqual([]);
    expect(malformed.errs[0]).toMatch(/^error: \[/);
  });
});
