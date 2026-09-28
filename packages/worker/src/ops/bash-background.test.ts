// Issue #339: the bash tool must never stall a turn on a stdin reader or a
// backgrounded job, must not leak the detached process group, and must
// report signal exits as 128+signal. Real NodeExecutionEnv + real bash.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { NodeExecutionEnv } from '../../../exec/src/env.js';
import {
  BASH_DEFAULT_TIMEOUT_SEC,
  BASH_MAX_TIMEOUT_SEC,
  type BashResult,
  resolveBashPolicy,
} from './bash.js';
import { createInvocation, MemoryMemoStore } from './memos.js';
import { callOperation } from './registry.js';
import type { OpContext } from './types.js';

const scratchDirs: string[] = [];
const strayPids: number[] = [];

afterEach(() => {
  for (const pid of strayPids.splice(0)) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // Already gone — the expected case.
    }
  }
  for (const dir of scratchDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function realCtx(extra: Partial<OpContext> = {}): OpContext {
  const cwd = mkdtempSync(join(tmpdir(), 'bash-bg-'));
  scratchDirs.push(cwd);
  return {
    sessionId: 's1',
    agentId: 'root',
    env: new NodeExecutionEnv(cwd),
    ...extra,
  };
}

let seq = 0;
function inv() {
  seq += 1;
  return createInvocation(
    { invocationId: `inv-${seq}`, operationId: 'op-1', turnId: 'turn-1' },
    new MemoryMemoStore(),
  );
}

async function run(
  args: Record<string, unknown>,
  ctx: OpContext = realCtx(),
): Promise<BashResult> {
  const out = await callOperation('bash', args, inv(), ctx);
  if (!out.ok) throw new Error(`bash failed: ${out.error.message}`);
  return out.result as BashResult;
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

const posix = process.platform !== 'win32';

describe.runIf(posix)('bash stdin and background jobs (issue #339)', () => {
  it('a stdin reader (cat) with no timeout settles promptly with exit 0', async () => {
    const started = Date.now();
    const result = await run({ command: 'cat' });
    expect(Date.now() - started).toBeLessThan(2000);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('');
    expect(result.timedOut).toBe(false);
  });

  it('a backgrounded job holding stdout does not hold the turn', async () => {
    const started = Date.now();
    const result = await run({ command: 'echo hi; sleep 30 &' });
    expect(Date.now() - started).toBeLessThan(1000);
    expect(result.stdout).toBe('hi\n');
    expect(result.exitCode).toBe(0);
    expect(result.background).toBe('killed');
    expect(result.stderr).toContain('background processes');
  });

  it('a redirected background job returns fast and is gone afterwards', async () => {
    const started = Date.now();
    const result = await run({
      command: 'sleep 30 >/dev/null 2>&1 & echo $!; echo ok',
    });
    expect(Date.now() - started).toBeLessThan(1000);
    const [pidLine, okLine] = result.stdout.trim().split('\n');
    const pid = Number.parseInt(pidLine as string, 10);
    strayPids.push(pid);
    expect(okLine).toBe('ok');
    expect(Number.isInteger(pid) && pid > 0).toBe(true);
    expect(() => process.kill(pid, 0)).toThrow(
      expect.objectContaining({ code: 'ESRCH' }),
    );
    expect(alive(pid)).toBe(false);
  });

  it('a command that leaves no background job reports none', async () => {
    const result = await run({ command: 'echo plain' });
    expect(result.stdout).toBe('plain\n');
    expect(result.background).toBeUndefined();
    expect(result.stderr).toBe('');
  });

  it('output the leader wrote before exiting survives the early settle', async () => {
    const result = await run({
      command:
        'sleep 30 & node -e "process.stdout.write(\'x\'.repeat(60000))"; printf END',
    });
    expect(result.stdout.length).toBe(60003);
    expect(result.stdout.endsWith('END')).toBe(true);
  });

  it('keepBackground detaches instead of killing, and says so', async () => {
    const result = await run(
      { command: 'sleep 30 >/dev/null 2>&1 & echo $!' },
      realCtx({
        bashPolicy: {
          defaultTimeoutSec: BASH_DEFAULT_TIMEOUT_SEC,
          maxTimeoutSec: BASH_MAX_TIMEOUT_SEC,
          keepBackground: true,
        },
      }),
    );
    const pid = Number.parseInt(result.stdout.trim(), 10);
    strayPids.push(pid);
    expect(result.background).toBe('detached');
    expect(alive(pid)).toBe(true);
  });

  it('a signal-terminated command reports 128+signal', async () => {
    const result = await run({ command: 'kill -9 $$' });
    expect(result.exitCode).toBe(137);
    const term = await run({ command: 'kill -TERM $$' });
    expect(term.exitCode).toBe(143);
  });
});

describe.runIf(posix)('bash default and maximum timeout (issue #339)', () => {
  it('applies the default timeout when the model supplies none', async () => {
    const started = Date.now();
    const result = await run(
      { command: 'sleep 30' },
      realCtx({
        bashPolicy: {
          defaultTimeoutSec: 0.3,
          maxTimeoutSec: 10,
          keepBackground: false,
        },
      }),
    );
    expect(Date.now() - started).toBeLessThan(3000);
    expect(result.timedOut).toBe(true);
    expect(result.exitCode).toBeNull();
  });

  it('clamps a model-supplied timeout to the maximum', async () => {
    const started = Date.now();
    const result = await run(
      { command: 'sleep 30', timeout: 600 },
      realCtx({
        bashPolicy: {
          defaultTimeoutSec: 10,
          maxTimeoutSec: 0.3,
          keepBackground: false,
        },
      }),
    );
    expect(Date.now() - started).toBeLessThan(3000);
    expect(result.timedOut).toBe(true);
  });
});

describe('resolveBashPolicy (issue #339)', () => {
  it('defaults when nothing is set', () => {
    expect(resolveBashPolicy({})).toEqual({
      defaultTimeoutSec: BASH_DEFAULT_TIMEOUT_SEC,
      maxTimeoutSec: BASH_MAX_TIMEOUT_SEC,
      keepBackground: false,
    });
    expect(BASH_DEFAULT_TIMEOUT_SEC).toBe(120);
    expect(BASH_MAX_TIMEOUT_SEC).toBe(600);
  });

  it('reads the documented environment overrides', () => {
    expect(
      resolveBashPolicy({
        KUBIC_BASH_TIMEOUT: '30',
        KUBIC_BASH_MAX_TIMEOUT: '90',
        KUBIC_BASH_KEEP_BACKGROUND: '1',
      }),
    ).toEqual({
      defaultTimeoutSec: 30,
      maxTimeoutSec: 90,
      keepBackground: true,
    });
    expect(
      resolveBashPolicy({ KUBIC_BASH_KEEP_BACKGROUND: 'true' }).keepBackground,
    ).toBe(true);
    expect(
      resolveBashPolicy({ KUBIC_BASH_KEEP_BACKGROUND: '0' }).keepBackground,
    ).toBe(false);
  });

  it('caps the default at the maximum', () => {
    expect(
      resolveBashPolicy({
        KUBIC_BASH_TIMEOUT: '900',
        KUBIC_BASH_MAX_TIMEOUT: '60',
      }).defaultTimeoutSec,
    ).toBe(60);
  });

  it('refuses a malformed value by name', () => {
    expect(() => resolveBashPolicy({ KUBIC_BASH_TIMEOUT: 'soon' })).toThrow(
      /KUBIC_BASH_TIMEOUT/,
    );
    expect(() => resolveBashPolicy({ KUBIC_BASH_MAX_TIMEOUT: '0' })).toThrow(
      /KUBIC_BASH_MAX_TIMEOUT/,
    );
    expect(() =>
      resolveBashPolicy({ KUBIC_BASH_MAX_TIMEOUT: '9999999' }),
    ).toThrow(/KUBIC_BASH_MAX_TIMEOUT/);
    expect(() =>
      resolveBashPolicy({ KUBIC_BASH_KEEP_BACKGROUND: 'maybe' }),
    ).toThrow(/KUBIC_BASH_KEEP_BACKGROUND/);
  });
});
