// The TUI boot wires the orchestrator drive's merge gate through its OWN
// approval surface (issue #327). `mergeSeatFromAnswer` and the drive's
// `mergeSeat` option are unit-tested in tui-orchestrator.test.ts, but those
// tests hand the seat in themselves — dropping the one line in `bootTuiLane`
// that passes it would stay green while every real TUI merge denied closed.
// This boots the REAL `bootTuiLane` and captures what it hands the drive.
//
// Faux provider only: zero network, zero paid tokens.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NodeExecutionEnv } from '../../../packages/exec/src/env.js';
import type {
  ApprovalRequest,
  ApprovalVerdict,
} from '../../../packages/host/src/approvals.js';
import {
  createModels,
  fauxProvider,
} from '../../../packages/worker/src/pi-boundary.js';
import type { ProdTuiOrchestratorOptions } from './tui-orchestrator.js';
import { bootTuiLane } from './tui-run.js';

const captured: ProdTuiOrchestratorOptions[] = [];

vi.mock('./tui-orchestrator.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./tui-orchestrator.js')>();
  return {
    ...actual,
    createProdTuiOrchestrator: (options: ProdTuiOrchestratorOptions) => {
      captured.push(options);
      return actual.createProdTuiOrchestrator(options);
    },
  };
});

const dirs: string[] = [];

function tmpDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'kubic-327-merge-seat-'));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  captured.length = 0;
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

async function boot(
  answer?: (request: ApprovalRequest) => Promise<ApprovalVerdict | undefined>,
): Promise<void> {
  const workspace = tmpDir();
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  const booted = await bootTuiLane(undefined, {
    sessionsRoot: tmpDir(),
    models,
    env: new NodeExecutionEnv(workspace),
    skills: { homeDir: workspace, cwd: workspace, trusted: false },
    ...(answer === undefined ? {} : { answer }),
  });
  await booted.close?.();
}

describe('bootTuiLane hands the orchestrator drive its merge seat (issue #327)', () => {
  it('with an approval surface attached, a merge ask is routed to that surface and its verdict decides', async () => {
    const seen: ApprovalRequest[] = [];
    let approve = true;
    await boot(async (request) => {
      seen.push(request);
      return approve
        ? { approved: true, by: 'user' }
        : { approved: false, reason: 'denied by the operator' };
    });
    expect(captured).toHaveLength(1);
    const options = captured[0] as ProdTuiOrchestratorOptions;
    expect(options.seat).toBeTypeOf('function');
    const mergeSeat = options.mergeSeat;
    if (mergeSeat === undefined) throw new Error('no merge seat was wired');

    expect(
      await mergeSeat({ agentId: 'worker-1', branch: 'kubic/s/worker-1' }),
    ).toEqual({ verdict: 'approve' });
    expect(seen).toHaveLength(1);
    expect(seen[0]?.capability).toBe('merge');
    expect(seen[0]?.summary).toContain('kubic/s/worker-1');

    approve = false;
    expect(
      await mergeSeat({ agentId: 'worker-1', branch: 'kubic/s/worker-1' }),
    ).toEqual({ verdict: 'deny' });
  });

  it('without an approval surface no merge seat is wired: the drive denies closed, never a readline', async () => {
    await boot();
    expect(captured).toHaveLength(1);
    expect((captured[0] as ProdTuiOrchestratorOptions).mergeSeat).toBe(
      undefined,
    );
    expect((captured[0] as ProdTuiOrchestratorOptions).seat).toBe(undefined);
  });
});
