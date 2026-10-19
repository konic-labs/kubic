// One rule for an explicit `--session` that names no session — no
// `<root>/<id>/main.jsonl` — across diff, log, status, undo and prune: one
// `error: unknown session: <id>` line, exit 1, and under `--json` one
// failure envelope instead of an empty document that reads as success. A
// malformed id stays a usage error (exit 2).
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { CliUsageError, EXIT_FAILED } from '@kubic/core/cli/exit-codes';
import { describe, expect, it } from 'vitest';
import { tempDir } from '../../../../test/temp-dir.js';
import { runJournalCommand } from './journal-cli.js';
import type { JournalRequest } from './journal-run.js';

const COMMANDS: JournalRequest['command'][] = [
  'diff',
  'log',
  'status',
  'undo',
  'prune',
];

async function run(request: JournalRequest, sessionsRoot: string) {
  const out: string[] = [];
  const err: string[] = [];
  const code = (
    await runJournalCommand(
      { ...request, ...(request.command === 'prune' ? { keepDays: 1 } : {}) },
      {
        root: tempDir('journal-unknown-ws-'),
        sessionsRoot,
        out: (line) => out.push(line),
        err: (line) => err.push(line),
      },
    )
  ).exitCode;
  return { code, out, err };
}

describe('an unknown --session', () => {
  it.each(COMMANDS)('%s refuses it by name with exit 1', async (command) => {
    const { code, out, err } = await run(
      { command, session: 'nope' } as JournalRequest,
      tempDir('journal-unknown-root-'),
    );
    expect(code).toBe(EXIT_FAILED);
    expect(err.join('\n')).toContain('unknown session: nope');
    expect(out).toEqual([]);
  });

  it.each(COMMANDS)(
    '%s --json prints one failure envelope',
    async (command) => {
      const { code, out } = await run(
        { command, session: 'journal:nope', json: true } as JournalRequest,
        tempDir('journal-unknown-root-'),
      );
      expect(code).toBe(EXIT_FAILED);
      expect(out).toHaveLength(1);
      expect(JSON.parse(out[0] ?? '')).toEqual({
        ok: false,
        exitCode: EXIT_FAILED,
        session: 'nope',
        root: null,
        error: { code: 'unknown_session', message: 'unknown session: nope' },
      });
    },
  );

  it('counts a folder with neither session storage nor a journal as unknown', async () => {
    const sessionsRoot = tempDir('journal-unknown-root-');
    mkdirSync(join(sessionsRoot, 'stray', 'journal'), { recursive: true });
    writeFileSync(join(sessionsRoot, 'stray', 'spans.jsonl'), '');
    const { code, err } = await run(
      { command: 'diff', session: 'stray' },
      sessionsRoot,
    );
    expect(code).toBe(EXIT_FAILED);
    expect(err.join('\n')).toContain('unknown session: stray');
  });

  it('reads a real session with an empty journal as a clean diff', async () => {
    const sessionsRoot = tempDir('journal-unknown-root-');
    mkdirSync(join(sessionsRoot, 'real'), { recursive: true });
    writeFileSync(join(sessionsRoot, 'real', 'main.jsonl'), '');
    const { code, err } = await run(
      { command: 'diff', session: 'real' },
      sessionsRoot,
    );
    expect(code).toBe(0);
    expect(err.join('\n')).not.toContain('unknown session');
  });

  it('keeps a malformed id a usage error', async () => {
    await expect(
      run({ command: 'diff', session: '../x' }, tempDir('journal-unknown-')),
    ).rejects.toThrow(CliUsageError);
  });
});
