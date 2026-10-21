// Runs an admin-defined hook: one `sh -c <command>` with a JSON payload on
// stdin, bounded in time and in output, in the environment the tools get —
// the allowlisted variables, with every secret-shaped name dropped, so a hook
// never sees a provider key. A hook that runs past its bound is killed and
// reported as timed out; the caller decides what that means (a before-tool
// hook fails closed).
//
// Lives in exec: only packages/exec touches node:child_process.

import { spawn } from 'node:child_process';
import { toolSpawnEnv } from './env/tool-env.js';

const MAX_OUTPUT_BYTES = 64 * 1024;

export interface HookRun {
  // The exit status; null when the hook was killed or never started.
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut: boolean;
  // Set when the hook could not be started at all.
  readonly error?: string;
}

export interface HookRunOptions {
  readonly timeoutMs: number;
  readonly cwd: string;
  // Extra variables (`KUBIC_HOOK_EVENT`), above the tool environment.
  readonly env?: Readonly<Record<string, string>>;
  // The environment the allowlist is taken from; absent: this process's.
  readonly baseEnv?: NodeJS.ProcessEnv;
}

export function runHookCommand(
  command: string,
  input: string,
  options: HookRunOptions,
): Promise<HookRun> {
  return new Promise<HookRun>((resolve) => {
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;
    const finish = (run: HookRun): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(run);
    };
    // Its own process group, so a timeout kills what the shell started too:
    // a `sh` that forks (dash does) would otherwise leave the child holding
    // the pipes open past the bound.
    const groups = process.platform !== 'win32';
    const child = spawn('/bin/sh', ['-c', command], {
      cwd: options.cwd,
      detached: groups,
      env: { ...toolSpawnEnv(options.baseEnv ?? process.env), ...options.env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        if (groups && child.pid !== undefined)
          process.kill(-child.pid, 'SIGKILL');
        else child.kill('SIGKILL');
      } catch {
        child.kill('SIGKILL');
      }
      child.stdout.destroy();
      child.stderr.destroy();
    }, options.timeoutMs);
    const keep = (current: string, chunk: unknown): string =>
      current.length >= MAX_OUTPUT_BYTES
        ? current
        : (current + String(chunk)).slice(0, MAX_OUTPUT_BYTES);
    child.stdout.on('data', (chunk) => {
      stdout = keep(stdout, chunk);
    });
    child.stderr.on('data', (chunk) => {
      stderr = keep(stderr, chunk);
    });
    child.on('error', (error) =>
      finish({
        exitCode: null,
        stdout,
        stderr,
        timedOut,
        error: error.message,
      }),
    );
    child.on('close', (code) =>
      finish({ exitCode: code, stdout, stderr, timedOut }),
    );
    // A hook that does not read its stdin must not fail the write.
    child.stdin.on('error', () => undefined);
    child.stdin.end(input);
  });
}
