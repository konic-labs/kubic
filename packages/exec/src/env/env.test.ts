import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { argvKey, MemoryCheckpointStore } from '../test-support/env-fakes.js';
import { FakeExecutionEnv } from '../test-support/fake-env.js';
import type { ExecutionEnv, ProcessSnapshot, Provenance } from './contracts.js';
import { ROOT_PROVENANCE } from './contracts.js';
import { NodeExecutionEnv } from './node-env.js';

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
    // Every field is asserted exactly.
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

  it('joined-string script keys resolve too', async () => {
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
      // window (OUTPUT_DRAIN_MS), the exact window in which a kill() must not
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
