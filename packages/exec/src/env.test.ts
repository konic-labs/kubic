import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
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

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

function makeNodeEnv(): { env: ExecutionEnv; cwd: string } {
  const cwd = mkdtempSync(join(tmpdir(), 'exec-env-'));
  tempDirs.push(cwd);
  return { env: new NodeExecutionEnv(cwd), cwd };
}

// A child that blocks until the test drops a `go` file into its cwd — a
// deterministic handshake in place of a fixed sleep.
const AWAIT_GO =
  "const t=setInterval(()=>{if(require('node:fs').existsSync('go')){clearInterval(t);";
const AWAIT_GO_END = '}},5)';

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
    const env = new FakeExecutionEnv({});
    const name = `kubic-fake-hermetic-${process.pid}-${Date.now()}.txt`;
    env.fs.writeFile(name, 'data');
    expect(env.fs.readFile(name)).toBe('data');
    expect(env.fs.listDir('.')).toEqual([name]);
    // Neither the process cwd nor the fake's own cwd saw the write.
    expect(existsSync(join(process.cwd(), name))).toBe(false);
    expect(existsSync(join(env.cwd, name))).toBe(false);
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
    // At least one interim (still-running) snapshot, then the settled one.
    expect(seen.some((snap) => snap.exitCode === null)).toBe(true);
    expect(seen[seen.length - 1]).toEqual({
      stdout: 'ab',
      stderr: '',
      exitCode: 0,
      provenance: PROV,
    });
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
    expect(seen).toEqual([{ stdout: 'hi\n', stderr: '', exitCode: null }]);
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
    const { env, cwd } = makeNodeEnv();
    const store = new MemoryCheckpointStore();
    // The child cannot exit until the test releases it, so the checkpoint
    // observed below is provably mid-run.
    const handle = env.shell.spawn(
      process.execPath,
      [
        '-e',
        `process.stdout.write("part1");${AWAIT_GO}process.stdout.write("part2")${AWAIT_GO_END}`,
      ],
      { provenance: PROV, checkpointKey: 'run-mid', checkpointStore: store },
    );
    const mid = await vi.waitFor(
      () => {
        const hit = store.latest('run-mid');
        if (!hit) throw new Error('no checkpoint yet');
        return hit;
      },
      { timeout: 5000, interval: 5 },
    );
    writeFileSync(join(cwd, 'go'), '');
    const result = await handle.wait();
    expect(mid).toEqual({ stdout: 'part1', stderr: '', exitCode: null });
    expect(result.stdout).toBe('part1part2');
    expect(store.latest('run-mid')?.exitCode).toBe(0);
  });

  it.runIf(process.platform !== 'win32')(
    'kill leaves no orphans in the process group',
    async () => {
      const { env } = makeNodeEnv();
      let stdout = '';
      // The child announces its grandchild's pid once it is spawned — the
      // test waits for that instead of sleeping a fixed interval.
      const handle = env.shell.spawn(
        process.execPath,
        [
          '-e',
          "const c=require('child_process').spawn('sleep',['60']);process.stdout.write(String(c.pid));setInterval(()=>{},1000)",
        ],
        { provenance: PROV, onUpdate: (snap) => (stdout = snap.stdout) },
      );
      const groupId = handle.pid;
      expect(groupId).toBeGreaterThan(0);
      const alive = (pid: number): boolean => {
        try {
          process.kill(pid, 0);
          return true;
        } catch {
          return false;
        }
      };
      try {
        const grandchild = await vi.waitFor(
          () => {
            const pid = Number(stdout);
            if (!(pid > 0)) throw new Error('grandchild pid not reported');
            return pid;
          },
          { timeout: 5000, interval: 5 },
        );
        expect(alive(grandchild)).toBe(true);
        handle.kill();
        await handle.wait();
        await vi.waitFor(
          () => {
            if (alive(-(groupId as number)))
              throw new Error('process group survived kill');
            if (alive(grandchild)) throw new Error('grandchild survived kill');
          },
          { timeout: 3000, interval: 10 },
        );
      } finally {
        // Never leak a 60s sleeper if an assertion above failed.
        if (groupId !== undefined && alive(-groupId)) process.kill(-groupId);
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
      process.execPath,
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
      process.execPath,
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

// Issue #112: pipe chunks are arbitrary byte slices. Decoding each chunk
// with Buffer.toString() independently corrupts any multi-byte UTF-8
// codepoint split across a chunk boundary (U+FFFD on both sides of the
// split). The seam must decode through one StringDecoder per stream — the
// decoder carries split codepoints across writes — and flush a trailing
// incomplete sequence via decoder.end() on settle.
describe('multi-byte UTF-8 chunk boundaries (issue #112)', () => {
  // One emoji as two explicit Buffer halves. The child writes the second
  // half only after the parent has seen the first as its own `data` event
  // (the `go` handshake) — back-to-back writes can coalesce into a single
  // chunk and never exercise the boundary at all.
  const EMOJI = '\u{1F600}';
  const emojiBytes = [...Buffer.from(EMOJI, 'utf8')]; // f0 9f 98 80
  const firstHalf = emojiBytes.slice(0, 2);
  const secondHalf = emojiBytes.slice(2);
  const splitWrite = (stream: 'stdout' | 'stderr'): string =>
    `process.${stream}.write(Buffer.from([${firstHalf.join(',')}]));` +
    `${AWAIT_GO}process.${stream}.write(Buffer.from([${secondHalf.join(',')}]))${AWAIT_GO_END}`;
  // Release the child on the first data event (the first half, alone).
  const releaseOnFirstChunk = (cwd: string) => () => {
    const go = join(cwd, 'go');
    if (!existsSync(go)) writeFileSync(go, '');
  };

  it('reassembles a stdout codepoint split across two data events', async () => {
    const { env, cwd } = makeNodeEnv();
    const handle = env.shell.spawn(
      process.execPath,
      ['-e', splitWrite('stdout')],
      { provenance: PROV, onUpdate: releaseOnFirstChunk(cwd) },
    );
    const result = await handle.wait();
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe(EMOJI);
    expect(result.stdout).not.toContain('\uFFFD');
  });

  it('reassembles a stderr codepoint split across two data events', async () => {
    const { env, cwd } = makeNodeEnv();
    const handle = env.shell.spawn(
      process.execPath,
      ['-e', splitWrite('stderr')],
      { provenance: PROV, onUpdate: releaseOnFirstChunk(cwd) },
    );
    const result = await handle.wait();
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe(EMOJI);
    expect(result.stderr).not.toContain('\uFFFD');
  });

  it('flushes a trailing incomplete byte sequence at exit without throwing', async () => {
    // The child ends mid-codepoint (the exit-time case of a mid-write kill):
    // the decoder still holds the two partial bytes at 'close' and must
    // flush them via decoder.end() — as U+FFFD — instead of dropping them
    // or throwing.
    const { env } = makeNodeEnv();
    const handle = env.shell.spawn(
      process.execPath,
      [
        '-e',
        `process.stdout.write("ok");process.stdout.write(Buffer.from([${firstHalf.join(',')}]))`,
      ],
      { provenance: PROV },
    );
    const result = await handle.wait();
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('ok\uFFFD');
  });
});
