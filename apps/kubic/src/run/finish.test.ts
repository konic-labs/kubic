// The settled result after the session closed: the report fields, the
// secret scrub and the trajectory's failure path, over a RunState with no
// lane behind it.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NodeExecutionEnv } from '@kubic/exec/env';
import { afterEach, describe, expect, it } from 'vitest';
import { finishRun } from './finish.js';
import { runResult } from './outcome.js';
import { RunState } from './state.js';

const made: string[] = [];
afterEach(() => {
  for (const dir of made.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

function tmp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  made.push(dir);
  return dir;
}

function newState(sessionsRoot: string, warnings: string[] = []): RunState {
  const workspace = tmp('run-finish-ws-');
  return new RunState(
    'the prompt',
    {},
    {
      sessionsRoot,
      env: new NodeExecutionEnv(workspace),
      warn: (line) => warnings.push(line),
    },
  );
}

describe('finishRun', () => {
  it('names the live model, the posture and the mode on a run with no session, and writes no trajectory', async () => {
    const state = newState(tmp('run-finish-sessions-'));
    state.report.model = 'faux/big';
    state.report.posture = 'approvals';
    state.report.mode = 'interactive';
    const settled = await finishRun(
      state,
      runResult({ kind: 'usage', message: 'invalid maxTurns 0' }),
    );
    expect(settled).toMatchObject({
      terminus: 'usage',
      model: 'faux/big',
      posture: 'approvals',
      mode: 'interactive',
      trajectoryRef: 'trajectory:unassigned',
    });
    expect(settled.usage).toBeUndefined();
  });

  it('scrubs every live provider key out of the result', async () => {
    const state = newState(tmp('run-finish-sessions-'));
    state.capture.liveSecrets = () => ['sk-live-0123456789abcdef'];
    const settled = await finishRun(
      state,
      runResult({
        kind: 'caught',
        error: new Error('401: key sk-live-0123456789abcdef rejected'),
      }),
    );
    expect(JSON.stringify(settled)).not.toContain('sk-live-0123456789abcdef');
    expect(settled.summary).toContain('[REDACTED]');
  });

  it('keeps the result and warns when the trajectory cannot be written', async () => {
    const root = tmp('run-finish-sessions-');
    // A file where the sessions root should be: neither the usage nor the
    // trajectory can be read or written under it.
    const blocked = join(root, 'not-a-directory');
    writeFileSync(blocked, '');
    const warnings: string[] = [];
    const state = newState(blocked, warnings);
    state.capture.sessionId = 's1';
    state.capture.sessionsRoot = blocked;
    const settled = await finishRun(
      state,
      runResult({ kind: 'completed', summary: 'done' }, 's1'),
    );
    expect(settled).toMatchObject({
      terminus: 'completed',
      summary: 'done',
      trajectoryRef: 'trajectory:s1',
    });
    expect(settled.usage).toBeUndefined();
    expect(warnings.at(-1)).toMatch(/^trajectory not written for session s1: /);
  });
});
