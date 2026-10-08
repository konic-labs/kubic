// Prod path: when the wall-clock guard fires, the headless run
// must not abandon in-flight tools — it aborts the operation and drains
// the kill registry BEFORE the reconcile sweep and before returning, so a
// detached bash child cannot outlive the run and land writes after the
// journal's last look. Real NodeExecutionEnv + real `sh` child; faux
// provider only: zero network.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
  type MutableModels,
} from '@kubic/agent/pi-boundary';
import { NodeExecutionEnv } from '@kubic/exec/env';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runHeadlessPrompt } from './headless-run.js';

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
  // The no-isolation notice is not under test here (no-isolation-notice-prod.test.ts owns
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
    fauxAssistantMessage(
      [
        fauxToolCall('bash', {
          // Inside-workspace redirect (no approval): publish the shell pid,
          // then hang — the guard fires while this op is in flight.
          command: `echo $$ > ${pidName}; sleep 60`,
        }),
      ],
      { stopReason: 'toolUse' },
    ),
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

describe('guard drain, prod path', () => {
  it('kills the detached bash child on wall-clock exhaustion before returning', {
    // The run itself takes timeoutMs plus drain time; the budget here is
    // a liveness bound, not a latency assertion.
    timeout: 30_000,
  }, async () => {
    const sessionsRoot = tmpRoot();
    const workspace = tmpRoot('ws-');
    const pidFile = join(workspace, 'pidmarker.txt');
    const result = await runHeadlessPrompt(
      'hang a bash child',
      // Generous on purpose: the guard must fire strictly
      // AFTER the faux turn reaches the bash call and the child publishes
      // its pid — under scheduler contention a tight budget fires first
      // and the pidfile assertion below flakes. Nothing here asserts how
      // fast the turn runs; order (marker, then guard, then return) is
      // what the assertions pin.
      { timeoutMs: 5_000 },
      {
        sessionsRoot,
        models: hangingBashModels('pidmarker.txt'),
        env: new NodeExecutionEnv(workspace),
      },
    );
    expect(result.terminus).toBe('timeout');
    // The child wrote its own pid immediately, then slept; the drain ran
    // before runHeadlessPrompt returned, so nothing can write the pidfile
    // after this point — it must already be there (no polling for it).
    expect(existsSync(pidFile)).toBe(true);
    const pid = Number.parseInt(readFileSync(pidFile, 'utf8').trim(), 10);
    expect(Number.isFinite(pid)).toBe(true);
    observedPid = pid;
    // The drain ran before runHeadlessPrompt returned: the process group
    // got SIGKILL. A live `sh` here would mean the drain left the process group running.
    const dead = await pollUntil(() => shState(pid) !== 'alive', 2_000);
    expect(dead).toBe(true);
  });
});
