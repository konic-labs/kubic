import { mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ExecutionEnv, ProcessSnapshot, Provenance } from './env.js';
import {
  FakeExecutionEnv,
  MAX_CHILD_OUTPUT_BYTES,
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

describe('execution env spawn failures (issue #85)', () => {
  it('settles wait() with a named error instead of crashing on a missing binary', async () => {
    // A spawn that cannot start the child emits 'error' (ENOENT) and never
    // 'close'. Without a handler Node re-throws it as an uncaught
    // exception, so the caller (the orchestrator manager) dies raw: no
    // exit code, no §78 code line. wait() must settle with exit 127 and
    // the reason on stderr instead.
    const { env } = makeNodeEnv();
    const handle = env.shell.spawn('kubic-no-such-binary-xyz', [], {
      provenance: PROV,
    });
    const result = await handle.wait();
    expect(result.exitCode).toBe(127);
    expect(result.stderr).toMatch(/ENOENT/);
    expect(result.stderr).toMatch(/kubic-no-such-binary-xyz/);
    expect(result.provenance).toEqual(PROV);
  });

  it('reports the spawn reason through onUpdate as well', async () => {
    const { env } = makeNodeEnv();
    const seen: string[] = [];
    const handle = env.shell.spawn('kubic-no-such-binary-xyz', [], {
      provenance: PROV,
      onUpdate: (snapshot) => {
        if (snapshot.stderr !== '') seen.push(snapshot.stderr);
      },
    });
    await handle.wait();
    expect(seen.join('\n')).toMatch(/ENOENT/);
  });
});

// Issue #121: child output is capped per stream at the shell seam. A
// chatty child (`yes`, a verbose build, a giant cat) must not OOM the
// run: accumulation keeps the TAIL (endings carry the error) and names
// the dropped leading bytes in a header on the final result.
describe('child output caps (issue #121)', () => {
  it('caps stdout at the default bound, keeps the tail, and names the drop', async () => {
    const { env } = makeNodeEnv();
    const total = MAX_CHILD_OUTPUT_BYTES + 2 * 1024 * 1024;
    const handle = env.shell.spawn(
      'node',
      [
        '-e',
        `process.stdout.write('a'.repeat(${total})); process.stdout.write('TAIL-END')`,
      ],
      { provenance: PROV },
    );
    const result = await handle.wait();
    expect(result.exitCode).toBe(0);
    // Header line + kept tail: never more than the cap plus the header.
    expect(result.stdout.length).toBeLessThanOrEqual(
      MAX_CHILD_OUTPUT_BYTES + 200,
    );
    expect(result.stdout).toMatch(
      new RegExp(
        `^\\[kubic: output truncated — dropped ${total + 'TAIL-END'.length - MAX_CHILD_OUTPUT_BYTES} leading bytes, kept the last`,
      ),
    );
    // The tail is the whole point: the sentinel survives.
    expect(result.stdout.endsWith('TAIL-END')).toBe(true);
  });

  it('honours a per-spawn maxOutputBytes override on both streams independently', async () => {
    const { env } = makeNodeEnv();
    const snapshotLengths: number[] = [];
    const handle = env.shell.spawn(
      'node',
      [
        '-e',
        `process.stdout.write('o'.repeat(3000)); process.stdout.write('OUT-TAIL'); ` +
          `process.stderr.write('e'.repeat(4000)); process.stderr.write('ERR-TAIL')`,
      ],
      {
        provenance: PROV,
        maxOutputBytes: 500,
        onUpdate: (snapshot) => {
          // The final close-path update announces the SETTLED result (header
          // + tail) — the interim snapshots (exitCode null) are the live
          // accumulator, and THAT is what the cap must bound.
          if (snapshot.exitCode === null) {
            snapshotLengths.push(
              snapshot.stdout.length,
              snapshot.stderr.length,
            );
          }
        },
      },
    );
    const result = await handle.wait();
    // Final results: header + tail, capped.
    expect(result.stdout).toMatch(
      /^\[kubic: output truncated — dropped 2508 leading bytes, kept the last 500\]/,
    );
    expect(result.stdout.endsWith('OUT-TAIL')).toBe(true);
    expect(result.stderr).toMatch(
      /^\[kubic: output truncated — dropped 3508 leading bytes, kept the last 500\]/,
    );
    expect(result.stderr.endsWith('ERR-TAIL')).toBe(true);
    // Even the live accumulation never exceeded the cap (the accumulator
    // is the thing the cap exists to bound — progress snapshots included).
    for (const length of snapshotLengths) {
      expect(length).toBeLessThanOrEqual(500);
    }
  });

  it('leaves under-cap output byte-identical with no header', async () => {
    const { env } = makeNodeEnv();
    const handle = env.shell.spawn('echo', ['tiny'], { provenance: PROV });
    const result = await handle.wait();
    expect(result.stdout).toBe('tiny\n');
    expect(result.stdout).not.toMatch(/\[kubic: output truncated/);
  });
});
