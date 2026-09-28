// Issue #109, prod path: when the wall-clock guard fires, the headless run
// must not abandon in-flight tools — it aborts the operation and drains
// the kill registry BEFORE the reconcile sweep and before returning, so a
// detached bash child cannot outlive the run and land writes after the
// journal's last look. Real NodeExecutionEnv + real `sh` child; faux
// provider only: zero network.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runHeadlessPrompt } from '../../../apps/kubic/src/headless-run.js';
import { NodeExecutionEnv } from '../../exec/src/env.js';
import {
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
  type MutableModels,
} from '../../worker/src/pi-boundary.js';

const made: string[] = [];
// A shell pid this test observed: if an assertion fails while the child is
// still alive, afterEach kills it rather than leaking a 60s `sleep`.
let observedPid: number | undefined;

function tmpRoot(prefix = 'guard-drain-'): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  made.push(dir);
  return dir;
}

beforeEach(() => {
  // The solo notice is not under test here (solo-notice-prod.test.ts owns
  // it); the documented opt-out keeps it off the test runner's stderr.
  vi.stubEnv('KUBIC_NO_NOTICE', '1');
});

afterEach(() => {
  vi.unstubAllEnvs();
  if (observedPid !== undefined) {
    try {
      process.kill(-observedPid, 'SIGKILL');
    } catch {
      // Already gone — the expected case.
    }
    observedPid = undefined;
  }
  for (const dir of made.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

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
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return probe();
}

describe('guard drain, prod path (issue #109)', () => {
  it('kills the detached bash child on wall-clock exhaustion before returning', {
    timeout: 10_000,
  }, async () => {
    const sessionsRoot = tmpRoot();
    const workspace = tmpRoot('ws-');
    const pidFile = join(workspace, 'pidmarker.txt');
    const result = await runHeadlessPrompt(
      'hang a bash child',
      // Long enough for the faux turn to reach the bash call and the shell
      // to publish its pid (a few ms); short enough not to idle the suite.
      { timeoutMs: 400 },
      {
        sessionsRoot,
        models: hangingBashModels('pidmarker.txt'),
        env: new NodeExecutionEnv(workspace),
      },
    );
    expect(result.terminus).toBe('budget_exhausted');
    // The child wrote its own pid immediately, then slept; the drain ran
    // before runHeadlessPrompt returned, so nothing can write the pidfile
    // after this point — it must already be there (no polling for it).
    expect(existsSync(pidFile)).toBe(true);
    const pid = Number.parseInt(readFileSync(pidFile, 'utf8').trim(), 10);
    expect(Number.isFinite(pid)).toBe(true);
    observedPid = pid;
    // The drain ran before runHeadlessPrompt returned: the process group
    // got SIGKILL. A live `sh` here is the bug this issue exists for.
    const dead = await pollUntil(() => shState(pid) !== 'alive', 2_000);
    expect(dead).toBe(true);
  });
});
