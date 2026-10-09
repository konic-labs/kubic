// The Node shell behind the seam: spawning tool commands in their own
// process group, capping their output, and killing the group on abort.

import { spawn } from 'node:child_process';
import { constants as osConstants } from 'node:os';
import { StringDecoder } from 'node:string_decoder';
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
const EXIT_DRAIN_MS = 150;

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

export class NodeShell implements Shell {
  readonly cwd: string;

  constructor(cwd: string) {
    this.cwd = cwd;
  }

  spawn(cmd: string, args: string[], options: SpawnOptions): ProcessHandle {
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
      env: toolSpawnEnv(),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    // Capped accumulation. The tail is kept — endings carry
    // the error — and the final result names exactly what was dropped.
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
    const cap = options.maxOutputBytes ?? MAX_CHILD_OUTPUT_BYTES;
    const makeAccumulator = () => {
      let text = '';
      let bytes = 0;
      let dropped = 0;
      let droppedChars = 0;
      return {
        push(chunk: string): void {
          const chunkBytes = Buffer.byteLength(chunk, 'utf8');
          if (bytes + chunkBytes <= cap) {
            text += chunk;
            bytes += chunkBytes;
            return;
          }
          const combined = text + chunk;
          const total = bytes + chunkBytes;
          const excess = total - cap;
          let at = 0;
          let drop = 0;
          while (drop < excess && at < combined.length) {
            const codePoint = combined.codePointAt(at) ?? 0;
            drop += utf8Length(codePoint);
            at += codePoint > 0xffff ? 2 : 1;
          }
          dropped += drop;
          droppedChars += at;
          text = combined.slice(at);
          bytes = total - drop;
        },
        peek(): string {
          return text;
        },
        droppedChars(): number {
          return droppedChars;
        },
        final(): string {
          if (dropped === 0) return text;
          return `[kubic: output truncated — dropped ${dropped} leading bytes, kept the last ${bytes}]\n${text}`;
        },
      };
    };
    const stdoutAcc = makeAccumulator();
    const stderrAcc = makeAccumulator();
    // Pipe chunks are arbitrary byte slices — Buffer.toString()
    // per chunk corrupts any multi-byte UTF-8 codepoint split across a
    // chunk boundary (U+FFFD on both sides). One StringDecoder per stream
    // carries split codepoints across writes; decoder.end() on settle
    // flushes a trailing incomplete sequence instead of dropping it.
    const outDec = new StringDecoder('utf8');
    const errDec = new StringDecoder('utf8');
    let settled = false;
    // Did the SIGKILL escalation beat the LEADER's own exit?
    // Derived from the leader, never from the handle settling: `finish()`
    // awaits the whole group drain, so a grandchild that outlives the
    // SIGTERM would otherwise report a cooperative settle as forced.
    let forced = false;
    let leaderExited = false;
    let escalationTimer: ReturnType<typeof setTimeout> | undefined;
    const snapshot = (): ProcessSnapshot => {
      const out = stdoutAcc.droppedChars();
      const err = stderrAcc.droppedChars();
      return {
        stdout: stdoutAcc.peek(),
        stderr: stderrAcc.peek(),
        exitCode: null,
        ...(out === 0 && err === 0
          ? {}
          : { dropped: { stdout: out, stderr: err } }),
      };
    };
    const emit = (checkpoint: boolean) => {
      options.onUpdate?.(
        snapshot(),
        checkpoint ? { checkpoint: true } : undefined,
      );
      if (checkpoint && options.checkpointKey && options.checkpointStore) {
        options.checkpointStore.record(options.checkpointKey, snapshot());
      }
    };
    // A configured checkpoint store means this run wants durable recovery:
    // every update requests a checkpoint and the store's own gate
    // (≤2s, change-only) decides what is durable.
    const wantCheckpoint =
      options.checkpointKey !== undefined &&
      options.checkpointStore !== undefined;
    child.stdout?.on('data', (d: Buffer) => {
      stdoutAcc.push(outDec.write(d));
      emit(wantCheckpoint);
    });
    child.stderr?.on('data', (d: Buffer) => {
      stderrAcc.push(errDec.write(d));
      emit(wantCheckpoint);
    });
    const done = new Promise<ShellResult>((resolveDone) => {
      // A spawn that cannot start the child emits 'error' and never
      // 'close'. Unhandled, Node re-throws it as an uncaught exception and
      // the caller dies raw — no result, no exit code (this is
      // the `spawn <path> ENOENT` crash). Settle wait() with a named
      // failure instead, so every caller reads it through the same seam.
      child.on('error', (error: Error) => {
        // A spawn error means no leader exists: nothing to force.
        leaderExited = true;
        if (settled) return;
        settled = true;
        // Flush any buffered partial byte sequence before the result is
        // built — 'error' can fire with decoded-pending output too.
        stdoutAcc.push(outDec.end());
        stderrAcc.push(errDec.end());
        const message = `${error.message}\n`;
        stderrAcc.push(message);
        const result: ShellResult = {
          exitCode: 127,
          stdout: stdoutAcc.final(),
          stderr: stderrAcc.final(),
          provenance: options.provenance,
        };
        if (options.checkpointKey && options.checkpointStore) {
          options.checkpointStore.recordFinal(options.checkpointKey, {
            ...result,
          });
        }
        options.onUpdate?.({ ...result }, undefined);
        resolveDone(result);
      });
      // Settle on the leader's 'exit' plus a short drain
      // window, not on 'close' — 'close' waits for every holder of the
      // pipes, and a backgrounded job inherits them. After the drain the
      // process group is reaped (unless keepBackground), so the tool never
      // returns with an orphan still running in the detached group.
      let leaderExit: number | undefined;
      let leaderSignal: NodeJS.Signals | null = null;
      let streamsClosed = false;
      let finishing = false;
      let drainTimer: ReturnType<typeof setTimeout> | undefined;
      const finish = async () => {
        if (finishing || settled) return;
        finishing = true;
        if (drainTimer !== undefined) clearTimeout(drainTimer);
        // The group SIGKILL escalation belongs to a LIVE
        // leader. Once the handle settles, a pending timer could signal a
        // recycled pgid (the stranger hazard) — the settle path reaps
        // the group itself.
        if (escalationTimer !== undefined) clearTimeout(escalationTimer);
        const heldPipes = !streamsClosed;
        if (heldPipes) {
          child.stdout?.destroy();
          child.stderr?.destroy();
        }
        let background: ShellResult['background'];
        const pgid = child.pid;
        if (groups && pgid !== undefined && groupAlive(pgid)) {
          if (options.keepBackground === true) background = 'detached';
          else {
            background = 'killed';
            await reapGroup(pgid, options.killGraceMs ?? KILL_GRACE_MS);
          }
        } else if (heldPipes) {
          // A pipe holder that left the group (setsid) is out of reach.
          background = 'detached';
        }
        if (settled) return;
        settled = true;
        // Flush any trailing incomplete byte sequence (decoder.end() emits
        // it as U+FFFD, never throws) before the result is built.
        stdoutAcc.push(outDec.end());
        stderrAcc.push(errDec.end());
        if (background !== undefined) {
          stderrAcc.push(
            background === 'killed'
              ? '[kubic: background processes started by this command were killed after it exited (KUBIC_BASH_KEEP_BACKGROUND=1 keeps them)]\n'
              : '[kubic: background processes started by this command were left running, detached]\n',
          );
        }
        const result: ShellResult = {
          exitCode: leaderExit ?? 1,
          ...(leaderSignal === null ? {} : { signal: leaderSignal }),
          ...(forced ? { forced: true } : {}),
          stdout: stdoutAcc.final(),
          stderr: stderrAcc.final(),
          provenance: options.provenance,
          ...(background === undefined ? {} : { background }),
        };
        if (options.checkpointKey && options.checkpointStore) {
          options.checkpointStore.recordFinal(options.checkpointKey, {
            ...result,
          });
        }
        options.onUpdate?.({ ...result }, undefined);
        child.unref();
        resolveDone(result);
      };
      child.on('exit', (code, signal) => {
        // The leader is gone, whatever else the group is doing:
        // recorded before the settle guard so a finishing handle still knows.
        leaderExited = true;
        if (settled || finishing) return;
        leaderExit = exitCodeFor(code, signal);
        leaderSignal = signal;
        if (streamsClosed) {
          void finish();
          return;
        }
        drainTimer = setTimeout(() => void finish(), EXIT_DRAIN_MS);
      });
      child.on('close', (code, signal) => {
        streamsClosed = true;
        if (settled || finishing) return;
        if (leaderExit === undefined) leaderExit = exitCodeFor(code, signal);
        void finish();
      });
    });
    return {
      pid: child.pid,
      wait: () => done,
      kill: () => {
        const pid = child.pid;
        if (pid === undefined) return;
        // A settled handle is finished: its pid (and group) may already be
        // recycled, and a background job it deliberately left running
        // (KUBIC_BASH_KEEP_BACKGROUND=1) is not this handle's to kill.
        if (settled) return;
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
        escalationTimer = setTimeout(() => {
          // The leader is still up when the grace elapses: its cooperative
          // shutdown did not finish, so this is a FORCED kill.
          // The LEADER's exit is the test — a group member that outlives the
          // SIGTERM is the escalation's cleanup, not a forced worker.
          if (!leaderExited) forced = true;
          if (process.platform !== 'win32') {
            try {
              process.kill(-pid, 'SIGKILL');
            } catch {
              // ESRCH: the whole group already exited.
            }
          } else if (!settled) signal('SIGKILL');
        }, options.killGraceMs ?? KILL_GRACE_MS);
        escalationTimer.unref();
      },
    };
  }
}
