// The allowlisted child env reaches the OS (issue #94; §3.8): the exec
// Shell seam has no env field (process spawning is packages/exec's), so the
// lifecycle layer wraps it with `env -i …` — the live child starts with
// exactly the allowlist plus its role grant, never the parent's ambient
// environment. Real process, real env, zero network.
import { describe, expect, it } from 'vitest';
import { NodeExecutionEnv, ROOT_PROVENANCE } from '../../../exec/src/env.js';
import { buildSpawnEnv } from './env.js';
import { allowlistedShell } from './shell.js';

const PROBE = [
  '-e',
  'process.stdout.write(JSON.stringify({secret: process.env.PARENT_ONLY_SECRET ?? null, path: process.env.PATH ?? null, role: process.env.KUBIC_ROLE_WRITER_TOKEN ?? null, workerId: process.env.KUBIC_WORKER_ID ?? null, home: process.env.HOME ?? null, aws: process.env.AWS_SECRET_ACCESS_KEY ?? null}))',
];

describe('allowlistedShell (issue #94, §3.8)', () => {
  it('starts the child with exactly the allowlisted env', async () => {
    const previous = process.env.PARENT_ONLY_SECRET;
    process.env.PARENT_ONLY_SECRET = 'parent-leak';
    try {
      const shell = allowlistedShell(new NodeExecutionEnv(process.cwd()).shell);
      const child = shell.spawn(process.execPath, PROBE, {
        provenance: ROOT_PROVENANCE,
        env: buildSpawnEnv(
          { ...process.env, PARENT_ONLY_SECRET: 'parent-leak' },
          'writer',
          { token: 'role-secret' },
        ),
      });
      const done = await child.wait();
      expect(done.exitCode).toBe(0);
      const seen = JSON.parse(done.stdout.trim()) as Record<string, unknown>;
      // The parent had the secret; the child never does.
      expect(seen.secret).toBeNull();
      expect(seen.workerId).toBeNull();
      expect(seen.role).toBe('role-secret');
      expect(seen.path).toBe(process.env.PATH);
    } finally {
      if (previous === undefined) delete process.env.PARENT_ONLY_SECRET;
      else process.env.PARENT_ONLY_SECRET = previous;
    }
  });

  it('carries the worker id when the launcher sets it', async () => {
    const shell = allowlistedShell(new NodeExecutionEnv(process.cwd()).shell);
    const child = shell.spawn(process.execPath, PROBE, {
      provenance: ROOT_PROVENANCE,
      env: buildSpawnEnv(
        { PATH: process.env.PATH ?? '', KUBIC_WORKER_ID: 'worker-7' },
        'writer',
        {},
      ),
    });
    const done = await child.wait();
    expect(JSON.parse(done.stdout.trim()).workerId).toBe('worker-7');
  });

  it('drops an allowlist-absent parent variable even when the parent has it set', async () => {
    const previous = process.env.AWS_SECRET_ACCESS_KEY;
    process.env.AWS_SECRET_ACCESS_KEY = 'parent-ambient-secret';
    try {
      const shell = allowlistedShell(new NodeExecutionEnv(process.cwd()).shell);
      const child = shell.spawn(process.execPath, PROBE, {
        provenance: ROOT_PROVENANCE,
        env: buildSpawnEnv(
          Object.fromEntries(
            Object.entries(process.env).filter(
              (entry): entry is [string, string] => entry[1] !== undefined,
            ),
          ),
          'writer',
          {},
        ),
      });
      const done = await child.wait();
      expect(done.exitCode).toBe(0);
      const seen = JSON.parse(done.stdout.trim()) as Record<string, unknown>;
      // The probe reads the variable directly: the parent has it set, the
      // child must not.
      expect(seen.aws).toBeNull();
      expect(seen.path).toBe(process.env.PATH);
    } finally {
      if (previous === undefined) delete process.env.AWS_SECRET_ACCESS_KEY;
      else process.env.AWS_SECRET_ACCESS_KEY = previous;
    }
  });
});
