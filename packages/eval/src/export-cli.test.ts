// `kubic export` command surface: trajectory-export
// inspection plus RL dataset export over trajectory files.
import { describe, expect, it, vi } from 'vitest';
import type { TrajectoryExport } from '../../trajectory/src/schema.js';
import {
  EXPORT_EXIT_FAILED,
  EXPORT_EXIT_OK,
  EXPORT_EXIT_USAGE,
  type ExportCommandOptions,
  runExportCommand,
} from './export-cli.js';
import { makeExport } from './rl/fixtures.js';

// One controllable failure seam: the export-failed mapping
// needs a builder that throws something the handler does not recognise.
// Null by default, so every other test drives the real builders.
const injected = vi.hoisted(() => ({ error: null as unknown }));
vi.mock('./rl/sft.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./rl/sft.js')>();
  return {
    ...actual,
    buildSftRecord: (exported: Parameters<typeof actual.buildSftRecord>[0]) => {
      if (injected.error !== null) throw injected.error;
      return actual.buildSftRecord(exported);
    },
  };
});

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

describe('export command', () => {
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

  it('wraps an exported dataset record in the --json envelope', async () => {
    const o = out();
    const exit = await runExportCommand(
      { trajectory: 't.json', type: 'sft', json: true },
      { readFile: files({ 't.json': passing() }), out: o.write, err: o.err },
    );
    expect(exit).toBe(EXPORT_EXIT_OK);
    expect(o.errs).toEqual([]);
    expect(o.lines).toHaveLength(1);
    const envelope = JSON.parse(o.lines.join('\n')) as {
      ok: boolean;
      exitCode: number;
      type: string;
      record: { schema: string };
    };
    expect(envelope.ok).toBe(true);
    expect(envelope.exitCode).toBe(EXPORT_EXIT_OK);
    expect(envelope.type).toBe('sft');
    expect(envelope.record.schema).toBe('sft/1');
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

  it('exports a preference pair from --trajectory (chosen) + --against (rejected)', async () => {
    const o = out();
    const exit = await runExportCommand(
      {
        trajectory: 'chosen.json',
        type: 'preference',
        against: 'rej.json',
        json: true,
      },
      {
        readFile: files({ 'chosen.json': passing(), 'rej.json': failing() }),
        out: o.write,
        err: o.err,
      },
    );
    expect(exit).toBe(EXPORT_EXIT_OK);
    expect(o.errs).toEqual([]);
    const envelope = JSON.parse(o.lines.join('\n')) as {
      ok: boolean;
      type: string;
      record: { schema: string };
    };
    expect(envelope.ok).toBe(true);
    expect(envelope.type).toBe('preference');
    expect(envelope.record.schema).toBe('pair/1');
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

  it('--type dpo over mismatched prompts prints the exclusion, exit 0, no record', async () => {
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

  it('--type grpo over mismatched prompts is refused with exit 2', async () => {
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

  it('refuses stripped provenance with rl-refused (exit 2), never an emitted record', async () => {
    const stripped = passing();
    stripped.worktree.baseRevision = '';
    const o = out();
    const exit = await runExportCommand(
      { trajectory: 't.json', type: 'sft', json: true },
      { readFile: files({ 't.json': stripped }), out: o.write, err: o.err },
    );
    expect(exit).toBe(EXPORT_EXIT_USAGE);
    const envelope = JSON.parse(o.lines.join('\n')) as {
      ok: boolean;
      exitCode: number;
      error: { code: string; message: string };
    };
    expect(envelope.ok).toBe(false);
    expect(envelope.exitCode).toBe(EXPORT_EXIT_USAGE);
    expect(envelope.error).toEqual({
      code: 'rl-refused',
      message: 'provenance.base is required: record the base revision',
    });
    expect(envelope).not.toHaveProperty('record');
    expect(o.lines.join('\n')).not.toMatch(/"schema":\s*"sft\/1"/);
    const text = out();
    expect(
      await runExportCommand(
        { trajectory: 't.json', type: 'sft' },
        {
          readFile: files({ 't.json': stripped }),
          out: text.write,
          err: text.err,
        },
      ),
    ).toBe(EXPORT_EXIT_USAGE);
    expect(text.lines).toEqual([]);
    expect(text.errs).toEqual([
      'error: [rl-refused] provenance.base is required: record the base revision',
    ]);
  });

  it('maps a record validation failure to invalid-record (exit 1), printing no partial record', async () => {
    // A changed path that is not a usable ref: the coding record builds,
    // then its own validator refuses it.
    const broken = passing();
    broken.diff = { filesChanged: [''], files: [] };
    const message =
      'record failed validation: diffRefs must be an array of changed paths';
    const json = out();
    const exit = await runExportCommand(
      { trajectory: 't.json', type: 'coding', json: true },
      { readFile: files({ 't.json': broken }), out: json.write, err: json.err },
    );
    expect(exit).toBe(EXPORT_EXIT_FAILED);
    expect(json.errs).toEqual([]);
    expect(json.lines).toHaveLength(1);
    expect(JSON.parse(json.lines.join('\n'))).toEqual({
      ok: false,
      exitCode: EXPORT_EXIT_FAILED,
      error: { code: 'invalid-record', message },
    });
    expect(json.lines.join('\n')).not.toMatch(/"schema":\s*"coding\/1"/);
    const text = out();
    expect(
      await runExportCommand(
        { trajectory: 't.json', type: 'coding' },
        {
          readFile: files({ 't.json': broken }),
          out: text.write,
          err: text.err,
        },
      ),
    ).toBe(EXPORT_EXIT_FAILED);
    expect(text.lines).toEqual([]);
    expect(text.errs).toEqual([`error: [invalid-record] ${message}`]);
  });

  it('maps an unexpected throw to export-failed (exit 1), printing no partial record', async () => {
    injected.error = new TypeError('builder exploded');
    try {
      const json = out();
      const exit = await runExportCommand(
        { trajectory: 't.json', type: 'sft', json: true },
        {
          readFile: files({ 't.json': passing() }),
          out: json.write,
          err: json.err,
        },
      );
      expect(exit).toBe(EXPORT_EXIT_FAILED);
      expect(json.errs).toEqual([]);
      expect(json.lines).toHaveLength(1);
      expect(JSON.parse(json.lines.join('\n'))).toEqual({
        ok: false,
        exitCode: EXPORT_EXIT_FAILED,
        error: { code: 'export-failed', message: 'builder exploded' },
      });
      expect(json.lines.join('\n')).not.toMatch(/"schema":\s*"sft\/1"/);
      const text = out();
      expect(
        await runExportCommand(
          { trajectory: 't.json', type: 'sft' },
          {
            readFile: files({ 't.json': passing() }),
            out: text.write,
            err: text.err,
          },
        ),
      ).toBe(EXPORT_EXIT_FAILED);
      expect(text.lines).toEqual([]);
      expect(text.errs).toEqual(['error: builder exploded']);
    } finally {
      injected.error = null;
    }
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

describe('export --dataset', () => {
  // The batch mode's filesystem seam over an in-memory store: listing
  // resolves the operand, the JSONL is appended line by line.
  function datasetDeps(store: Record<string, string>) {
    const written: Record<string, string> = {};
    return {
      written,
      deps: {
        readFile: (path: string): string => {
          const content = store[path];
          if (content === undefined) throw new Error(`ENOENT: ${path}`);
          return content;
        },
        listDir: (path: string) =>
          path === 'traj'
            ? Object.keys(store)
                .filter((key) => key.startsWith('traj/'))
                .map((key) => ({
                  name: key.slice('traj/'.length),
                  isDirectory: false,
                }))
            : (() => {
                throw new Error(`ENOENT: ${path}`);
              })(),
        writeFile: (path: string, content: string): void => {
          written[path] = content;
        },
        appendFile: (path: string, content: string): void => {
          written[path] = (written[path] ?? '') + content;
        },
      },
    };
  }

  it('refuses --dataset without --type/--out, or combined with --trajectory/--against', async () => {
    const cases: Array<[ExportCommandOptions, string]> = [
      [
        { dataset: 'traj', out: 'out.jsonl' },
        '--dataset needs --type (sft|dpo|grpo|preference|tooluse|coding)',
      ],
      [{ dataset: 'traj', type: 'sft' }, '--dataset needs --out <file.jsonl>'],
      [
        {
          dataset: 'traj',
          type: 'sft',
          out: 'out.jsonl',
          trajectory: 't.json',
        },
        '--dataset takes a directory or glob — --trajectory belongs to single-file mode',
      ],
      [
        { dataset: 'traj', type: 'sft', out: 'out.jsonl', against: 'b.json' },
        '--dataset takes a directory or glob — --against belongs to single-file mode',
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
      expect(o.errs, label).toEqual([`error: ${message}`]);
    }
  });

  it('refuses dataset mode without the filesystem deps by name', async () => {
    const o = out();
    const exit = await runExportCommand(
      { dataset: 'traj', type: 'sft', out: 'out.jsonl', json: true },
      { readFile: () => '', out: o.write, err: o.err },
    );
    expect(exit).toBe(2);
    const envelope = JSON.parse(o.lines.join('\n')) as {
      ok: boolean;
      exitCode: number;
      error: { code: string; message: string };
    };
    expect(envelope.ok).toBe(false);
    expect(envelope.exitCode).toBe(2);
    expect(envelope.error.code).toBe('dataset-unsupported');
  });

  it('streams the dataset into the JSONL and prints the manifest path', async () => {
    const { deps, written } = datasetDeps({
      'traj/a.json': JSON.stringify(passing({ taskId: 'task-1' })),
      'traj/b.json': JSON.stringify(failing({ taskId: 'task-1' })),
    });
    const o = out();
    const exit = await runExportCommand(
      { dataset: 'traj', type: 'dpo', out: 'out.jsonl' },
      { ...deps, out: o.write, err: o.err },
    );
    expect(exit).toBe(0);
    expect(o.errs).toEqual([]);
    expect(o.lines).toEqual([
      'dataset: 1 record(s) from 2 file(s), 0 excluded, manifest: out.jsonl.manifest.json',
    ]);
    expect((written['out.jsonl'] ?? '').trimEnd().split('\n')).toHaveLength(1);
    const manifest = JSON.parse(
      written['out.jsonl.manifest.json'] as string,
    ) as {
      schema: string;
      records: number;
      files: number;
      excluded: Record<string, number>;
    };
    expect(manifest.schema).toBe('dataset/1');
    expect(manifest.records).toBe(1);
    expect(manifest.files).toBe(2);
    expect(manifest.excluded).toEqual({});
  });

  it('maps an unexpected write failure to export-failed (exit 1, envelope)', async () => {
    const { deps } = datasetDeps({
      'traj/a.json': JSON.stringify(passing({ taskId: 'task-1' })),
    });
    const o = out();
    const exit = await runExportCommand(
      { dataset: 'traj', type: 'sft', out: 'out.jsonl', json: true },
      {
        ...deps,
        appendFile: () => {
          throw new Error('ENOSPC: no space left on device');
        },
        out: o.write,
        err: o.err,
      },
    );
    expect(exit).toBe(1);
    expect(o.errs).toEqual([]);
    expect(JSON.parse(o.lines.join('\n'))).toEqual({
      ok: false,
      exitCode: 1,
      error: {
        code: 'export-failed',
        message: 'ENOSPC: no space left on device',
      },
    });
  });

  it('emits the manifest in the --json envelope', async () => {
    const { deps } = datasetDeps({
      'traj/a.json': JSON.stringify(passing({ taskId: 'task-1' })),
      'traj/b.json': JSON.stringify(envFailureFixture()),
    });
    const o = out();
    const exit = await runExportCommand(
      { dataset: 'traj', type: 'preference', out: 'out.jsonl', json: true },
      { ...deps, out: o.write, err: o.err },
    );
    expect(exit).toBe(0);
    const envelope = JSON.parse(o.lines.join('\n')) as {
      ok: boolean;
      exitCode: number;
      type: string;
      out: string;
      manifest: {
        records: number;
        excluded: Record<string, number>;
        provenance: { sessions: string[] };
      };
    };
    expect(envelope.ok).toBe(true);
    expect(envelope.exitCode).toBe(0);
    expect(envelope.type).toBe('preference');
    expect(envelope.out).toBe('out.jsonl');
    expect(envelope.manifest.records).toBe(0);
    expect(envelope.manifest.excluded).toEqual({ 'env-failure-excluded': 1 });
    expect(envelope.manifest.provenance.sessions).toEqual(['sess-1']);
  });
});

function envFailureFixture(): TrajectoryExport {
  return makeExport({
    status: 'failed',
    failureCategory: 'tool_failed',
    summary: 'tool exploded',
  });
}
