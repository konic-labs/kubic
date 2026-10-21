// The admin hook runner: the payload on stdin, the tool environment (no
// provider key), the bounded output and the timeout kill.
import { describe, expect, it } from 'vitest';
import { tempDir } from '../../../test/temp-dir.js';
import { runHookCommand } from './hook-runner.js';

describe('runHookCommand', () => {
  it('hands the hook its payload on stdin and reports its exit', async () => {
    const run = await runHookCommand(
      'cat; echo; echo "to stderr" >&2; exit 4',
      '{"event":"beforeTool"}',
      { timeoutMs: 5_000, cwd: tempDir('hook-runner-') },
    );
    expect(run.exitCode).toBe(4);
    expect(run.stdout).toContain('{"event":"beforeTool"}');
    expect(run.stderr).toContain('to stderr');
    expect(run.timedOut).toBe(false);
  });

  it('runs in the tool environment: no provider key, the hook event set', async () => {
    const run = await runHookCommand('env', '', {
      timeoutMs: 5_000,
      cwd: tempDir('hook-runner-'),
      env: { KUBIC_HOOK_EVENT: 'runEnd' },
      baseEnv: {
        PATH: process.env.PATH,
        OPENAI_API_KEY: 'sk-hook-test-value',
        HOME: '/home/hook',
      },
    });
    expect(run.exitCode).toBe(0);
    expect(run.stdout).toContain('KUBIC_HOOK_EVENT=runEnd');
    expect(run.stdout).not.toContain('OPENAI_API_KEY');
    expect(run.stdout).not.toContain('sk-hook-test-value');
  });

  it('runs in the given directory', async () => {
    const cwd = tempDir('hook-runner-');
    const run = await runHookCommand('pwd -P', '', { timeoutMs: 5_000, cwd });
    expect(run.stdout.trim().endsWith(cwd.split('/').pop() as string)).toBe(
      true,
    );
  });

  it('kills a hook that runs past its bound and says so', async () => {
    const started = Date.now();
    const run = await runHookCommand('sleep 10; true', '', {
      timeoutMs: 150,
      cwd: tempDir('hook-runner-'),
    });
    expect(run.timedOut).toBe(true);
    expect(run.exitCode).toBeNull();
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it('keeps at most 64 KiB of output', async () => {
    const run = await runHookCommand(
      'head -c 200000 /dev/zero | tr "\\0" a',
      '',
      { timeoutMs: 5_000, cwd: tempDir('hook-runner-') },
    );
    expect(run.exitCode).toBe(0);
    expect(run.stdout.length).toBe(64 * 1024);
  });

  it('survives a hook that never reads its stdin', async () => {
    const run = await runHookCommand('exit 0', 'x'.repeat(1_000_000), {
      timeoutMs: 5_000,
      cwd: tempDir('hook-runner-'),
    });
    expect(run.exitCode).toBe(0);
  });
});
