// `kubic replay` at declared determinism tiers (issue #52; §47, §47.1,
// §72, §78). Faux-only: the re-execution runner is injected (zero
// network); trajectory fixtures are built with the versioned #51
// exporter so tests always run against the current stable contract.
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildTrajectoryExport } from '../../../trajectory/src/export.js';
import type { TrajectoryExport } from '../../../trajectory/src/schema.js';
import {
  runReplayCommand,
  type ReplayCommandDeps,
  type ReplayRunResult,
} from './replay.js';

function tmpRoot(): string {
  return mkdtempSync(join(tmpdir(), 'replay-'));
}

function out(): { lines: string[]; write: (line: string) => void } {
  const lines: string[] = [];
  return { lines, write: (line: string) => lines.push(line) };
}

export function fixtureTrajectory(
  overrides: Partial<TrajectoryExport> = {},
): TrajectoryExport {
  const base = buildTrajectoryExport({
    task: { taskId: 'task-1', objective: 'Fix the widget', role: 'writer' },
    identity: { sessionId: 'sess-1', agentId: 'agent-1', workerId: null },
    model: { provider: 'acme', model: 'm1', thinking: null, escalations: [] },
    prompt: { text: 'Fix the widget', constraints: [] },
    resources: { skills: [], promptTemplates: [] },
    transfer: null,
    actions: [
      { seq: 1, tool: 'read', args: { path: 'a.ts' } },
      { seq: 2, tool: 'edit', args: { path: 'a.ts' } },
    ],
    observations: [{ seq: 1, actionSeq: 1, output: 'hello' }],
    state: { phase: 'done', snapshot: null },
    provenance: {
      sessionId: 'sess-1',
      agentId: 'agent-1',
      pid: null,
      generation: 1,
      worktree: '/repo/.kubic/wt/agent-1',
      model: 'acme/m1',
    },
    environment: {
      capturedFrom: 'used',
      cwd: '/repo/.kubic/wt/agent-1',
      env: {},
    },
    worktree: {
      path: '/repo/.kubic/wt/agent-1',
      baseRevision: 'abc123',
      branch: null,
    },
    diff: {
      filesChanged: ['a.ts'],
      files: [{ path: 'a.ts', hunks: ['@@ -1 +1 @@'] }],
    },
    approvals: [],
    timestamps: {
      startedAt: '2026-09-23T10:00:00.000Z',
      endedAt: '2026-09-23T10:01:00.000Z',
    },
    usage: {
      inputTokens: 10,
      outputTokens: 5,
      cachedTokens: 0,
      requests: 1,
      costUsd: 0.01,
      byModel: {},
    },
    result: {
      status: 'completed',
      summary: 'done',
      failureCategory: null,
      error: null,
    },
  });
  return { ...base, ...overrides };
}

function writeTrajectory(dir: string, name: string): string {
  const path = join(dir, name);
  writeFileSync(path, JSON.stringify(fixtureTrajectory()));
  return path;
}

function deps(
  o: { lines: string[]; write: (line: string) => void },
  run?: ReplayCommandDeps['run'],
): ReplayCommandDeps {
  const calls: unknown[] = [];
  return {
    out: o.write,
    calls,
    run:
      run ??
      (async (): Promise<ReplayRunResult> => {
        throw new Error('runner must not be called');
      }),
  } as ReplayCommandDeps;
}

describe('replay recorded exact (§47 exact; §47.1 Recorded)', () => {
  it('replays a versioned trajectory log-only: exit 0, tier printed, runner never called', async () => {
    const dir = tmpRoot();
    const path = writeTrajectory(dir, 't.json');
    const o = out();
    let called = false;
    const exit = await runReplayCommand([path], {
      out: o.write,
      run: async () => {
        called = true;
        return { terminus: 'completed', summary: 'must not run' };
      },
    });
    expect(exit).toBe(0);
    expect(called).toBe(false);
    const text = o.lines.join('\n');
    expect(text).toMatch(/tier: recorded/);
    expect(text).toMatch(/acme\/m1/);
    expect(text).toMatch(/result: completed/);
  });

  it('publishes the tier in the --json envelope (§72)', async () => {
    const dir = tmpRoot();
    const path = writeTrajectory(dir, 't.json');
    const o = out();
    const exit = await runReplayCommand([path, '--json'], deps(o));
    expect(exit).toBe(0);
    const envelope = JSON.parse(o.lines.join('\n')) as {
      ok: boolean;
      exitCode: number;
      tier: string;
      invocation: string;
    };
    expect(envelope.ok).toBe(true);
    expect(envelope.exitCode).toBe(0);
    expect(envelope.tier).toBe('recorded');
    expect(envelope.invocation).toBe('exact');
  });

  it('exits 5 with a machine-readable code when the trajectory file is missing', async () => {
    const o = out();
    const exit = await runReplayCommand(
      [join(tmpRoot(), 'nope.json'), '--json'],
      deps(o),
    );
    expect(exit).toBe(5);
    const envelope = JSON.parse(o.lines.join('\n')) as {
      error: { code: string };
    };
    expect(envelope.error.code).toBe('trajectory-unreadable');
  });

  it('exits 2 when the trajectory is malformed', async () => {
    const dir = tmpRoot();
    const path = join(dir, 'bad.json');
    writeFileSync(path, '{not json');
    const o = out();
    const exit = await runReplayCommand([path, '--json'], deps(o));
    expect(exit).toBe(2);
    const envelope = JSON.parse(o.lines.join('\n')) as {
      error: { code: string };
    };
    expect(envelope.error.code).toBe('trajectory-malformed');
  });
});
