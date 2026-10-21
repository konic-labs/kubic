// RL dataset batch export. A directory/glob of
// trajectory exports in, one JSONL of dataset records plus a manifest out.
// The in-memory fs keeps the tests hermetic (no temp dirs, no network) and
// lets the streaming claim be observed directly: one append per record.
import { describe, expect, it } from 'vitest';
import { makeExport } from '../test-support/fixtures.js';
import {
  type DatasetDirEntry,
  DatasetError,
  type DatasetFs,
  type DatasetManifest,
  exportDataset,
  resolveDatasetFiles,
} from './dataset.js';

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

function envFailure(overrides: Parameters<typeof makeExport>[0] = {}) {
  return makeExport({
    status: 'failed',
    failureCategory: 'tool_failed',
    summary: 'tool exploded',
    ...overrides,
  });
}

interface MemoryFs {
  fs: DatasetFs;
  written: Record<string, string>;
  appended: string[];
  lines: () => string[];
  manifest: () => DatasetManifest;
}

function memoryFs(files: Record<string, string>): MemoryFs {
  const written: Record<string, string> = {};
  const appended: string[] = [];
  const dirs = new Map<string, DatasetDirEntry[]>();
  for (const path of Object.keys(files)) {
    const slash = path.lastIndexOf('/');
    const dir = slash === -1 ? '.' : path.slice(0, slash);
    const name = slash === -1 ? path : path.slice(slash + 1);
    const list = dirs.get(dir) ?? [];
    list.push({ name, isDirectory: false });
    dirs.set(dir, list);
  }
  return {
    fs: {
      listDir: (path: string): DatasetDirEntry[] => {
        const list = dirs.get(path === '' ? '.' : path);
        if (list === undefined) throw new Error(`ENOENT: ${path}`);
        return list;
      },
      readFile: (path: string): string => {
        const content = files[path];
        if (content === undefined) throw new Error(`ENOENT: ${path}`);
        return content;
      },
      writeFile: (path: string, content: string): void => {
        written[path] = content;
      },
      appendFile: (path: string, content: string): void => {
        appended.push(content);
        written[path] = (written[path] ?? '') + content;
      },
    },
    written,
    appended,
    lines: () =>
      (written['out.jsonl'] ?? '').split('\n').filter((line) => line !== ''),
    manifest: () =>
      JSON.parse(
        written['out.jsonl.manifest.json'] as string,
      ) as DatasetManifest,
  };
}

describe('resolveDatasetFiles', () => {
  const entries = {
    'traj/a.json': '{}',
    'traj/b.json': '{}',
    'traj/notes.txt': '',
    'other/c.json': '{}',
  };

  it('resolves a directory to its .json files, sorted', () => {
    const { fs } = memoryFs(entries);
    expect(resolveDatasetFiles('traj', fs)).toEqual([
      'traj/a.json',
      'traj/b.json',
    ]);
    expect(resolveDatasetFiles('traj/', fs)).toEqual([
      'traj/a.json',
      'traj/b.json',
    ]);
  });

  it('resolves a basename glob, sorted, ignoring non-matching names', () => {
    const { fs } = memoryFs(entries);
    expect(resolveDatasetFiles('traj/*.json', fs)).toEqual([
      'traj/a.json',
      'traj/b.json',
    ]);
    expect(resolveDatasetFiles('traj/?.json', fs)).toEqual([
      'traj/a.json',
      'traj/b.json',
    ]);
    // Glob characters are only special in the basename: a directory glob
    // is not expanded, and a non-matching basename resolves to nothing.
    expect(resolveDatasetFiles('traj/[ab].json', fs)).toEqual([]);
    expect(resolveDatasetFiles('traj/a.json', fs)).toEqual(['traj/a.json']);
  });
});

describe('exportDataset', () => {
  it('turns 4 fixtures (2 tasks × pass/fail) into exactly 2 DPO lines, excluded=0', () => {
    const m = memoryFs({
      'traj/t1-pass.json': JSON.stringify(passing({ taskId: 'task-1' })),
      'traj/t1-fail.json': JSON.stringify(failing({ taskId: 'task-1' })),
      'traj/t2-pass.json': JSON.stringify(passing({ taskId: 'task-2' })),
      'traj/t2-fail.json': JSON.stringify(failing({ taskId: 'task-2' })),
    });
    const manifest = exportDataset({
      type: 'dpo',
      dataset: 'traj',
      out: 'out.jsonl',
      fs: m.fs,
    });
    expect(manifest.records).toBe(2);
    expect(manifest.files).toBe(4);
    expect(manifest.excluded).toEqual({});
    expect(manifest.exclusions).toEqual([]);
    expect(manifest.schema).toBe('dataset/1');
    expect(m.lines()).toHaveLength(2);
    for (const line of m.lines()) {
      expect(JSON.parse(line).schema).toBe('dpo/1');
    }
    // Streaming: one append per record, each a single JSONL line.
    expect(m.appended).toHaveLength(2);
    for (const chunk of m.appended) {
      expect(chunk.endsWith('\n')).toBe(true);
      expect(chunk.trimEnd()).not.toContain('\n');
    }
  });

  it('counts an env-failure trajectory under env-failure-excluded', () => {
    const m = memoryFs({
      'traj/pass.json': JSON.stringify(passing({ taskId: 'task-1' })),
      'traj/env.json': JSON.stringify(envFailure({ taskId: 'task-1' })),
    });
    const manifest = exportDataset({
      type: 'preference',
      dataset: 'traj',
      out: 'out.jsonl',
      fs: m.fs,
    });
    expect(manifest.records).toBe(0);
    expect(manifest.excluded['env-failure-excluded']).toBe(1);
    expect(manifest.exclusions[0]?.tag).toBe('env-failure-excluded');
    expect(manifest.exclusions[0]?.file).toBe('traj/pass.json');
  });

  it('builds a GRPO group with more than two candidates', () => {
    const m = memoryFs({
      'traj/a.json': JSON.stringify(passing({ taskId: 'task-1' })),
      'traj/b.json': JSON.stringify(failing({ taskId: 'task-1' })),
      'traj/c.json': JSON.stringify(passing({ taskId: 'task-1' })),
    });
    const manifest = exportDataset({
      type: 'grpo',
      dataset: 'traj',
      out: 'out.jsonl',
      fs: m.fs,
    });
    expect(manifest.records).toBe(1);
    const group = JSON.parse(m.lines()[0] as string) as {
      schema: string;
      candidates: unknown[];
    };
    expect(group.schema).toBe('grpo/1');
    expect(group.candidates).toHaveLength(3);
  });

  it('never mixes prompts: the same task id with another prompt is its own group', () => {
    const m = memoryFs({
      'traj/a.json': JSON.stringify(passing({ promptText: 'prompt A' })),
      'traj/b.json': JSON.stringify(failing({ promptText: 'prompt A' })),
      'traj/c.json': JSON.stringify(passing({ promptText: 'prompt B' })),
      'traj/d.json': JSON.stringify(failing({ promptText: 'prompt B' })),
    });
    const manifest = exportDataset({
      type: 'dpo',
      dataset: 'traj',
      out: 'out.jsonl',
      fs: m.fs,
    });
    expect(manifest.records).toBe(2);
    expect(manifest.excluded).toEqual({});
  });

  it('counts a task with no counterpart instead of emitting nothing silently', () => {
    const m = memoryFs({
      'traj/a.json': JSON.stringify(passing({ taskId: 'task-1' })),
      'traj/b.json': JSON.stringify(passing({ taskId: 'task-1' })),
    });
    const manifest = exportDataset({
      type: 'dpo',
      dataset: 'traj',
      out: 'out.jsonl',
      fs: m.fs,
    });
    expect(manifest.records).toBe(0);
    expect(manifest.excluded['no-counterpart-excluded']).toBe(1);
    expect(manifest.exclusions[0]).toMatchObject({
      tag: 'no-counterpart-excluded',
      file: 'traj/a.json',
    });
    expect(manifest.exclusions[0]?.reason).toMatch(/2 passing and 0 failing/);
  });

  it('counts a GRPO group with fewer than two candidates as singleton-excluded', () => {
    const m = memoryFs({
      'traj/a.json': JSON.stringify(passing({ taskId: 'task-1' })),
    });
    const manifest = exportDataset({
      type: 'grpo',
      dataset: 'traj',
      out: 'out.jsonl',
      fs: m.fs,
    });
    expect(manifest.records).toBe(0);
    expect(manifest.excluded['singleton-excluded']).toBe(1);
    expect(manifest.exclusions[0]).toMatchObject({
      tag: 'singleton-excluded',
      file: 'traj/a.json',
    });
    expect(manifest.exclusions[0]?.reason).toMatch(/1 candidate\(s\)/);
  });

  it('writes the manifest with counts, provenance summary and schema version', () => {
    const m = memoryFs({
      'traj/a.json': JSON.stringify(passing({ taskId: 'task-1' })),
      'traj/b.json': JSON.stringify(failing({ taskId: 'task-1' })),
    });
    const manifest = exportDataset({
      type: 'dpo',
      dataset: 'traj',
      out: 'out.jsonl',
      fs: m.fs,
    });
    expect(manifest.manifest).toBe('out.jsonl.manifest.json');
    expect(m.manifest()).toEqual(manifest);
    expect(manifest.provenance).toEqual({
      sessions: ['sess-1'],
      worktrees: ['/wt/agent-1'],
      models: ['acme/m1'],
    });
  });

  it('exports one record per trajectory for the single-record types', () => {
    const m = memoryFs({
      'traj/a.json': JSON.stringify(passing()),
      'traj/b.json': JSON.stringify(failing()),
    });
    const manifest = exportDataset({
      type: 'sft',
      dataset: 'traj/*.json',
      out: 'out.jsonl',
      fs: m.fs,
    });
    expect(manifest.records).toBe(2);
    expect(m.appended).toHaveLength(2);
    for (const line of m.lines()) {
      expect(JSON.parse(line).schema).toBe('sft/1');
    }
  });

  it('redacts secrets a tool read in every batch record', () => {
    const exported = {
      ...passing(),
      actions: [{ seq: 1, tool: 'read', args: { path: '.netrc' } }],
      observations: [
        {
          seq: 2,
          actionSeq: 1,
          output:
            'machine api login me password hunter2-value AKIAABCDEFGHIJKLMNOP',
          truncated: false,
          bytesOriginal: 64,
        },
      ],
    };
    const m = memoryFs({ 'traj/a.json': JSON.stringify(exported) });
    exportDataset({
      type: 'tooluse',
      dataset: 'traj/*.json',
      out: 'out.jsonl',
      fs: m.fs,
    });
    const [line] = m.lines();
    expect(line).toContain('[REDACTED]');
    expect(line).not.toContain('hunter2-value');
    expect(line).not.toContain('AKIAABCDEFGHIJKLMNOP');
  });

  it('refuses a malformed trajectory by name (exit 1)', () => {
    const m = memoryFs({ 'traj/bad.json': '{not json' });
    try {
      exportDataset({
        type: 'sft',
        dataset: 'traj',
        out: 'out.jsonl',
        fs: m.fs,
      });
      throw new Error('dataset accepted a malformed trajectory');
    } catch (error) {
      expect(error).toBeInstanceOf(DatasetError);
      expect((error as DatasetError).code).toBe('dataset-invalid');
      expect((error as DatasetError).exitCode).toBe(1);
      expect((error as DatasetError).message).toMatch(/traj\/bad\.json/);
    }
  });

  it('refuses an empty match by name (exit 2)', () => {
    const m = memoryFs({ 'traj/notes.txt': '' });
    try {
      exportDataset({
        type: 'sft',
        dataset: 'traj',
        out: 'out.jsonl',
        fs: m.fs,
      });
      throw new Error('dataset accepted an empty input set');
    } catch (error) {
      expect(error).toBeInstanceOf(DatasetError);
      expect((error as DatasetError).code).toBe('dataset-empty');
      expect((error as DatasetError).exitCode).toBe(2);
    }
  });
});
