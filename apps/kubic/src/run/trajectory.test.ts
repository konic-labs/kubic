// `--session <id>` resolves to a run's trajectory: export
// and replay read <sessions-root>/<id>/trajectory.json, so the printed ref
// and the session id are both ways back to the record. Faux provider only;
// temp sessions root and workspace.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runExportCommand } from '@kubic/eval/export-cli';
import { NodeExecutionEnv } from '@kubic/exec/env';
import { AUDIT_LEDGER_FILE, auditLedgerDirFor } from '@kubic/host/audit';
import { runReplayCommand } from '@kubic/host/replay';
import { parseTrajectoryExportJSON } from '@kubic/trajectory/schema';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { tempDir } from '../../../../test/temp-dir.js';
import { runHeadlessPrompt } from './command.js';
import {
  persistRunTrajectory,
  resolveSessionTrajectory,
} from './trajectory.js';

beforeEach(() => {
  vi.stubEnv('KUBIC_NO_NOTICE', '1');
  vi.stubEnv('KUBIC_PROVIDER', 'faux');
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('persistRunTrajectory', () => {
  function persist(
    processEnv: NodeJS.ProcessEnv,
    extra: Partial<Parameters<typeof persistRunTrajectory>[0]> = {},
  ) {
    const root = tempDir('traj-persist-root-');
    const cwd = tempDir('traj-persist-cwd-');
    const path = persistRunTrajectory({
      sessionsRoot: root,
      sessionId: 'sess-1',
      agentId: 'root',
      role: 'default',
      prompt: 'hello',
      entries: [],
      cwd,
      skills: [],
      startedAt: 1_000,
      endedAt: 2_000,
      outcome: { terminus: 'completed', summary: 'ok' },
      processEnv,
      pid: 4242,
      ...extra,
    });
    expect(path).toBe(join(root, 'sess-1', 'trajectory.json'));
    return {
      cwd,
      exported: parseTrajectoryExportJSON(readFileSync(path, 'utf8')),
    };
  }

  it('records the identity as the session and agent only', () => {
    const { exported } = persist({});
    expect(Object.keys(exported.identity).sort()).toEqual([
      'agentId',
      'sessionId',
    ]);
    expect(exported.provenance).not.toHaveProperty('generation');
  });

  it('records the injected pid, the thinking level, no-vcs outside git and no model as none/none', () => {
    const { cwd, exported } = persist({ PATH: '/bin' }, { thinking: 'high' });
    expect(exported.provenance.pid).toBe(4242);
    expect(exported.model.thinking).toBe('high');
    expect(exported.provenance.model).toBe('none/none');
    expect(exported.worktree).toEqual({
      path: cwd,
      baseRevision: 'no-vcs',
      branch: null,
    });
    // The used env comes from the given process env, allowlisted.
    expect(exported.environment.env).toEqual({ PATH: '/bin' });
    // No journal or ledger yet: empty, never a failed write.
    expect(exported.diff).toEqual({ filesChanged: [], files: [] });
    expect(exported.approvals).toEqual([]);
  });

  it('carries the lane escalation record into model.escalations', () => {
    const { exported } = persist(
      {},
      {
        escalations: [
          {
            reason: '3 consecutive tool failures',
            at: new Date(1_500).toISOString(),
            fromModel: 'faux/echo',
            toModel: 'faux/big',
            thinking: null,
          },
        ],
      },
    );
    expect(exported.model.escalations).toHaveLength(1);
    expect(exported.model.escalations[0]?.toModel).toBe('faux/big');
  });

  it('records a selected model and defaults thinking to null', () => {
    const { exported } = persist(
      {},
      { model: { provider: 'faux', id: 'echo' } },
    );
    expect(exported.provenance.model).toBe('faux/echo');
    expect(exported.model.thinking).toBeNull();
  });

  it('derives the task identity from the prompt', () => {
    const { exported } = persist({}, { prompt: 'composed prompt' });
    expect(exported.task.taskId).toMatch(/^prompt:/);
    expect(exported.task.objective).toBe('composed prompt');
  });

  it('names an unreadable audit ledger on the warn channel and still writes the trajectory', () => {
    const root = tempDir('traj-persist-root-');
    const cwd = tempDir('traj-persist-cwd-');
    const ledgerDir = auditLedgerDirFor(cwd);
    const ledgerPath = join(ledgerDir, AUDIT_LEDGER_FILE);
    mkdirSync(ledgerDir, { recursive: true });
    // A record of the older format: complete JSON, but no version marker.
    writeFileSync(
      ledgerPath,
      `${JSON.stringify({ who: 'ege', what: 'shell', when: '2026-10-08T00:00:00.000Z', posture: 'approvals', result: 'ok' })}\n`,
    );
    const warnings: string[] = [];
    const path = persistRunTrajectory({
      sessionsRoot: root,
      sessionId: 'sess-1',
      agentId: 'root',
      role: 'default',
      prompt: 'hello',
      entries: [],
      cwd,
      skills: [],
      startedAt: 1_000,
      endedAt: 2_000,
      outcome: { terminus: 'completed', summary: 'ok' },
      processEnv: {},
      pid: 4242,
      warn: (line) => warnings.push(line),
    });
    const exported = parseTrajectoryExportJSON(readFileSync(path, 'utf8'));
    expect(exported.approvals).toEqual([]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain(ledgerPath);
    expect(warnings[0]).toContain('approvals not recorded');
    expect(warnings[0]).toContain(`Move ${ledgerPath} aside`);
  });

  it('names an unreadable journal on the warn channel and still writes the trajectory', () => {
    const root = tempDir('traj-persist-root-');
    const cwd = tempDir('traj-persist-cwd-');
    const journalDir = join(root, 'sess-1', 'journal');
    // A directory where the journal's index file belongs: the journal exists
    // but cannot be read.
    mkdirSync(join(journalDir, 'index.jsonl'), { recursive: true });
    const warnings: string[] = [];
    const path = persistRunTrajectory({
      sessionsRoot: root,
      sessionId: 'sess-1',
      agentId: 'root',
      role: 'default',
      prompt: 'hello',
      entries: [],
      cwd,
      skills: [],
      startedAt: 1_000,
      endedAt: 2_000,
      outcome: { terminus: 'completed', summary: 'ok' },
      processEnv: {},
      pid: 4242,
      warn: (line) => warnings.push(line),
    });
    const exported = parseTrajectoryExportJSON(readFileSync(path, 'utf8'));
    expect(exported.diff.filesChanged).toEqual([]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain(journalDir);
    expect(warnings[0]).toContain('file changes not recorded');
  });

  it('warns about nothing when the run has neither a journal nor a ledger', () => {
    const warnings: string[] = [];
    persist({}, { warn: (line) => warnings.push(line) });
    expect(warnings).toEqual([]);
  });
});

describe('resolveSessionTrajectory', () => {
  it('passes options through untouched without --session', () => {
    expect(resolveSessionTrajectory({ trajectory: 't.json' }, '/root')).toEqual(
      {
        options: { trajectory: 't.json' },
      },
    );
    const jsonOnly: { json: boolean; session?: string; trajectory?: string } = {
      json: true,
    };
    expect(resolveSessionTrajectory(jsonOnly, '/root')).toEqual({
      options: { json: true },
    });
  });

  it('maps --session <id> to <root>/<id>/trajectory.json', () => {
    expect(
      resolveSessionTrajectory({ session: 'abc-1', json: true }, '/root'),
    ).toEqual({
      options: { trajectory: '/root/abc-1/trajectory.json', json: true },
    });
  });

  it('refuses --session together with --trajectory, and a path-unsafe id', () => {
    expect(
      resolveSessionTrajectory({ session: 'a', trajectory: 't.json' }, '/r'),
    ).toEqual({ error: 'use either --trajectory or --session, not both' });
    expect(resolveSessionTrajectory({ session: '../x' }, '/r')).toEqual({
      error: 'invalid --session id "../x" (use [A-Za-z0-9_-])',
    });
  });

  it('export and replay read a run-produced trajectory by session id', async () => {
    const root = tempDir('traj-session-root-');
    const ws = tempDir('traj-session-ws-');
    const run = await runHeadlessPrompt(
      'hello',
      {},
      {
        sessionsRoot: root,
        env: new NodeExecutionEnv(ws),
        modelsCwd: ws,
        warn: () => undefined,
      },
    );
    expect(run.terminus).toBe('completed');

    const exported = resolveSessionTrajectory(
      { session: run.sessionId, type: 'sft' },
      root,
    );
    if (!('options' in exported)) throw new Error(exported.error);
    const exportOut: string[] = [];
    const exportCode = (
      await runExportCommand(exported.options, {
        readFile: (path) => readFileSync(path, 'utf8'),
        out: (line) => exportOut.push(line),
        err: () => undefined,
      })
    ).exitCode;
    expect(exportCode).toBe(0);
    expect(JSON.parse(exportOut.join('\n'))).toMatchObject({ schema: 'sft/1' });

    const replayed = resolveSessionTrajectory(
      { session: run.sessionId, tier: 'recorded', json: true },
      root,
    );
    if (!('options' in replayed)) throw new Error(replayed.error);
    const replayOut: string[] = [];
    const replayCode = (
      await runReplayCommand(replayed.options, {
        out: (line) => replayOut.push(line),
        err: () => undefined,
        run: async () => {
          throw new Error('recorded tier never re-executes');
        },
      })
    ).exitCode;
    expect(replayCode).toBe(0);
    expect(JSON.parse(replayOut.join('\n'))).toMatchObject({
      ok: true,
      tier: 'recorded',
      trajectory: join(root, run.sessionId, 'trajectory.json'),
    });
  });
});
