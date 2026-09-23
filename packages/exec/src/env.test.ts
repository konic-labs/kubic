import { mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ExecutionEnv, ProcessSnapshot, Provenance } from './env.js';
import {
  FakeExecutionEnv,
  MemoryCheckpointStore,
  NodeExecutionEnv,
  ROOT_PROVENANCE,
} from './env.js';

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
  it('pins the root provenance identity exactly', () => {
    // Every field is asserted: '' → 'Stryker was here!' and 'root'/0/'init'
    // mutants must fail (mutation: StringLiteral).
    expect(ROOT_PROVENANCE).toEqual({
      sessionId: '',
      agentId: '',
      toolCallId: 'root',
      turnId: 0,
      operation: 'init',
    });
  });

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

  it('fake env stats directories by prefix', () => {
    const env = new FakeExecutionEnv({});
    env.fs.writeFile('sub/b.txt', 'data');
    const dir = env.fs.stat('sub');
    expect(dir.isDirectory).toBe(true);
    expect(dir.isFile).toBe(false);
    expect(() => env.fs.stat('missing')).toThrow(/no such file/);
  });

  it('node fs renames atomically within the cwd', () => {
    const { env } = makeNodeEnv();
    env.fs.writeFile('tmp-1.txt', 'atomic');
    env.fs.rename('tmp-1.txt', 'final.txt');
    expect(env.fs.readFile('final.txt')).toBe('atomic');
    expect(() => env.fs.readFile('tmp-1.txt')).toThrow(/ENOENT|no such file/);
    expect(() => env.fs.rename('../escape.txt', 'x.txt')).toThrow(
      /cwd|confin/i,
    );
  });

  it('fake fs renames in memory', () => {
    const env = new FakeExecutionEnv({});
    env.fs.writeFile('tmp-1.txt', 'atomic');
    env.fs.rename('tmp-1.txt', 'final.txt');
    expect(env.fs.readFile('final.txt')).toBe('atomic');
    expect(() => env.fs.rename('missing.txt', 'x.txt')).toThrow(/no such file/);
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

describe('streaming + checkpoints + kill tree (issue #12, slice B)', () => {
  it('node shell streams updates while running', async () => {
    const { env } = makeNodeEnv();
    const seen: ProcessSnapshot[] = [];
    const handle = env.shell.spawn(
      process.execPath,
      ['-e', 'process.stdout.write("a");process.stdout.write("b")'],
      { provenance: PROV, onUpdate: (snap) => seen.push({ ...snap }) },
    );
    const result = await handle.wait();
    expect(result.stdout).toBe('ab');
    expect(seen.length).toBeGreaterThanOrEqual(1);
    expect(seen[seen.length - 1]?.stdout).toBe('ab');
  });

  it('fake shell emits an update', async () => {
    const env = new FakeExecutionEnv({
      'echo hi': { exitCode: 0, stdout: 'hi\n', stderr: '' },
    });
    const seen: ProcessSnapshot[] = [];
    const handle = env.shell.spawn('echo', ['hi'], {
      provenance: PROV,
      onUpdate: (snap) => seen.push(snap),
    });
    await handle.wait();
    expect(seen.length).toBeGreaterThanOrEqual(1);
  });

  it('checkpoint store throttles and change-gates', () => {
    let now = 1000;
    const store = new MemoryCheckpointStore(() => now);
    const snap = (out: string): ProcessSnapshot => ({
      stdout: out,
      stderr: '',
      exitCode: null,
    });
    store.record('k', snap('a'));
    store.record('k', snap('a'));
    expect(store.latest('k')?.stdout).toBe('a');
    now += 500;
    store.record('k', snap('b'));
    expect(store.latest('k')?.stdout).toBe('a');
    now += 2000;
    store.record('k', snap('b'));
    expect(store.latest('k')?.stdout).toBe('b');
  });

  it('node shell records the final snapshot under the checkpoint key', async () => {
    const { env } = makeNodeEnv();
    const store = new MemoryCheckpointStore();
    const handle = env.shell.spawn(
      process.execPath,
      ['-e', 'process.stdout.write("done")'],
      {
        provenance: PROV,
        checkpointKey: 'run-1',
        checkpointStore: store,
      },
    );
    await handle.wait();
    expect(store.latest('run-1')?.stdout).toBe('done');
  });

  it('node shell checkpoints mid-run while the process is still alive', async () => {
    const { env } = makeNodeEnv();
    const store = new MemoryCheckpointStore();
    const handle = env.shell.spawn(
      process.execPath,
      [
        '-e',
        'process.stdout.write("part1");setTimeout(()=>process.stdout.write("part2"),500)',
      ],
      { provenance: PROV, checkpointKey: 'run-mid', checkpointStore: store },
    );
    let mid: ProcessSnapshot | undefined;
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      const hit = store.latest('run-mid');
      if (hit && hit.exitCode === null) {
        mid = hit;
        break;
      }
      await new Promise((r) => setTimeout(r, 50));
    }
    await handle.wait();
    expect(mid?.stdout).toContain('part1');
  });

  it.runIf(process.platform !== 'win32')(
    'kill leaves no orphans in the process group',
    async () => {
      const { env } = makeNodeEnv();
      const handle = env.shell.spawn(
        process.execPath,
        [
          '-e',
          "require('child_process').spawn('sleep', ['60']);setInterval(() => {}, 1000)",
        ],
        { provenance: PROV },
      );
      await new Promise((r) => setTimeout(r, 300));
      handle.kill();
      const deadline = Date.now() + 3000;
      for (;;) {
        try {
          process.kill(-(handle.pid ?? 0), 0);
        } catch {
          break;
        }
        if (Date.now() > deadline)
          throw new Error('process group survived kill');
        await new Promise((r) => setTimeout(r, 50));
      }
    },
  );
});
