// The `!command` runner: the production executor the
// run boots inject into the ledger resolver. Real child processes (node
// itself — hermetic, no network), temp dirs cleaned in afterEach (none
// needed: no files).
import { describe, expect, it } from 'vitest';
import { createSecretCommandRunner } from './secret-runner.js';

const NODE = process.execPath;

describe('createSecretCommandRunner', () => {
  it('runs argv verbatim with no shell', async () => {
    const run = createSecretCommandRunner();
    await expect(
      run([
        NODE,
        '-e',
        'console.log(process.argv.slice(1).join("|"))',
        'a b',
        'c',
      ]),
    ).resolves.toBe('a b|c\n');
  });

  it('a failing command rejects naming the command, never its output', async () => {
    const run = createSecretCommandRunner();
    await expect(run([NODE, '-e', 'process.exit(3)'])).rejects.toThrow(
      /secret command failed.*-e/,
    );
  });

  it('a missing binary rejects naming it', async () => {
    const run = createSecretCommandRunner();
    await expect(run(['kubic-definitely-not-a-binary'])).rejects.toThrow(
      /kubic-definitely-not-a-binary/,
    );
  });

  it('a hung command times out naming the command', async () => {
    const run = createSecretCommandRunner({ timeoutMs: 50 });
    await expect(
      run([NODE, '-e', 'setTimeout(() => {}, 5000)']),
    ).rejects.toThrow(/timed out after 50ms/);
  });

  it('an empty argv refuses without spawning', async () => {
    const run = createSecretCommandRunner();
    await expect(run([])).rejects.toThrow(/empty secret command/);
  });
});
