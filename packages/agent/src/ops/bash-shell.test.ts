// The tool is named bash and the prompts say bash — the op
// must run bash when the system has it, degrade once to sh when it does
// not, and say which shell actually ran (BashResult.shell). Resolution is
// cached per process; detection and execution both go through
// ctx.env.shell so FakeExecutionEnv scripts the answer — no
// child_process in ops.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  ExecutionEnv,
  ProcessHandle,
  Shell,
  ShellResult,
  SpawnOptions,
} from '@kubic/exec/env';
import { NodeExecutionEnv, ROOT_PROVENANCE } from '@kubic/exec/env';
import type { FakeScript } from '@kubic/exec/test-support/fake-env';
import { FakeExecutionEnv } from '@kubic/exec/test-support/fake-env';
import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import { createInvocation, MemoryMemoStore } from './memos.js';
import type {
  JsonValue,
  MemoStore,
  OpContext,
  ToolInvocation,
} from './types.js';

function wrapShell(inner: FakeExecutionEnv, shell: Shell): ExecutionEnv {
  return {
    cwd: inner.cwd,
    fs: inner.fs,
    shell,
    provenance: inner.provenance,
    withProvenance: () => wrapShell(inner, shell),
  };
}

// Fake-env call log: the fake scripts the answers, the wrapper records
// every spawn the op makes (asserted as the key FakeExecutionEnv uses).
function recordingEnv(scripts: Record<string, FakeScript>): {
  env: ExecutionEnv;
  calls: string[];
} {
  const inner = new FakeExecutionEnv(scripts);
  const calls: string[] = [];
  const shell: Shell = {
    spawn: (cmd, args, options) => {
      calls.push(`${cmd} ${args.join(' ')}`);
      return inner.shell.spawn(cmd, args, options);
    },
  };
  return { env: wrapShell(inner, shell), calls };
}

function ctxFor(env: ExecutionEnv, extra?: Partial<OpContext>): OpContext {
  return { env, sessionId: 's1', agentId: 'a1', ...extra };
}

function inv(
  id: string,
  store: MemoStore = new MemoryMemoStore(),
): ToolInvocation {
  return createInvocation(
    { invocationId: id, operationId: 'op-1', turnId: 't-1' },
    store,
  );
}

// env.ts's spawn-ENOENT hardening settles wait() with Node's
// `spawn <path> ENOENT` message line — the production shape when the
// bash BINARY is missing (the only shape the detector may match).
const BASH_MISSING: FakeScript = {
  exitCode: 127,
  stdout: '',
  stderr: 'spawn bash ENOENT\n',
};

// A user typo INSIDE a running bash: the command settles 127 with bash's
// ordinary "command not found". This is not a missing bash binary and
// must never trigger the sh-retry.
const INNER_COMMAND_NOT_FOUND: FakeScript = {
  exitCode: 127,
  stdout: '',
  stderr: 'bash: nonexistentcmd123: command not found',
};

const OK_HI: FakeScript = { exitCode: 0, stdout: 'hi\n', stderr: '' };

// Scripted handles where 'hang' never settles until kill() — the only way
// to exercise timeout/abort kill routing through the seam without a real
// child (FakeExecutionEnv settles instantly).
class HangShell implements Shell {
  readonly calls: string[] = [];
  readonly killed: string[] = [];
  private readonly scripts: Record<string, FakeScript | 'hang'>;

  constructor(scripts: Record<string, FakeScript | 'hang'>) {
    this.scripts = scripts;
  }

  spawn(cmd: string, args: string[], options: SpawnOptions): ProcessHandle {
    const key = `${cmd} ${args.join(' ')}`;
    this.calls.push(key);
    const script = this.scripts[key];
    if (script === undefined) {
      throw new Error(`HangShell: unscripted spawn: ${key}`);
    }
    if (script !== 'hang') {
      return {
        pid: undefined,
        wait: () =>
          Promise.resolve({ ...script, provenance: options.provenance }),
        kill: () => {
          this.killed.push(key);
        },
      };
    }
    let settle: (result: ShellResult) => void = () => undefined;
    const done = new Promise<ShellResult>((resolve) => {
      settle = resolve;
    });
    return {
      pid: undefined,
      wait: () => done,
      kill: () => {
        this.killed.push(key);
        settle({
          exitCode: 137,
          stdout: '',
          stderr: '',
          provenance: options.provenance,
        });
      },
    };
  }
}

const scratchDirs: string[] = [];

afterAll(() => {
  for (const dir of scratchDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function scratch(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  scratchDirs.push(dir);
  return dir;
}

// Real-child probes run through the same seam the op uses.
async function bashPresent(): Promise<boolean> {
  const env = new NodeExecutionEnv(scratch('bash-probe-'));
  const result = await env.shell
    .spawn('bash', ['-c', 'true'], { provenance: ROOT_PROVENANCE })
    .wait();
  return result.exitCode === 0;
}

const HAS_BASH = await bashPresent();

describe('bash shell resolution', () => {
  beforeEach(() => {
    // Each case gets a fresh registry, so the per-process shell resolution starts unset.
    vi.resetModules();
  });

  it('falls back to sh and succeeds on the spawn-ENOENT shape', async () => {
    const { env, calls } = recordingEnv({
      'bash -c echo hi': BASH_MISSING,
      'sh -c echo hi': OK_HI,
    });
    const out = await (await import('./registry.js')).callOperation(
      'bash',
      { command: 'echo hi' },
      inv('inv-sh-miss'),
      ctxFor(env),
    );
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.result.exitCode).toBe(0);
    expect(out.result.stdout).toBe('hi\n');
    expect(out.result.shell).toBe('sh');
    expect(calls).toEqual(['bash -c echo hi', 'sh -c echo hi']);
  });

  it('does not retry (or poison the cache) on bash inner "command not found"', async () => {
    const { env, calls } = recordingEnv({
      'bash -c nonexistentcmd123': INNER_COMMAND_NOT_FOUND,
      'bash -c echo two': { exitCode: 0, stdout: 'two\n', stderr: '' },
    });
    const c = ctxFor(env);
    const first = await (await import('./registry.js')).callOperation(
      'bash',
      { command: 'nonexistentcmd123' },
      inv('inv-typo1'),
      c,
    );
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    // The 127 is the command's, not the spawn's: no sh retry, no
    // resolvedShell cache write, and BashResult.shell stays truthful.
    expect(first.result.exitCode).toBe(127);
    expect(first.result.stderr).toBe(
      'bash: nonexistentcmd123: command not found',
    );
    expect(first.result.shell).toBe('bash');
    // Second invocation still spawns bash — the resolution cache was not
    // poisoned to 'sh' by the typo (asserted via the fake-env call log).
    const second = await (await import('./registry.js')).callOperation(
      'bash',
      { command: 'echo two' },
      inv('inv-typo2'),
      c,
    );
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.result.shell).toBe('bash');
    expect(calls).toEqual(['bash -c nonexistentcmd123', 'bash -c echo two']);
  });

  // Regression: user command output is
  // NOT a spawn failure. A command that prints exactly the line
  // 'bash: not found' to stderr and exits 127 must not fall back to sh
  // (double side effects) or poison the per-process resolution cache —
  // that text has no production emitter; only Node's `spawn <name> ENOENT`
  // marks a missing bash binary.
  it('does not fall back on user output "bash: not found" (exit 127)', async () => {
    const { env, calls } = recordingEnv({
      'bash -c echo-hostile': {
        exitCode: 127,
        stdout: '',
        stderr: 'bash: not found\n',
      },
      'sh -c echo-hostile': {
        exitCode: 0,
        stdout: 'FALLBACK-RAN',
        stderr: '',
      },
      'bash -c echo two': { exitCode: 0, stdout: 'two\n', stderr: '' },
      'sh -c echo two': { exitCode: 0, stdout: 'FALLBACK-RAN', stderr: '' },
    });
    const c = ctxFor(env);
    const first = await (await import('./registry.js')).callOperation(
      'bash',
      { command: 'echo-hostile' },
      inv('inv-userout1'),
      c,
    );
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    // The 127 and the stderr line are the command's own output.
    expect(first.result.exitCode).toBe(127);
    expect(first.result.stderr).toBe('bash: not found\n');
    expect(first.result.shell).toBe('bash');
    // No sh retry, and the resolution cache is not written: the second
    // invocation still spawns bash (asserted via the fake-env call log).
    const second = await (await import('./registry.js')).callOperation(
      'bash',
      { command: 'echo two' },
      inv('inv-userout2'),
      c,
    );
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.result.shell).toBe('bash');
    expect(calls).toEqual(['bash -c echo-hostile', 'bash -c echo two']);
  });

  // Regression: the ENOENT signature must
  // not substring-match spoofable user output — a line like
  // 'respawn ENOENT' from a working bash is not Node's spawn error.
  it('does not fall back on a spoofed "respawn ENOENT" line (exit 127)', async () => {
    const { env, calls } = recordingEnv({
      'bash -c echo-spoof': {
        exitCode: 127,
        stdout: '',
        stderr: 'doing stuff\nrespawn ENOENT\ndone\n',
      },
      'sh -c echo-spoof': { exitCode: 0, stdout: 'FALLBACK-RAN', stderr: '' },
      'bash -c echo two': { exitCode: 0, stdout: 'two\n', stderr: '' },
    });
    const c = ctxFor(env);
    const first = await (await import('./registry.js')).callOperation(
      'bash',
      { command: 'echo-spoof' },
      inv('inv-spoof1'),
      c,
    );
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.result.exitCode).toBe(127);
    expect(first.result.shell).toBe('bash');
    const second = await (await import('./registry.js')).callOperation(
      'bash',
      { command: 'echo two' },
      inv('inv-spoof2'),
      c,
    );
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.result.shell).toBe('bash');
    expect(calls).toEqual(['bash -c echo-spoof', 'bash -c echo two']);
  });

  it.skipIf(!HAS_BASH)(
    'runs bashisms under bash and reports shell: bash (real child)',
    async () => {
      const env = new NodeExecutionEnv(scratch('bash-shell-'));
      const out = await (await import('./registry.js')).callOperation(
        'bash',
        { command: '[[ -n x ]] && echo ok' },
        inv('inv-sh2'),
        ctxFor(env),
      );
      expect(out.ok).toBe(true);
      if (!out.ok) return;
      expect(out.result.exitCode).toBe(0);
      expect(out.result.stdout).toBe('ok\n');
      expect(out.result.shell).toBe('bash');
    },
  );

  it('does not re-probe the shell on a second invocation', async () => {
    const { env, calls } = recordingEnv({
      'bash -c echo one': { exitCode: 0, stdout: 'one\n', stderr: '' },
      'bash -c echo two': { exitCode: 0, stdout: 'two\n', stderr: '' },
    });
    const c = ctxFor(env);
    await (await import('./registry.js')).callOperation(
      'bash',
      { command: 'echo one' },
      inv('inv-sh3a'),
      c,
    );
    await (await import('./registry.js')).callOperation(
      'bash',
      { command: 'echo two' },
      inv('inv-sh3b'),
      c,
    );
    // Exactly one spawn per invocation — no `bash -c true` detection
    // spawn, and nothing re-probed on the second call.
    expect(calls).toEqual(['bash -c echo one', 'bash -c echo two']);
  });

  it('remembers the sh fallback on a second invocation', async () => {
    const { env, calls } = recordingEnv({
      'bash -c echo one': BASH_MISSING,
      'sh -c echo one': { exitCode: 0, stdout: 'one\n', stderr: '' },
      'sh -c echo two': { exitCode: 0, stdout: 'two\n', stderr: '' },
    });
    const c = ctxFor(env);
    const first = await (await import('./registry.js')).callOperation(
      'bash',
      { command: 'echo one' },
      inv('inv-sh4a'),
      c,
    );
    const second = await (await import('./registry.js')).callOperation(
      'bash',
      { command: 'echo two' },
      inv('inv-sh4b'),
      c,
    );
    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(first.result.shell).toBe('sh');
    expect(second.result.shell).toBe('sh');
    expect(calls).toEqual([
      'bash -c echo one',
      'sh -c echo one',
      'sh -c echo two',
    ]);
  });

  it.skipIf(!HAS_BASH)(
    'runs `local` in a function when bash is resolved (real child)',
    async () => {
      const env = new NodeExecutionEnv(scratch('bash-local-'));
      const out = await (await import('./registry.js')).callOperation(
        'bash',
        { command: 'f() { local v=1; echo "local $v"; }; f' },
        inv('inv-sh5'),
        ctxFor(env),
      );
      expect(out.ok).toBe(true);
      if (!out.ok) return;
      expect(out.result.exitCode).toBe(0);
      expect(out.result.stdout).toBe('local 1\n');
      expect(out.result.shell).toBe('bash');
    },
  );

  it('timeout kills the live handle under the retry shape', async () => {
    const shell = new HangShell({
      'bash -c sleep-forever': BASH_MISSING,
      'sh -c sleep-forever': 'hang',
    });
    const out = await (await import('./registry.js')).callOperation(
      'bash',
      { command: 'sleep-forever', timeout: 0.01 },
      inv('inv-sh6'),
      ctxFor(wrapShell(new FakeExecutionEnv({}), shell)),
    );
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.result.timedOut).toBe(true);
    expect(out.result.aborted).toBe(true);
    expect(out.result.exitCode).toBeNull();
    expect(out.result.shell).toBe('sh');
    expect(shell.killed).toContain('sh -c sleep-forever');
    expect(shell.killed).not.toContain('bash -c sleep-forever');
  }, 10000);

  it('abort kills the live handle under the retry shape', async () => {
    const shell = new HangShell({
      'bash -c sleep-forever': BASH_MISSING,
      'sh -c sleep-forever': 'hang',
    });
    const ctl = new AbortController();
    // The fake shell settles in microtasks, so by the time this macrotask
    // runs the op is parked on the hanging sh retry handle.
    const timer = setTimeout(() => ctl.abort(), 0);
    const out = await (await import('./registry.js')).callOperation(
      'bash',
      { command: 'sleep-forever' },
      inv('inv-sh7'),
      ctxFor(wrapShell(new FakeExecutionEnv({}), shell), {
        signal: ctl.signal,
      }),
    );
    clearTimeout(timer);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.result.aborted).toBe(true);
    expect(out.result.timedOut).toBe(false);
    expect(out.result.exitCode).toBeNull();
    expect(out.result.shell).toBe('sh');
    expect(shell.killed).toContain('sh -c sleep-forever');
    expect(shell.killed).not.toContain('bash -c sleep-forever');
  }, 10000);

  it('re-registers the retry handle with trackHandle', async () => {
    const tracked: Array<() => void> = [];
    const { env } = recordingEnv({
      'bash -c echo hi': BASH_MISSING,
      'sh -c echo hi': OK_HI,
    });
    const out = await (await import('./registry.js')).callOperation(
      'bash',
      { command: 'echo hi' },
      inv('inv-sh8'),
      ctxFor(env, {
        trackHandle: (kill) => {
          tracked.push(kill);
        },
      }),
    );
    expect(out.ok).toBe(true);
    // First attempt handle + retry handle — the lane's kill registry must
    // see both so an abort kills whichever is live.
    expect(tracked).toHaveLength(2);
  });

  it('memoizes a retried command exactly once under op-result-bash', async () => {
    const base = inv('inv-sh9');
    const getNames: string[] = [];
    const setNames: string[] = [];
    const counting: ToolInvocation = {
      ...base,
      getMemo: (name: string) => {
        getNames.push(name);
        return base.getMemo(name);
      },
      setMemo: (name: string, value: JsonValue | undefined) => {
        setNames.push(name);
        return base.setMemo(name, value);
      },
    };
    const { env } = recordingEnv({
      'bash -c echo hi': BASH_MISSING,
      'sh -c echo hi': OK_HI,
    });
    const out = await (await import('./registry.js')).callOperation(
      'bash',
      { command: 'echo hi' },
      counting,
      ctxFor(env),
    );
    expect(out.ok).toBe(true);
    expect(getNames).toEqual(['op-result-bash']);
    expect(setNames).toEqual(['op-result-bash']);
  });
});

// No approval detector reads cmd's `del`, `move` or `rmdir`, so on Windows
// the tool refuses to run instead of running commands nothing can see.
describe('bash on Windows', () => {
  const platform = process.platform;
  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: platform });
  });

  it('refuses by name and spawns nothing', async () => {
    Object.defineProperty(process, 'platform', { value: 'win32' });
    const { env, calls } = recordingEnv({});
    const out = await (await import('./registry.js')).callOperation(
      'bash',
      { command: 'del /s /q C:\\Users' },
      inv('inv-win32'),
      ctxFor(env),
    );
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.error.code).toBe('tool_failed');
    expect(out.error.message).toMatch(/^bash is not supported on Windows/);
    expect(calls).toEqual([]);
  });
});
