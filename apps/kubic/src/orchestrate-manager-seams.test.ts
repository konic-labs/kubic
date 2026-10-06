// The manager lane's prod seams (issue #431): what the composition root
// hands the router — the model catalog + resolved manager model, the
// manager session attach, the ask seat, and read-only git inspection.
// Faux-free and network-free: the catalog assembles from a temp cwd (no
// models.json, no grants), git inspects a temp non-repo (named refusal,
// never raw), sessions live under a temp root cleaned in afterEach.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WorkerRegistry } from '../../../packages/worker/src/lifecycle/registry.js';
import { BACKGROUND_CONTEXT } from '../../../packages/worker/src/pi-boundary.js';
import { orchestrateDepsWithDefaults } from './orchestrate-run.js';

const scratchDirs: string[] = [];

function scratchRoot(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  scratchDirs.push(dir);
  return dir;
}

function fakeSignals() {
  return {
    install: () => () => undefined,
    reraise: () => undefined,
  };
}

afterEach(() => {
  vi.unstubAllEnvs();
  for (const dir of scratchDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

async function prodDeps(
  options: { model?: { provider: string; id: string } } = {},
) {
  const root = scratchRoot('kubic-mgr-seams-');
  const sessionsRoot = join(root, 'sessions');
  const debugLines: string[] = [];
  const deps = await orchestrateDepsWithDefaults({
    out: () => undefined,
    err: () => undefined,
    debug: (line) => debugLines.push(line),
    cwd: root,
    sessionsRoot,
    registry: new WorkerRegistry(),
    signals: fakeSignals(),
    ...(options.model === undefined ? {} : { model: options.model }),
  });
  return { deps, debugLines };
}

describe('manager lane prod seams (issue #431)', () => {
  it('passes the explicit --model pin through as the manager model', async () => {
    const { deps } = await prodDeps({
      model: { provider: 'acme', id: 'm1' },
    });
    expect(deps.managerModels).toBeDefined();
    expect(deps.managerModel).toEqual({ provider: 'acme', id: 'm1' });
  });

  it('leaves the manager model unresolved (template path) with an empty catalog and no pin', async () => {
    const { deps, debugLines } = await prodDeps();
    expect(deps.managerModels).toBeDefined();
    expect(deps.managerModel).toBeUndefined();
    expect(debugLines.some((line) => line.includes('manager lane off'))).toBe(
      true,
    );
  });

  it('attach-or-creates the manager session on the run store', async () => {
    const { deps } = await prodDeps();
    const open = deps.openManagerSession;
    if (open === undefined) throw new Error('openManagerSession not wired');
    const first = await open('mgr-1');
    expect(first.id).toBe('mgr-1');
    await first.release(BACKGROUND_CONTEXT);
    const second = await open('mgr-1');
    expect(second.id).toBe('mgr-1');
    await second.release(BACKGROUND_CONTEXT);
  });

  it('refuses git inspection outside a repo by tool name, never raw', async () => {
    const { deps } = await prodDeps();
    const inspect = deps.inspectGit;
    if (inspect === undefined) throw new Error('inspectGit not wired');
    await expect(inspect('git_status', {})).rejects.toThrow(/git_status/);
  });

  it('denies the manager ask closed on a headless run', async () => {
    const { deps } = await prodDeps();
    const ask = deps.askUserSeat;
    if (ask === undefined) throw new Error('askUserSeat not wired');
    const outcome = await ask('proceed?');
    expect(outcome).toEqual({
      answered: false,
      code: 'question_unanswered',
      reason: expect.stringContaining('headless'),
    });
  });
});
