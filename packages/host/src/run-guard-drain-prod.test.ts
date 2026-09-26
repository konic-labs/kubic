// Issue #109, prod path: when the wall-clock guard fires, the headless run
// must not abandon in-flight tools — it aborts the operation and drains
// the kill registry BEFORE the reconcile sweep and before returning, so a
// detached bash child cannot outlive the run and land writes after the
// journal's last look. Real NodeExecutionEnv + real `sh` child; faux
// provider only: zero network.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runHeadlessPrompt } from '../../../apps/kubic/src/headless-run.js';
import { NodeExecutionEnv } from '../../exec/src/env.js';
import {
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
  type MutableModels,
} from '../../worker/src/pi-boundary.js';

function tmpRoot(prefix = 'guard-drain-'): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function hangingBashModels(pidName: string): MutableModels {
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  faux.setResponses([
    fauxAssistantMessage([
      fauxToolCall('bash', {
        // Inside-workspace redirect (no approval): publish the shell pid,
        // then hang — the guard fires while this op is in flight.
        command: `echo $$ > ${pidName}; sleep 60`,
      }),
    ]),
  ]);
  return models;
}

// 'gone' (no such pid), 'zombie' (killed, not yet reaped) and 'alive' —
// the guard's kill is a group SIGKILL, so anything but alive proves the
// child died with the run.
function shState(pid: number): 'gone' | 'zombie' | 'alive' {
  try {
    const stat = execFileSync('ps', ['-p', String(pid), '-o', 'stat='], {
      encoding: 'utf8',
    }).trim();
    return stat.startsWith('Z') ? 'zombie' : 'alive';
  } catch {
    return 'gone';
  }
}

async function pollUntil(
  probe: () => boolean,
  deadlineMs: number,
): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < deadlineMs) {
    if (probe()) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return probe();
}

describe('guard drain, prod path (issue #109)', () => {
  it('kills the detached bash child on wall-clock exhaustion before returning', {
    timeout: 20_000,
  }, async () => {
    const sessionsRoot = tmpRoot();
    const workspace = tmpRoot('ws-');
    const pidFile = join(workspace, 'pidmarker.txt');
    const result = await runHeadlessPrompt(
      'hang a bash child',
      { timeoutMs: 1_500 },
      {
        sessionsRoot,
        models: hangingBashModels('pidmarker.txt'),
        env: new NodeExecutionEnv(workspace),
      },
    );
    expect(result.terminus).toBe('budget_exhausted');
    // The child wrote its own pid immediately, then slept. Wait for the
    // pidfile (it appears long before the 1.5s guard fires).
    const wrote = await pollUntil(() => existsSync(pidFile), 5_000);
    expect(wrote).toBe(true);
    const pid = Number.parseInt(readFileSync(pidFile, 'utf8').trim(), 10);
    expect(Number.isFinite(pid)).toBe(true);
    // The drain ran before runHeadlessPrompt returned: the process group
    // got SIGKILL. A live `sh` here is the bug this issue exists for.
    const dead = await pollUntil(() => shState(pid) !== 'alive', 2_000);
    expect(dead).toBe(true);
  });
});
