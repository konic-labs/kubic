import { mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ExecutionEnv, Provenance } from './env.js';
import { FakeExecutionEnv, NodeExecutionEnv } from './env.js';

const PROV: Provenance = {
  sessionId: 's1',
  agentId: 'a1',
  toolCallId: 't1',
  turnId: 1,
  operation: 'bash',
};

function makeNodeEnv(): { env: ExecutionEnv; cwd: string } {
  const cwd = mkdtempSync(join(tmpdir(), 'exec-env-'));
  return { env: new NodeExecutionEnv(cwd), cwd };
}

describe('execution env (issue #12, slice A)', () => {
  it('confines writes to the cwd', () => {
    const { env } = makeNodeEnv();
    expect(() => env.fs.writeFile('../escape.txt', 'x')).toThrow(/cwd|confin/i);
    expect(() => env.fs.writeFile('/absolutely/elsewhere.txt', 'x')).toThrow(
      /cwd|confin/i,
    );
  });

  it('reads back writes inside the cwd', () => {
    const { env } = makeNodeEnv();
    env.fs.writeFile('a.txt', 'hello');
    expect(env.fs.readFile('a.txt')).toBe('hello');
    expect(env.fs.listDir('.')).toContain('a.txt');
  });

  it('shell results carry the call provenance', async () => {
    const env = new FakeExecutionEnv({
      'echo hi': { exitCode: 0, stdout: 'hi\n', stderr: '' },
    });
    const handle = env.shell.spawn('echo', ['hi'], { provenance: PROV });
    const result = await handle.wait();
    expect(result.provenance).toEqual(PROV);
    expect(result.stdout).toBe('hi\n');
  });

  it('fake env is hermetic (no disk touched)', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'exec-fake-'));
    const env = new FakeExecutionEnv({});
    env.fs.writeFile('mem.txt', 'data');
    expect(env.fs.readFile('mem.txt')).toBe('data');
    expect(readdirSync(cwd)).toEqual([]);
  });

  it('node shell executes and captures output', async () => {
    const { env } = makeNodeEnv();
    const handle = env.shell.spawn(
      process.execPath,
      ['-e', 'process.stdout.write("hi")'],
      {
        provenance: PROV,
      },
    );
    const result = await handle.wait();
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('hi');
    expect(result.provenance).toEqual(PROV);
  });

  it('withProvenance scopes without mutating the parent', () => {
    const { env } = makeNodeEnv();
    const scoped = env.withProvenance({ ...PROV, toolCallId: 't2' });
    expect(scoped.provenance.toolCallId).toBe('t2');
    expect(env.provenance.toolCallId).toBe('root');
  });
});
