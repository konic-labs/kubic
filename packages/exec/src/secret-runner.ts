// Runs `!command` secret refs (issue #224; §36.2): the production executor
// the run boots inject into the ledger key resolver. execFile, never a
// shell — argv arrives verbatim, so quoting is parsing only, never
// evaluation. One trailing newline is left for resolveSecretRef to strip;
// empty output refuses there by name. Timeout and failure fail closed
// naming the command, never its output (stderr/stdout stay out of error
// text: a failing helper must not leak the material into run output).
//
// Lives in exec (not host): only packages/exec touches node:child_process
// (§9 I/O confinement, issue #12). The host names the failure's provider
// when it catches one (see secrets.ts); the runner itself never knows it.
import { execFile } from 'node:child_process';

/** A `!command` refusal from the production runner (issue #224). */
export class SecretCommandError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SecretCommandError';
  }
}

/** Runs one parsed secret command; rejects with SecretCommandError. */
export type SecretCommandRunner = (argv: string[]) => Promise<string>;

// Slow helpers must not hang a request: vault CLIs answer in about a
// second; past this the request fails closed and the run names the command.
const DEFAULT_TIMEOUT_MS = 10_000;
// A key is bytes, not megabytes: cap the pipe so a runaway helper cannot
// swell the lane's memory before the request fails.
const MAX_OUTPUT_BYTES = 64 * 1024;

export function createSecretCommandRunner(
  options: { timeoutMs?: number; cwd?: string } = {},
): SecretCommandRunner {
  const timeout = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  return (argv) =>
    new Promise<string>((resolve, reject) => {
      if (argv.length === 0) {
        reject(new SecretCommandError('empty secret command'));
        return;
      }
      const [command, ...args] = argv as [string, ...string[]];
      execFile(
        command,
        args,
        {
          timeout,
          maxBuffer: MAX_OUTPUT_BYTES,
          ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
        },
        (error, stdout) => {
          if (error) {
            reject(
              'killed' in error && error.killed === true
                ? new SecretCommandError(
                    `secret command timed out after ${timeout}ms: ${argv.join(' ')}`,
                  )
                : new SecretCommandError(
                    `secret command failed: ${argv.join(' ')}`,
                  ),
            );
            return;
          }
          resolve(stdout);
        },
      );
    });
}
