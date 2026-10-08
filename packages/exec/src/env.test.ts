import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ExecutionEnv, ProcessSnapshot, Provenance } from './env.js';
import {
  argvKey,
  FakeExecutionEnv,
  MAX_CHILD_OUTPUT_BYTES,
  MemoryCheckpointStore,
  NodeExecutionEnv,
  ROOT_PROVENANCE,
  toolSpawnEnv,
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

describe('execution env', () => {
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

describe('FakeExecutionEnv calls log + strict mode', () => {
  it('logs every spawn with cmd, args and provenance', async () => {
    const env = new FakeExecutionEnv(
      {
        'git rev-parse --show-toplevel': {
          exitCode: 0,
          stdout: '/repo\n',
          stderr: '',
        },
      },
      { allowUnscripted: true },
    );
    await env.shell
      .spawn('git', ['rev-parse', '--show-toplevel'], { provenance: PROV })
      .wait();
    // Unscripted argv still exits 0 outside strict mode — but is logged.
    await env.shell.spawn('git', ['status'], { provenance: PROV }).wait();
    expect(env.calls).toEqual([
      {
        cmd: 'git',
        args: ['rev-parse', '--show-toplevel'],
        provenance: PROV,
      },
      { cmd: 'git', args: ['status'], provenance: PROV },
    ]);
  });

  it('strict mode throws on unscripted argv, naming it', async () => {
    const env = new FakeExecutionEnv(
      { 'git status': { exitCode: 0, stdout: '', stderr: '' } },
      { strict: true },
    );
    await env.shell.spawn('git', ['status'], { provenance: PROV }).wait();
    expect(() =>
      env.shell.spawn('git', ['branch', '-D', 'kubic/agent-1'], {
        provenance: PROV,
      }),
    ).toThrow(/no script for argv: git branch -D kubic\/agent-1/);
    // The refused call is still logged.
    expect(env.calls).toHaveLength(2);
  });

  it('strict mode survives withProvenance', () => {
    const env = new FakeExecutionEnv(
      { 'git status': { exitCode: 0, stdout: '', stderr: '' } },
      { strict: true },
    );
    const scoped = env.withProvenance({ ...PROV, agentId: 'a2' });
    expect(() =>
      scoped.shell.spawn('git', ['fetch'], { provenance: PROV }),
    ).toThrow(/no script for argv/);
  });

  it('lenient exit 0 on unscripted argv needs an explicit opt-out', async () => {
    const env = new FakeExecutionEnv({}, { allowUnscripted: true });
    const result = await env.shell
      .spawn('anything', ['at', 'all'], { provenance: PROV })
      .wait();
    expect(result.exitCode).toBe(0);
    expect(env.calls).toEqual([
      { cmd: 'anything', args: ['at', 'all'], provenance: PROV },
    ]);
  });
});

describe('FakeExecutionEnv argv keys + strict default + byte fs', () => {
  it('argvKey distinguishes a single message element from a split one', () => {
    expect(argvKey('git', 'commit', '-m', 'work in progress')).not.toBe(
      argvKey('git', 'commit', '-m', 'work', 'in', 'progress'),
    );
  });

  it('matches scripts on the argv array, not the joined string', async () => {
    const env = new FakeExecutionEnv({
      [argvKey('git', 'commit', '-m', 'work in progress')]: {
        exitCode: 0,
        stdout: 'ok',
        stderr: '',
      },
    });
    const single = await env.shell
      .spawn('git', ['commit', '-m', 'work in progress'], {
        provenance: PROV,
      })
      .wait();
    expect(single.stdout).toBe('ok');
    // The split argv serializes to a different key: strict-by-default
    // throws instead of answering from the single-message script.
    expect(() =>
      env.shell.spawn('git', ['commit', '-m', 'work', 'in', 'progress'], {
        provenance: PROV,
      }),
    ).toThrow(/no script for argv/);
  });

  it('is strict by default: unscripted spawns throw', () => {
    const env = new FakeExecutionEnv({});
    expect(() =>
      env.shell.spawn('git', ['status'], { provenance: PROV }),
    ).toThrow(/no script for argv: git status/);
  });

  it('explicit strict:false opts out', async () => {
    const env = new FakeExecutionEnv({}, { strict: false });
    const result = await env.shell
      .spawn('git', ['status'], { provenance: PROV })
      .wait();
    expect(result.exitCode).toBe(0);
  });

  it('legacy joined keys still resolve', async () => {
    const env = new FakeExecutionEnv(
      { 'git status': { exitCode: 0, stdout: 's', stderr: '' } },
      { allowUnscripted: true },
    );
    const out = await env.shell
      .spawn('git', ['status'], { provenance: PROV })
      .wait();
    expect(out.stdout).toBe('s');
  });

  it('stat sizes are bytes and carry modes', () => {
    const env = new FakeExecutionEnv({}, { allowUnscripted: true });
    env.fs.writeFile('uni.txt', 'h\u00e9llo\n');
    env.fs.writeFile('sub/b.txt', 'x');
    const file = env.fs.stat('uni.txt');
    expect(file.isFile).toBe(true);
    expect(file.size).toBe(7);
    expect(file.mode).toBe(0o644);
    const dir = env.fs.stat('sub');
    expect(dir.isDirectory).toBe(true);
    expect(dir.size).toBe(1);
    expect(dir.mode).toBe(0o755);
  });

  it('readFileRange returns byte windows', () => {
    const env = new FakeExecutionEnv({}, { allowUnscripted: true });
    env.fs.writeFile('a.txt', 'h\u00e9llo\nworld\n');
    const range = env.fs.readFileRange;
    expect(range).toBeDefined();
    // 'h' (1 byte) + 'é' (2 bytes in UTF-8).
    expect(Buffer.from(range?.('a.txt', 0, 3) ?? []).toString('utf8')).toBe(
      'h\u00e9',
    );
    // Past-EOF clamps instead of throwing.
    expect(Buffer.from(range?.('a.txt', 7, 999) ?? []).toString('utf8')).toBe(
      'world\n',
    );
    expect(range?.('a.txt', 5, 5)).toHaveLength(0);
    expect(() => range?.('missing.txt', 0, 3)).toThrow(/no such file/);
  });
});

describe('streaming + checkpoints + kill tree', () => {
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

  it.runIf(process.platform !== 'win32')(
    'kill escalates to SIGKILL when the group ignores SIGTERM',
    async () => {
      const { env } = makeNodeEnv();
      let stdout = '';
      // A child that traps SIGTERM (a shell `trap '' TERM`, a server with a
      // shutdown handler that hangs) must still die: kill() is the abort/
      // timeout path, and a SIGTERM-only kill leaves wait() hung forever.
      const handle = env.shell.spawn(
        process.execPath,
        [
          '-e',
          "process.on('SIGTERM',()=>{});process.stdout.write('ready');setInterval(()=>{},1000)",
        ],
        {
          provenance: PROV,
          killGraceMs: 50,
          onUpdate: (snap) => (stdout = snap.stdout),
        },
      );
      const groupId = handle.pid as number;
      try {
        await vi.waitFor(
          () => {
            if (stdout !== 'ready') throw new Error('not ready');
          },
          { timeout: 5000, interval: 5 },
        );
        handle.kill();
        const settled = await Promise.race([
          handle.wait().then(() => 'settled'),
          new Promise((r) => setTimeout(() => r('hung'), 3000)),
        ]);
        expect(settled).toBe('settled');
      } finally {
        try {
          process.kill(-groupId, 'SIGKILL');
        } catch {
          // Already gone.
        }
      }
    },
  );
});

describe('a settled process handle', () => {
  it.runIf(process.platform !== 'win32')(
    'kill() is a no-op: it never signals a group whose pid may be recycled',
    async () => {
      const { env } = makeNodeEnv();
      const handle = env.shell.spawn(process.execPath, ['-e', ''], {
        provenance: PROV,
      });
      await handle.wait();
      const signalled: Array<[number, unknown]> = [];
      const spy = vi.spyOn(process, 'kill').mockImplementation(((
        pid: number,
        signal?: string | number,
      ) => {
        signalled.push([pid, signal]);
        return true;
      }) as typeof process.kill);
      try {
        handle.kill();
      } finally {
        spy.mockRestore();
      }
      expect(signalled).toEqual([]);
    },
  );

  it.runIf(process.platform !== 'win32')(
    'kill() does not schedule a group SIGKILL once the leader has exited',
    async () => {
      const { env } = makeNodeEnv();
      // The leader exits at once but leaves a background member holding the
      // inherited pipes, so the handle stays unsettled through its drain
      // window (EXIT_DRAIN_MS), the exact window in which a kill() must not
      // schedule a group SIGKILL for a leader that no longer owns a group.
      const leader = [
        "require('node:child_process')",
        ".spawn(process.execPath,['-e','setInterval(()=>{},1000)'],",
        "{stdio:['ignore','inherit','inherit']})",
        '.unref();',
      ].join('');
      const handle = env.shell.spawn(process.execPath, ['-e', leader], {
        provenance: PROV,
        killGraceMs: 5,
      });
      const pid = handle.pid;
      expect(typeof pid).toBe('number');
      // Wait until the LEADER is gone — reaped, so its pid owns no group any
      // more. The probe is the same one the handle's gate uses, so the test
      // and the code agree on "the leader is dead"; a bounded poll on the
      // OS's own condition, never a fixed sleep for synchronization.
      const deadline = Date.now() + 2000;
      for (;;) {
        try {
          process.kill(pid as number, 0);
        } catch {
          break;
        }
        if (Date.now() > deadline) throw new Error('child never exited');
        await new Promise((resolveTick) => setTimeout(resolveTick, 5));
      }
      const signalled: Array<[number, unknown]> = [];
      const realKill = process.kill.bind(process);
      const spy = vi.spyOn(process, 'kill').mockImplementation(((
        signalledPid: number,
        signal?: string | number,
      ) => {
        // A liveness probe (signal 0) must answer truthfully — the handle
        // asks the OS whether the leader is still there — while every real
        // signal is recorded instead of sent.
        if (signal === 0) return realKill(signalledPid, 0);
        signalled.push([signalledPid, signal]);
        return true;
      }) as typeof process.kill);
      // The escalation is the only timer kill() schedules, so observing the
      // timers it registers is deterministic: waiting for a SIGKILL that
      // must not come would race the drain window (and let the settle path's
      // own reap be recorded instead).
      const realSetTimeout = globalThis.setTimeout;
      const timers: number[] = [];
      const timerSpy = vi.spyOn(globalThis, 'setTimeout').mockImplementation(((
        fn: () => void,
        ms?: number,
        ...args: unknown[]
      ) => {
        timers.push(ms ?? 0);
        return realSetTimeout(fn, ms, ...args);
      }) as typeof setTimeout);
      try {
        handle.kill();
      } finally {
        timerSpy.mockRestore();
        spy.mockRestore();
        // The pipe holder must not outlive the test even when an assertion
        // above throws: the settle path reaps it, and this makes it certain.
        try {
          realKill(-(pid as number), 'SIGKILL');
        } catch {
          // Already gone.
        }
      }
      // A dead leader owns no group: the SIGTERM attempt is harmless (ESRCH
      // when the group is gone), but the delayed group SIGKILL — the one
      // that could hit a recycled pgid — must not even be scheduled.
      expect(timers).not.toContain(5);
      expect(signalled.filter(([, signal]) => signal === 'SIGKILL')).toEqual(
        [],
      );
      // Settling reaps whatever the group still held (the pipe holder).
      await handle.wait();
    },
  );
});

describe('execution env spawn failures', () => {
  it('settles wait() with a named error instead of crashing on a missing binary', async () => {
    // A spawn that cannot start the child emits 'error' (ENOENT) and never
    // 'close'. Without a handler Node re-throws it as an uncaught
    // exception, so the caller dies raw: no
    // exit code, no exit code line. wait() must settle with exit 127 and
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

// Child output is capped per stream at the shell seam. A
// chatty child (`yes`, a verbose build, a giant cat) must not OOM the
// run: accumulation keeps the TAIL (endings carry the error) and names
// the dropped leading bytes in a header on the final result.
describe('child output caps', () => {
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

  // Past the cap a snapshot keeps its length while its head
  // moves; the dropped count says where it starts, so a reader following
  // the stream (the worker fact scanner) never misses or repeats output.
  it('says how much of each stream a live snapshot dropped', async () => {
    const { env } = makeNodeEnv();
    const positions: Array<{ end: number; text: string; dropped: number }> = [];
    const handle = env.shell.spawn(
      process.execPath,
      [
        '-e',
        `let i = 0; const t = setInterval(() => { process.stdout.write('line ' + i + '\\n'); if (++i === 200) clearInterval(t); }, 1);`,
      ],
      {
        provenance: PROV,
        maxOutputBytes: 300,
        onUpdate: (snapshot) => {
          if (snapshot.exitCode !== null) return;
          const dropped = snapshot.dropped?.stdout ?? 0;
          positions.push({
            end: dropped + snapshot.stdout.length,
            text: snapshot.stdout,
            dropped,
          });
        },
      },
    );
    await handle.wait();
    const last = positions.at(-1);
    expect(last?.dropped ?? 0).toBeGreaterThan(0);
    // The stream position only grows, and the kept text is the true tail of
    // everything written up to it.
    const written = Array.from({ length: 200 }, (_, i) => `line ${i}\n`).join(
      '',
    );
    for (let i = 0; i < positions.length; i += 1) {
      const at = positions[i];
      if (at === undefined) continue;
      expect(written.slice(at.dropped, at.end)).toBe(at.text);
      if (i > 0) expect(at.end).toBeGreaterThan(positions[i - 1]?.end ?? 0);
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

// The cap is documented in BYTES, but the accumulator compared
// UTF-16 code units — so CJK/emoji output admitted up to ~3x the intended
// memory (a 3-byte character cost 1 unit), the header misstated the dropped
// size, and slice(-cap) could start the kept tail with half a surrogate
// pair (a lone low surrogate, which reaches the model and the session store
// as U+FFFD). Bytes are the bound; code points are the trim boundary.
const CAP_HEADER =
  /^\[kubic: output truncated — dropped (\d+) leading bytes, kept the last (\d+)\]\n/;

function cappedTail(stdout: string): {
  dropped: number;
  kept: number;
  tail: string;
} {
  const match = stdout.match(CAP_HEADER);
  expect(match).not.toBeNull();
  const head = match as RegExpMatchArray;
  return {
    dropped: Number(head[1]),
    kept: Number(head[2]),
    tail: stdout.slice(head[0].length),
  };
}

describe('child output caps count bytes', () => {
  it('keeps at most maxOutputBytes of UTF-8, not of UTF-16 units', async () => {
    const { env } = makeNodeEnv();
    // 100 three-byte characters: 300 UTF-8 bytes, 100 UTF-16 units.
    const handle = env.shell.spawn(
      process.execPath,
      ['-e', `process.stdout.write('日'.repeat(100))`],
      { provenance: PROV, maxOutputBytes: 10 },
    );
    const result = await handle.wait();
    const { kept, tail } = cappedTail(result.stdout);
    expect(Buffer.byteLength(tail, 'utf8')).toBeLessThanOrEqual(10);
    // 3 whole characters fit; the tenth byte would cut one in half.
    expect(kept).toBe(9);
    expect(tail).toBe('日日日');
    expect(tail).not.toContain('\uFFFD');
  });

  it("reports the header's dropped and kept counts in bytes", async () => {
    const { env } = makeNodeEnv();
    const total = Buffer.byteLength('日'.repeat(100), 'utf8');
    const handle = env.shell.spawn(
      process.execPath,
      ['-e', `process.stdout.write('日'.repeat(100))`],
      { provenance: PROV, maxOutputBytes: 10 },
    );
    const result = await handle.wait();
    const { dropped, kept, tail } = cappedTail(result.stdout);
    const tailBytes = Buffer.byteLength(tail, 'utf8');
    // Both numbers describe the same units the cap does: bytes.
    expect(kept).toBe(tailBytes);
    expect(dropped).toBe(total - tailBytes);
  });

  it('never starts the kept tail with half a surrogate pair', async () => {
    const { env } = makeNodeEnv();
    // 100 four-byte emoji: 4 UTF-8 bytes, 2 UTF-16 units each.
    const four = env.shell.spawn(
      process.execPath,
      ['-e', `process.stdout.write('😀'.repeat(100))`],
      { provenance: PROV, maxOutputBytes: 4 },
    );
    const fourResult = await four.wait();
    const whole = cappedTail(fourResult.stdout);
    // Exactly one complete code point fits in four bytes.
    expect(whole.tail).toBe('😀');
    expect(whole.kept).toBe(4);
    // A cap of three cannot hold an emoji: the tail is empty, never a
    // dangling low surrogate, as slice(-3) would produce.
    const three = env.shell.spawn(
      process.execPath,
      ['-e', `process.stdout.write('😀'.repeat(100))`],
      { provenance: PROV, maxOutputBytes: 3 },
    );
    const threeResult = await three.wait();
    const partial = cappedTail(threeResult.stdout);
    expect(partial.tail).toBe('');
    expect(partial.dropped).toBe(400);
    expect(/^[\uDC00-\uDFFF]/.test(partial.tail)).toBe(false);
  });
});

// Pipe chunks are arbitrary byte slices. Decoding each chunk
// with Buffer.toString() independently corrupts any multi-byte UTF-8
// codepoint split across a chunk boundary (U+FFFD on both sides of the
// split). The seam must decode through one StringDecoder per stream — the
// decoder carries split codepoints across writes — and flush a trailing
// incomplete sequence via decoder.end() on settle.
describe('multi-byte UTF-8 chunk boundaries', () => {
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

// Tool processes never inherit ambient authority. A provider key in
// kubic's own environment must not reach a spawned child.
describe('tool child env allowlist', () => {
  const planted = [
    'FAKE_PROVIDER_API_KEY',
    'ANTHROPIC_API_KEY',
    'GITHUB_TOKEN',
    'AWS_SECRET_ACCESS_KEY',
    'LC_SECRET_KEY',
  ];
  const saved = new Map<string, string | undefined>();

  afterEach(() => {
    for (const [k, v] of saved) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    saved.clear();
  });

  it('a spawned child sees the allowlisted base, never credentials', async () => {
    for (const k of [...planted, 'LC_TIME']) saved.set(k, process.env[k]);
    for (const k of planted) process.env[k] = 'sk-leak';
    process.env.LC_TIME = 'C';
    const { env } = makeNodeEnv();
    const handle = env.shell.spawn(
      process.execPath,
      ['-e', 'process.stdout.write(JSON.stringify(process.env))'],
      { provenance: PROV },
    );
    const result = await handle.wait();
    const childEnv = JSON.parse(result.stdout) as Record<string, string>;
    for (const k of planted) expect(childEnv[k]).toBeUndefined();
    expect(JSON.stringify(childEnv)).not.toContain('sk-leak');
    expect(childEnv.PATH).toBe(process.env.PATH);
    expect(childEnv.LC_TIME).toBe('C');
    if (process.env.HOME !== undefined)
      expect(childEnv.HOME).toBe(process.env.HOME);
  });
});

describe('toolSpawnEnv allowlist coverage', () => {
  it('passes proxy, CA and XDG settings; secret suffixes still win', () => {
    const out = toolSpawnEnv({
      HTTP_PROXY: 'h',
      https_proxy: 'h2',
      NO_PROXY: 'n',
      no_proxy: 'n2',
      NODE_EXTRA_CA_CERTS: 'ca',
      SSL_CERT_FILE: 'f',
      SSL_CERT_DIR: 'd',
      XDG_CONFIG_HOME: 'x',
      GIT_CONFIG_NOSYSTEM: '1',
      XDG_SECRET_KEY: 'leak',
      OPENAI_API_KEY: 'leak',
    });
    expect(out).toEqual({
      HTTP_PROXY: 'h',
      https_proxy: 'h2',
      NO_PROXY: 'n',
      no_proxy: 'n2',
      NODE_EXTRA_CA_CERTS: 'ca',
      SSL_CERT_FILE: 'f',
      SSL_CERT_DIR: 'd',
      XDG_CONFIG_HOME: 'x',
      GIT_CONFIG_NOSYSTEM: '1',
    });
  });
});

// The workload-identity federation keys carry no secret suffix; only the
// explicit name list in core keeps them out of a tool child.
describe('federation identity keys in the tool env', () => {
  it('never passes the workload-identity keys to a tool child', () => {
    const out = toolSpawnEnv({
      PATH: '/usr/bin',
      ANTHROPIC_IDENTITY_TOKEN_FILE: '/run/secrets/token',
      ANTHROPIC_FEDERATION_RULE_ID: 'rule-1',
      ANTHROPIC_ORGANIZATION_ID: 'org-1',
      ANTHROPIC_SERVICE_ACCOUNT_ID: 'sa-1',
      ANTHROPIC_WORKSPACE_ID: 'ws-1',
    });
    expect(out).toEqual({ PATH: '/usr/bin' });
  });
});

// A proxy URL's userinfo (`http://user:password@proxy:3128`) is a
// credential in the sense, but the NAME looks benign, so the secret-name
// check never sees it and it reached every tool child — where the model can read it
// with `echo $HTTPS_PROXY`. The value keeps its scheme, host
// and port and loses the userinfo; a proxy that REQUIRES that auth is not
// usable from a tool child (Kubic does not broker proxy auth).
describe('proxy credentials in the tool env', () => {
  it('strips the userinfo, keeping scheme, host and port', () => {
    const out = toolSpawnEnv({
      HTTPS_PROXY: 'http://user:sekret-pass@proxy.corp:3128',
      http_proxy: 'http://u:p@h:1',
    });
    expect(out.HTTPS_PROXY).toBe('http://proxy.corp:3128');
    expect(out.http_proxy).toBe('http://h:1');
    expect(JSON.stringify(out)).not.toContain('sekret-pass');
    expect(JSON.stringify(out)).not.toContain('@');
  });

  it('passes a proxy URL without userinfo through unchanged', () => {
    const out = toolSpawnEnv({
      HTTPS_PROXY: 'http://proxy.corp:3128',
      http_proxy: 'socks5h://proxy.corp:1080',
      NO_PROXY: 'localhost,127.0.0.1',
      no_proxy: 'localhost,127.0.0.1',
    });
    expect(out).toEqual({
      HTTPS_PROXY: 'http://proxy.corp:3128',
      http_proxy: 'socks5h://proxy.corp:1080',
      NO_PROXY: 'localhost,127.0.0.1',
      no_proxy: 'localhost,127.0.0.1',
    });
  });

  it('handles the shapes a proxy value can take', () => {
    const out = toolSpawnEnv({
      // No scheme: the whole value is the authority.
      HTTP_PROXY: 'user:sekret@proxy.corp:3128',
      // Userinfo with no password.
      http_proxy: 'http://user@proxy.corp:3128',
      // Path and query survive the strip.
      HTTPS_PROXY: 'http://u:sekret@proxy.corp:3128/path?x=1',
      // An '@' that is not userinfo stays put.
      NO_PROXY: 'proxy.corp/@scope',
      // Percent-encoded userinfo is still userinfo.
      https_proxy: 'http://u%40x:sekret@proxy.corp:3128',
    });
    expect(out).toEqual({
      HTTP_PROXY: 'proxy.corp:3128',
      http_proxy: 'http://proxy.corp:3128',
      HTTPS_PROXY: 'http://proxy.corp:3128/path?x=1',
      NO_PROXY: 'proxy.corp/@scope',
      https_proxy: 'http://proxy.corp:3128',
    });
    expect(JSON.stringify(out)).not.toContain('sekret');
  });

  it('strips a scheme-less value whose path contains :// (never fails open)', () => {
    // Anchoring the scheme at position 0 is what keeps this from returning
    // the value untouched: searching the whole string for '://' sliced the
    // "authority" out of the path and missed the '@' entirely.
    const out = toolSpawnEnv({
      HTTP_PROXY: 'user:sekret@proxy.corp:3128/path://x',
    });
    expect(out.HTTP_PROXY).toBe('proxy.corp:3128/path://x');
    expect(JSON.stringify(out)).not.toContain('sekret');
  });
});

describe('kill escalation reaches the whole group', () => {
  it.runIf(process.platform !== 'win32')(
    'SIGKILLs group members that ignore SIGTERM even after the leader exits',
    async () => {
      const { env, cwd } = makeNodeEnv();
      let stdout = '';
      // Leader dies on SIGTERM; its grandchild ignores SIGTERM and has its
      // stdio detached, so the leader's close settles the handle early.
      const handle = env.shell.spawn(
        process.execPath,
        [
          '-e',
          "const c=require('child_process').spawn(process.execPath,['-e',\"process.on('SIGTERM',()=>{});require('fs').writeFileSync('gc-ready','');setInterval(()=>{},1000)\"],{stdio:'ignore'});process.stdout.write(String(c.pid));setInterval(()=>{},1000)",
        ],
        {
          provenance: PROV,
          killGraceMs: 50,
          onUpdate: (snap) => (stdout = snap.stdout),
        },
      );
      const groupId = handle.pid as number;
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
            if (!(pid > 0)) throw new Error('no pid yet');
            return pid;
          },
          { timeout: 5000, interval: 5 },
        );
        // The grandchild's SIGTERM handler is installed before the kill.
        await vi.waitFor(
          () => {
            if (!existsSync(join(cwd, 'gc-ready')))
              throw new Error('not ready');
          },
          { timeout: 5000, interval: 5 },
        );
        expect(alive(grandchild)).toBe(true);
        handle.kill();
        await handle.wait();
        await vi.waitFor(
          () => {
            if (alive(grandchild)) throw new Error('grandchild survived');
          },
          { timeout: 3000, interval: 20 },
        );
      } finally {
        try {
          process.kill(-groupId, 'SIGKILL');
        } catch {
          // Gone.
        }
      }
    },
  );
});
