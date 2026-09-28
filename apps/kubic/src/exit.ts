// Process exit that does not truncate piped output. `process.exit()` right
// after a large `--json` write can cut stdout short when it is a pipe
// (pipe writes are asynchronous on macOS), so the root first records the
// exit code, then waits for an empty write on each std stream — its
// callback fires only after every earlier chunk is handed to the OS — and
// only then exits. The explicit exit stays: a live handle (a TUI timer, a
// child watcher) must never keep a finished command alive.
//
// Two bounds keep the wait honest:
// - a closed reader (`| head -1`) raises EPIPE on the stream: the output is
//   unwanted by then, so the process exits silently with the intended code
//   instead of crashing with a stack;
// - a reader that never drains (`| sleep 999`) cannot hold the exit forever:
//   an unref'd fallback timer exits after FLUSH_FALLBACK_MS. Unref'd, so it
//   never itself keeps the loop alive.

export const FLUSH_FALLBACK_MS = 1_500;

type StreamError = Error & { code?: string };

export interface FlushableStream {
  write: (chunk: string, callback: () => void) => boolean;
  on: (event: 'error', listener: (error: StreamError) => void) => unknown;
}

export interface ExitIo {
  stdout: FlushableStream;
  stderr: FlushableStream;
  exit: (code: number) => void;
  setExitCode?: (code: number) => void;
  schedule?: (fn: () => void, ms: number) => { unref: () => void };
}

export function exitAfterFlush(code: number, io: ExitIo): void {
  io.setExitCode?.(code);
  let done = false;
  const finish = (): void => {
    if (done) return;
    done = true;
    io.exit(code);
  };
  // Any stream error at this point (EPIPE from a closed reader, or worse)
  // ends the wait: nothing more can be delivered, and a stack trace for
  // output nobody reads would only replace the intended exit code.
  io.stdout.on('error', finish);
  io.stderr.on('error', finish);
  const schedule =
    io.schedule ?? ((fn: () => void, ms: number) => setTimeout(fn, ms));
  schedule(finish, FLUSH_FALLBACK_MS).unref();
  io.stdout.write('', () => {
    io.stderr.write('', finish);
  });
}

// Production wiring over the real process streams.
export function exitProcessAfterFlush(code: number): void {
  exitAfterFlush(code, {
    stdout: process.stdout,
    stderr: process.stderr,
    exit: (exitCode) => process.exit(exitCode),
    setExitCode: (exitCode) => {
      process.exitCode = exitCode;
    },
  });
}
