// spawn via the exec Shell seam (issue #42): env allowlist + role creds
// applied, readiness marker flips ready→running, startup span recorded,
// spawn failure is terminal SPAWN_FAILED. Faux Shell only — zero network.
import { describe, expect, it, vi } from 'vitest';
import type { Shell } from '../../../exec/src/env.js';
import { FakeExecutionEnv, ROOT_PROVENANCE } from '../../../exec/src/env.js';
import { StaleGenerationError, spawnWorker } from './spawn.js';

const READY_LINE = 'KUBIC_WORKER_READY w-1';

function shellFor(stdout: string, exitCode = 0): Shell {
  const env = new FakeExecutionEnv({
    'worker --run': { exitCode, stdout, stderr: '' },
  });
  return env.shell;
}

describe('spawnWorker (issue #42)', () => {
  it('applies the env allowlist and injects role creds on spawn', async () => {
    let seen: Record<string, string> | undefined;
    const inner = shellFor(`${READY_LINE}
`);
    const shell: Shell = {
      spawn: (cmd, args, options) => {
        seen = (options as { env?: Record<string, string> }).env;
        return inner.spawn(cmd, args, options);
      },
    };
    const worker = spawnWorker(
      shell,
      {
        workerId: 'w-1',
        sessionId: 's-1',
        generation: 1,
        role: 'reviewer',
        cmd: 'worker',
        args: ['--run'],
        baseEnv: { PATH: '/bin', PARENT_SECRET: 'nope' },
        credentials: { token: 'role-secret' },
        provenance: ROOT_PROVENANCE,
      },
      { clock: () => 0 },
    );
    await worker.wait();
    await worker.ready;
    expect(seen?.PATH).toBe('/bin');
    expect(seen?.PARENT_SECRET).toBeUndefined();
    expect(seen?.KUBIC_ROLE_REVIEWER_TOKEN).toBe('role-secret');
  });

  it('flips to running on the readiness marker and records startupMs', async () => {
    let now = 1000;
    const worker = spawnWorker(
      shellFor(`${READY_LINE}
`),
      {
        workerId: 'w-1',
        sessionId: 's-1',
        generation: 1,
        role: 'reviewer',
        cmd: 'worker',
        args: ['--run'],
        baseEnv: {},
        provenance: ROOT_PROVENANCE,
      },
      { clock: () => now },
    );
    expect(worker.status).toBe('spawning');
    now = 1040;
    await worker.wait();
    await worker.ready;
    // §13 (issue #151): the PROCESS is ready; the launch layer's agent
    // state is what says the worker is running.
    expect(worker.status).toBe('ready');
    expect(worker.startupMs).toBe(40);
  });

  it('fails closed with SPAWN_FAILED when readiness never arrives', async () => {
    const worker = spawnWorker(
      shellFor('still booting\n'),
      {
        workerId: 'w-9',
        sessionId: 's-9',
        generation: 1,
        role: 'writer',
        cmd: 'worker',
        args: ['--run'],
        baseEnv: {},
        provenance: ROOT_PROVENANCE,
        readyTimeoutMs: 10,
      },
      { clock: () => 0 },
    );
    await expect(worker.ready).rejects.toThrow(/readiness/i);
    expect(worker.status).toBe('exiting');
    expect(worker.unready).toBe(true);
  });

  it('binds generation and sessionId onto the spawned worker record', async () => {
    const worker = spawnWorker(
      shellFor(`${READY_LINE}\n`),
      {
        workerId: 'w-1',
        sessionId: 's-1',
        generation: 3,
        role: 'reviewer',
        cmd: 'worker',
        args: ['--run'],
        baseEnv: {},
        provenance: ROOT_PROVENANCE,
      },
      { clock: () => 0 },
    );
    await worker.wait();
    await worker.ready;
    expect(worker.sessionId).toBe('s-1');
    expect(worker.generation).toBe(3);
  });

  it('refuses a stale generation without touching the shell', () => {
    const inner = shellFor(`${READY_LINE}\n`);
    const spy = vi.fn((cmd: string, args: string[], options: unknown) =>
      inner.spawn(cmd, args, options as Parameters<Shell['spawn']>[2]),
    );
    const shell: Shell = { spawn: spy };
    expect(() =>
      spawnWorker(
        shell,
        {
          workerId: 'w-1',
          sessionId: 's-1',
          generation: 1,
          role: 'reviewer',
          cmd: 'worker',
          args: ['--run'],
          baseEnv: {},
          provenance: ROOT_PROVENANCE,
        },
        { clock: () => 0, getLiveGeneration: () => 2 },
      ),
    ).toThrow(StaleGenerationError);
    expect(spy).not.toHaveBeenCalled();
  });

  it('emits a redacted debug line carrying no grant secret', async () => {
    const lines: string[] = [];
    const worker = spawnWorker(
      shellFor(`${READY_LINE}\n`),
      {
        workerId: 'w-1',
        sessionId: 's-1',
        generation: 1,
        role: 'reviewer',
        cmd: 'worker',
        args: ['--run'],
        baseEnv: { PATH: '/bin' },
        credentials: { session: 's3cr3t-value' },
        provenance: ROOT_PROVENANCE,
      },
      { clock: () => 0, onDebug: (line: string) => lines.push(line) },
    );
    await worker.wait();
    await worker.ready;
    expect(lines).toHaveLength(1);
    expect(lines.join('\n')).not.toContain('s3cr3t-value');
    expect(lines.join('\n')).toContain('KUBIC_ROLE_REVIEWER_SESSION');
    // The handle itself never carries the plaintext secret either.
    expect(Object.values(worker.env)).not.toContain('s3cr3t-value');
  });
});

describe('spawnWorker readiness scan (issue #187)', () => {
  function chunkedShell(): {
    shell: Shell;
    update: (stdout: unknown, stderr?: unknown) => void;
  } {
    let onUpdate:
      | ((snapshot: {
          stdout: string;
          stderr: string;
          exitCode: number | null;
        }) => void)
      | undefined;
    const shell: Shell = {
      spawn: (_cmd, _args, options) => {
        onUpdate = options.onUpdate as typeof onUpdate;
        return {
          pid: 4242,
          wait: () =>
            Promise.resolve({
              exitCode: 0,
              stdout: '',
              stderr: '',
              signal: null,
              forced: false,
              provenance: ROOT_PROVENANCE,
            }),
          kill: () => undefined,
        };
      },
    };
    return {
      shell,
      update: (stdout: unknown, stderr: unknown = '') =>
        onUpdate?.({
          stdout: stdout as string,
          stderr: stderr as string,
          exitCode: null,
        }),
    };
  }

  function spawnOn(shell: Shell) {
    return spawnWorker(
      shell,
      {
        workerId: 'w-1',
        sessionId: 's-1',
        generation: 1,
        role: 'reviewer',
        cmd: 'worker',
        args: ['--run'],
        baseEnv: {},
        provenance: ROOT_PROVENANCE,
      },
      { clock: () => 0 },
    );
  }

  // A snapshot whose text explodes on contact: template/concat/includes
  // all route through toString/valueOf, while length/slice do not.
  function unreadable(text: string): string {
    const boxed = new String(text) as unknown as {
      toString(): string;
      valueOf(): string;
    };
    const bomb = (): string => {
      throw new Error('snapshot scanned after readiness');
    };
    boxed.toString = bomb;
    boxed.valueOf = bomb;
    return boxed as unknown as string;
  }

  it('does not scan snapshot text once past spawning', async () => {
    const { shell, update } = chunkedShell();
    const worker = spawnOn(shell);
    update(`${READY_LINE}\n`);
    await worker.ready;
    expect(worker.status).toBe('ready');
    // Must not throw: the text is never touched after readiness.
    update(unreadable('x'.repeat(1_000_000)), unreadable('y'.repeat(1000)));
    expect(worker.status).toBe('ready');
  });

  it('still detects a marker split across two chunks', async () => {
    const { shell, update } = chunkedShell();
    const worker = spawnOn(shell);
    // Delta-shaped second snapshot (only the new bytes), as a trimming
    // accumulator or a delta-seam would deliver it.
    update('KUBIC_WORKER_REA');
    const winner = await Promise.race([
      worker.ready.then(() => 'ready'),
      Promise.resolve().then(() => 'pending'),
    ]);
    expect(winner).toBe('pending');
    update('DY w-1\n');
    await worker.ready;
    expect(worker.status).toBe('ready');
    expect(worker.startupMs).toBe(0);
  });
});
