// The Node shell behind the seam: spawning tool commands in their own
// process group, capping their output, and killing the group on abort.

import { type ChildProcess, spawn } from 'node:child_process';
import { constants as osConstants } from 'node:os';
import type { Writable } from 'node:stream';
import { StringDecoder } from 'node:string_decoder';
import type { BashSandbox } from '../sandbox.js';
import type {
  ProcessHandle,
  ProcessSnapshot,
  Shell,
  ShellResult,
  SpawnOptions,
} from './contracts.js';
import { toolSpawnEnv } from './tool-env.js';

// Default per-stream child-output accumulation cap. Chosen
// far above any legitimate tool result (the model-facing cap is smaller
// still) but far below OOM territory: the accumulator is the thing the
// cap bounds, so the run can never hold a child's whole output in memory.
/** @internal */
export const MAX_CHILD_OUTPUT_BYTES = 10 * 1024 * 1024;

// SIGTERM → SIGKILL escalation window for kill(): long enough for a
// well-behaved child to flush and exit, short enough that an abort never
// hangs on a child that ignores SIGTERM.
const KILL_GRACE_MS = 2000;

// Once the leader exits, pipe data it wrote is drained for at
// most this long. Anything still holding stdout/stderr after the window is
// a background job, never the command's own output, so the streams are
// destroyed instead of waiting for 'close' (which never comes while a
// backgrounded `sleep` inherits the pipe).
const OUTPUT_DRAIN_MS = 150;

const GROUP_POLL_MS = 10;

// 128+signal, the shell convention (`kill -9 $$` → 137), instead of a
// flattening `code ?? 1` that makes a signal exit look like a plain error.
function exitCodeFor(
  code: number | null,
  signal: NodeJS.Signals | null,
): number {
  if (code !== null) return code;
  if (signal !== null) {
    const number = osConstants.signals[signal];
    if (typeof number === 'number') return 128 + number;
  }
  return 1;
}

function groupAlive(pgid: number): boolean {
  try {
    process.kill(-pgid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

// Is the LEADER still a process? Asked of the OS, not of the child object:
// `exitCode`/`signalCode` are set when the 'exit' event is delivered, which
// can lag the process's actual death — and the delayed group SIGKILL this
// guards against is scheduled in exactly that window.
function leaderAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function signalGroup(pgid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pgid, signal);
  } catch {
    // Group already gone.
  }
}

const delay = (ms: number) =>
  new Promise<void>((resolveDelay) => setTimeout(resolveDelay, ms));

async function waitGroupGone(pgid: number, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (groupAlive(pgid)) {
    if (Date.now() >= deadline) return false;
    await delay(GROUP_POLL_MS);
  }
  return true;
}

// SIGTERM the group, escalate to SIGKILL after KILL_GRACE_MS, and wait
// until no member is left (bounded).
async function reapGroup(pgid: number, graceMs: number): Promise<void> {
  signalGroup(pgid, 'SIGTERM');
  if (await waitGroupGone(pgid, graceMs)) return;
  signalGroup(pgid, 'SIGKILL');
  await waitGroupGone(pgid, graceMs);
}

// UTF-8 byte length of a code point, computed without allocating a string
// for it: the output accumulator trims on code-point
// boundaries, so it needs each code point's encoded size.
function utf8Length(codePoint: number): number {
  if (codePoint < 0x80) return 1;
  if (codePoint < 0x800) return 2;
  if (codePoint < 0x10000) return 3;
  return 4;
}

// Capped accumulation of one output stream. The tail is kept — endings
// carry the error — and the final result names exactly what was dropped.
// `peek` feeds progress snapshots (bounded by the same cap), `final`
// produces the settled stream with the truncation header.
//
// The cap is documented in BYTES and must be measured in
// bytes. Counting UTF-16 code units admitted up to ~3x the intended
// memory for CJK text (one unit, three bytes), misstated the dropped
// size, and let `slice(-cap)` start the kept tail with half a surrogate
// pair — a lone low surrogate reaches the model, the trajectory and the
// session store as U+FFFD. Bytes are the bound; code points are the trim
// boundary.
class OutputAccumulator {
  private readonly cap: number;
  private text = '';
  private bytes = 0;
  private dropped = 0;
  private droppedCharCount = 0;

  constructor(cap: number) {
    this.cap = cap;
  }

  push(chunk: string): void {
    const chunkBytes = Buffer.byteLength(chunk, 'utf8');
    if (this.bytes + chunkBytes <= this.cap) {
      this.text += chunk;
      this.bytes += chunkBytes;
      return;
    }
    const combined = this.text + chunk;
    const total = this.bytes + chunkBytes;
    const excess = total - this.cap;
    let at = 0;
    let drop = 0;
    while (drop < excess && at < combined.length) {
      const codePoint = combined.codePointAt(at) ?? 0;
      drop += utf8Length(codePoint);
      at += codePoint > 0xffff ? 2 : 1;
    }
    this.dropped += drop;
    this.droppedCharCount += at;
    this.text = combined.slice(at);
    this.bytes = total - drop;
  }

  peek(): string {
    return this.text;
  }

  droppedChars(): number {
    return this.droppedCharCount;
  }

  final(): string {
    if (this.dropped === 0) return this.text;
    return `[kubic: output truncated — dropped ${this.dropped} leading bytes, kept the last ${this.bytes}]\n${this.text}`;
  }
}

// What a run adds to the commands it spawns: the bash tool's OS sandbox,
// and variables above the tool environment (the egress proxy's).
export interface ShellOptions {
  readonly sandbox?: BashSandbox;
  readonly toolEnv?: Readonly<Record<string, string>>;
}

export class NodeShell implements Shell {
  readonly cwd: string;
  readonly options: ShellOptions;

  constructor(cwd: string, options: ShellOptions = {}) {
    this.cwd = cwd;
    this.options = options;
  }

  spawn(
    command: string,
    commandArgs: string[],
    options: SpawnOptions,
  ): ProcessHandle {
    // The bash tool's commands run inside the sandbox; every other spawn
    // (git probes, gate commands) runs as is.
    const sandbox = this.options.sandbox;
    const wrapped: ReturnType<BashSandbox['wrap']> =
      sandbox !== undefined && options.provenance?.operation === 'bash'
        ? sandbox.wrap(command, commandArgs, options.provenance.toolCallId)
        : { cmd: command, args: commandArgs };
    const { cmd, args, seccomp } = wrapped;
    // Detached process group: kill() signals the whole group so spawned
    // grandchildren die too (leak cleanup) — no orphans.
    // Stdin is 'ignore' — a stdin reader (cat, read -p, a
    // REPL, a commit hook) sees EOF at once instead of blocking the turn
    // on a pipe nobody ever ends.
    const groups = process.platform !== 'win32';
    const child = spawn(cmd, args, {
      cwd: this.cwd,
      detached: groups,
      // An explicit allowlisted env, never the inherited one.
      env: { ...toolSpawnEnv(), ...this.options.toolEnv },
      // The sandbox's seccomp filter goes in on fd 3, where bubblewrap reads
      // it before the command starts.
      stdio:
        seccomp === undefined
          ? ['ignore', 'pipe', 'pipe']
          : ['ignore', 'pipe', 'pipe', 'pipe'],
    });
    if (seccomp !== undefined) {
      const filter = child.stdio[3] as Writable | null;
      // A sandbox that fails to start never reads it: its exit says why.
      filter?.on('error', () => {});
      // Closed once written, so whatever holds the far end, this pipe never
      // keeps the command from settling.
      filter?.end(seccomp, () => filter.destroy());
    }
    const run = new ShellRun(child, options, groups);
    return {
      pid: child.pid,
      wait: () => run.done,
      kill: () => run.kill(),
    };
  }
}

// One spawned command: its captured output, how it settles, and how it is
// killed.
class ShellRun {
  readonly done: Promise<ShellResult>;
  private readonly child: ChildProcess;
  private readonly options: SpawnOptions;
  private readonly groups: boolean;
  private readonly stdoutAcc: OutputAccumulator;
  private readonly stderrAcc: OutputAccumulator;
  // Pipe chunks are arbitrary byte slices — Buffer.toString()
  // per chunk corrupts any multi-byte UTF-8 codepoint split across a
  // chunk boundary (U+FFFD on both sides). One StringDecoder per stream
  // carries split codepoints across writes; decoder.end() on settle
  // flushes a trailing incomplete sequence instead of dropping it.
  private readonly outDec = new StringDecoder('utf8');
  private readonly errDec = new StringDecoder('utf8');
  private settled = false;
  // Did the SIGKILL escalation beat the LEADER's own exit?
  // Derived from the leader, never from the handle settling: `finish()`
  // awaits the whole group drain, so a grandchild that outlives the
  // SIGTERM would otherwise report a cooperative settle as forced.
  private forced = false;
  private leaderExited = false;
  private escalationTimer: ReturnType<typeof setTimeout> | undefined;
  // Settle on the leader's 'exit' plus a short drain
  // window, not on 'close' — 'close' waits for every holder of the
  // pipes, and a backgrounded job inherits them. After the drain the
  // process group is reaped (unless keepBackground), so the tool never
  // returns with an orphan still running in the detached group.
  private leaderExit: number | undefined;
  private leaderSignal: NodeJS.Signals | null = null;
  private streamsClosed = false;
  private finishing = false;
  private drainTimer: ReturnType<typeof setTimeout> | undefined;
  private resolveDone: (result: ShellResult) => void = () => undefined;

  constructor(child: ChildProcess, options: SpawnOptions, groups: boolean) {
    this.child = child;
    this.options = options;
    this.groups = groups;
    const cap = options.maxOutputBytes ?? MAX_CHILD_OUTPUT_BYTES;
    this.stdoutAcc = new OutputAccumulator(cap);
    this.stderrAcc = new OutputAccumulator(cap);
    // A configured checkpoint store means this run wants durable recovery:
    // every update requests a checkpoint and the store's own gate
    // (≤2s, change-only) decides what is durable.
    const wantCheckpoint =
      options.checkpointKey !== undefined &&
      options.checkpointStore !== undefined;
    child.stdout?.on('data', (d: Buffer) => {
      this.stdoutAcc.push(this.outDec.write(d));
      this.emit(wantCheckpoint);
    });
    child.stderr?.on('data', (d: Buffer) => {
      this.stderrAcc.push(this.errDec.write(d));
      this.emit(wantCheckpoint);
    });
    this.done = new Promise<ShellResult>((resolveDone) => {
      this.resolveDone = resolveDone;
      child.on('error', (error: Error) => this.onError(error));
      child.on('exit', (code, signal) => this.onExit(code, signal));
      child.on('close', (code, signal) => {
        this.streamsClosed = true;
        if (this.settled || this.finishing) return;
        if (this.leaderExit === undefined) {
          this.leaderExit = exitCodeFor(code, signal);
        }
        void this.finish();
      });
    });
  }

  private snapshot(): ProcessSnapshot {
    const out = this.stdoutAcc.droppedChars();
    const err = this.stderrAcc.droppedChars();
    return {
      stdout: this.stdoutAcc.peek(),
      stderr: this.stderrAcc.peek(),
      exitCode: null,
      ...(out === 0 && err === 0
        ? {}
        : { dropped: { stdout: out, stderr: err } }),
    };
  }

  private emit(checkpoint: boolean): void {
    const { options } = this;
    options.onUpdate?.(
      this.snapshot(),
      checkpoint ? { checkpoint: true } : undefined,
    );
    if (checkpoint && options.checkpointKey && options.checkpointStore) {
      options.checkpointStore.record(options.checkpointKey, this.snapshot());
    }
  }

  // A spawn that cannot start the child emits 'error' and never
  // 'close'. Unhandled, Node re-throws it as an uncaught exception and
  // the caller dies raw — no result, no exit code (this is
  // the `spawn <path> ENOENT` crash). Settle wait() with a named
  // failure instead, so every caller reads it through the same seam.
  private onError(error: Error): void {
    // A spawn error means no leader exists: nothing to force.
    this.leaderExited = true;
    if (this.settled) return;
    this.settled = true;
    // Flush any buffered partial byte sequence before the result is
    // built — 'error' can fire with decoded-pending output too.
    this.stdoutAcc.push(this.outDec.end());
    this.stderrAcc.push(this.errDec.end());
    this.stderrAcc.push(`${error.message}\n`);
    this.settle(
      {
        exitCode: 127,
        stdout: this.stdoutAcc.final(),
        stderr: this.stderrAcc.final(),
        provenance: this.options.provenance,
      },
      false,
    );
  }

  private onExit(code: number | null, signal: NodeJS.Signals | null): void {
    // The leader is gone, whatever else the group is doing:
    // recorded before the settle guard so a finishing handle still knows.
    this.leaderExited = true;
    if (this.settled || this.finishing) return;
    this.leaderExit = exitCodeFor(code, signal);
    this.leaderSignal = signal;
    if (this.streamsClosed) {
      void this.finish();
      return;
    }
    this.drainTimer = setTimeout(() => void this.finish(), OUTPUT_DRAIN_MS);
  }

  private async finish(): Promise<void> {
    if (this.finishing || this.settled) return;
    this.finishing = true;
    if (this.drainTimer !== undefined) clearTimeout(this.drainTimer);
    // The group SIGKILL escalation belongs to a LIVE
    // leader. Once the handle settles, a pending timer could signal a
    // recycled pgid (the stranger hazard) — the settle path reaps
    // the group itself.
    if (this.escalationTimer !== undefined) clearTimeout(this.escalationTimer);
    const background = await this.settleBackground();
    if (this.settled) return;
    this.settled = true;
    // Flush any trailing incomplete byte sequence (decoder.end() emits
    // it as U+FFFD, never throws) before the result is built.
    this.stdoutAcc.push(this.outDec.end());
    this.stderrAcc.push(this.errDec.end());
    if (background !== undefined) {
      this.stderrAcc.push(
        background === 'killed'
          ? '[kubic: background processes started by this command were killed after it exited (KUBIC_BASH_KEEP_BACKGROUND=1 keeps them)]\n'
          : '[kubic: background processes started by this command were left running, detached]\n',
      );
    }
    this.settle(
      {
        exitCode: this.leaderExit ?? 1,
        ...(this.leaderSignal === null ? {} : { signal: this.leaderSignal }),
        ...(this.forced ? { forced: true } : {}),
        stdout: this.stdoutAcc.final(),
        stderr: this.stderrAcc.final(),
        provenance: this.options.provenance,
        ...(background === undefined ? {} : { background }),
      },
      true,
    );
  }

  // What became of anything the command left behind once its leader exited:
  // pipes still held are closed, and a live group is reaped — or left
  // running, detached, when the caller asked to keep background jobs.
  private async settleBackground(): Promise<ShellResult['background']> {
    const { child } = this;
    const heldPipes = !this.streamsClosed;
    if (heldPipes) {
      child.stdout?.destroy();
      child.stderr?.destroy();
    }
    const pgid = child.pid;
    if (this.groups && pgid !== undefined && groupAlive(pgid)) {
      if (this.options.keepBackground === true) return 'detached';
      await reapGroup(pgid, this.options.killGraceMs ?? KILL_GRACE_MS);
      return 'killed';
    }
    // A pipe holder that left the group (setsid) is out of reach.
    return heldPipes ? 'detached' : undefined;
  }

  // Record the final result, report it, and resolve wait(). A child that
  // ran is unref'd first, so a detached background job never holds the
  // event loop open.
  private settle(result: ShellResult, ran: boolean): void {
    const { options } = this;
    if (options.checkpointKey && options.checkpointStore) {
      options.checkpointStore.recordFinal(options.checkpointKey, {
        ...result,
      });
    }
    options.onUpdate?.({ ...result }, undefined);
    if (ran) this.child.unref();
    this.resolveDone(result);
  }

  kill(): void {
    const { child } = this;
    const pid = child.pid;
    if (pid === undefined) return;
    // A settled handle is finished: its pid (and group) may already be
    // recycled, and a background job it deliberately left running
    // (KUBIC_BASH_KEEP_BACKGROUND=1) is not this handle's to kill.
    if (this.settled) return;
    const signal = (sig: NodeJS.Signals): void => {
      try {
        if (process.platform !== 'win32') process.kill(-pid, sig);
        else child.kill(sig);
      } catch {
        try {
          child.kill(sig);
        } catch {
          // Already exited — nothing to kill.
        }
      }
    };
    signal('SIGTERM');
    // Escalate: a group that traps or ignores SIGTERM would otherwise
    // keep wait() pending forever. The timer is unref'd so it never
    // holds the event loop open, and it is a no-op once settled.
    // The group, not just the leader: a leader that exits on SIGTERM
    // settles the handle while group members that ignore it live on,
    // so the escalation is not gated on the leader surviving the grace.
    //
    // It IS gated on the leader being alive when kill() was
    // called (asked of the OS — see leaderAlive). A leader that has
    // already exited owns no process group any more — its pgid may be
    // recycled — so a delayed group SIGKILL could hit a stranger.
    // Nothing is orphaned by skipping it: the settle path reaps whatever
    // the group still holds (reapGroup, unless the caller opted into
    // keepBackground).
    if (!leaderAlive(pid)) return;
    this.escalationTimer = setTimeout(() => {
      // The leader is still up when the grace elapses: its cooperative
      // shutdown did not finish, so this is a FORCED kill.
      // The LEADER's exit is the test — a group member that outlives the
      // SIGTERM is the escalation's cleanup, not a forced worker.
      if (!this.leaderExited) this.forced = true;
      if (process.platform !== 'win32') {
        try {
          process.kill(-pid, 'SIGKILL');
        } catch {
          // ESRCH: the whole group already exited.
        }
      } else if (!this.settled) signal('SIGKILL');
    }, this.options.killGraceMs ?? KILL_GRACE_MS);
    this.escalationTimer.unref();
  }
}
