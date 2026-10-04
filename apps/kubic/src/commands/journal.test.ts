// The journal command group on commander: diff, undo, log, status and the
// git subcommands. These tests drive the real program (createKubicProgram +
// registerJournalCommands) with recording runners, so they pin exactly what
// commander parses into each typed request, the generated help, and the
// §78 exit codes for usage errors — without touching a journal or a repo.
// One end-to-end block wires the real host handlers over a temp journal to
// pin the `--json` stdout/stderr split.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { FileJournalStore } from '../../../../packages/exec/src/journal.js';
import type { GitRequest } from '../../../../packages/host/src/git-cli.js';
import {
  type JournalRequest,
  runJournalCommand,
} from '../../../../packages/host/src/journal-cli.js';
import type { CommandContext, DispatchRunners } from '../cli/context.js';
import { createKubicProgram, runKubicProgram } from '../cli/program.js';
import type { CliConfigResult } from '../config-runtime.js';
import { registerJournalCommands } from './journal.js';

const CONFIG = {} as CliConfigResult;

interface Run {
  readonly code: number;
  readonly out: string[];
  readonly err: string[];
  readonly journal: JournalRequest[];
  readonly git: GitRequest[];
}

async function kubic(
  argv: readonly string[],
  runners: {
    journal?: DispatchRunners['journal'];
    git?: DispatchRunners['git'];
  } = {},
): Promise<Run> {
  const out: string[] = [];
  const err: string[] = [];
  const journal: JournalRequest[] = [];
  const git: GitRequest[] = [];
  const channels = {
    out: (line: string) => out.push(line),
    err: (line: string) => err.push(line),
  };
  const program = createKubicProgram(channels, {
    versionLine: 'kubic 0.0.0',
    rootHelp: 'usage: kubic <x>',
  });
  let exit = 0;
  const ctx: CommandContext = {
    config: CONFIG,
    runners: {
      journal: (request, config) => {
        journal.push(request);
        return runners.journal?.(request, config) ?? 0;
      },
      git: (request, config) => {
        git.push(request);
        return runners.git?.(request, config) ?? 0;
      },
    } as DispatchRunners,
    rest: argv.slice(1),
    out: channels.out,
    err: channels.err,
    setExitCode: (code) => {
      exit = code;
    },
  };
  registerJournalCommands(program, ctx);
  const code = await runKubicProgram(program, argv, channels, {
    code: () => exit,
  });
  return { code, out, err, journal, git };
}

describe('journal commands: generated help (exit 0, no runner)', () => {
  const cases: readonly (readonly [readonly string[], readonly string[]])[] = [
    [['diff'], ['--path <path>', '--agent <id>', '--max-content-bytes <n>']],
    [['undo'], ['[path]', '--step', '--dry-run', '--force']],
    [['log'], ['--session <id>', '--json']],
    [['status'], ['--session <id>', '--json']],
    [['git'], ['status', 'log', 'stage', 'commit']],
    [['git', 'status'], ['--json']],
    [
      ['git', 'log'],
      ['--max <n>', '--json'],
    ],
    [
      ['git', 'stage'],
      ['<paths...>', '--json'],
    ],
    [
      ['git', 'commit'],
      ['-m, --message <message>', '--json'],
    ],
    [['commit'], ['-m, --message <message>', '--json']],
  ];
  for (const [command, mentions] of cases) {
    for (const flag of ['--help', '-h']) {
      it(`kubic ${command.join(' ')} ${flag}`, async () => {
        const r = await kubic([...command, flag]);
        expect(r.code).toBe(0);
        expect(r.err).toEqual([]);
        const text = r.out.join('\n');
        expect(text).toContain(`Usage: kubic ${command.join(' ')}`);
        for (const mention of mentions) expect(text).toContain(mention);
        expect(r.journal).toEqual([]);
        expect(r.git).toEqual([]);
      });
    }
  }

  it('diff and undo help carry examples', async () => {
    for (const command of ['diff', 'undo']) {
      const r = await kubic([command, '--help']);
      expect(r.out.join('\n'), command).toContain('Examples:');
    }
  });
});

describe('journal commands: usage errors exit 2 on stderr, no runner', () => {
  const cases: readonly (readonly [readonly string[], RegExp])[] = [
    [['diff', '--nope'], /^error: unknown option '--nope'/],
    [['undo', '--nope'], /^error: unknown option '--nope'/],
    [['log', '--nope'], /^error: unknown option '--nope'/],
    [['status', '--path', 'a'], /^error: unknown option '--path'/],
    [['diff', '--agent'], /^error: option '--agent <id>' argument missing/],
    [['diff', '--path'], /^error: option '--path <path>' argument missing/],
    [['log', '--session'], /^error: option '--session <id>' argument missing/],
    [['diff', '--max-content-bytes', 'abc'], /non-negative integer/],
    [['diff', '--max-content-bytes', '-1'], /non-negative integer/],
    [['diff', '--max-content-bytes', '1.5'], /non-negative integer/],
    [['diff', 'stray'], /too many arguments/],
    [['undo', 'a.txt', 'b.txt'], /too many arguments/],
    [['log', 'stray'], /too many arguments/],
    [['git'], /^error: git needs a subcommand/],
    [['git', 'push'], /^error: unknown git subcommand 'push'/],
    [['git', 'status', '--nope'], /^error: unknown option '--nope'/],
    [['git', 'log', '--max', '0'], /positive integer/],
    [['git', 'log', '--max', 'x'], /positive integer/],
    [['git', 'stage'], /missing required argument 'paths'/],
    [['git', 'commit'], /required option '-m, --message <message>'/],
    [['git', 'commit', '-m', ''], /^error: commit needs a non-empty message/],
    [['commit'], /required option '-m, --message <message>'/],
    [['commit', '-m', ''], /^error: commit needs a non-empty message/],
  ];
  for (const [argv, message] of cases) {
    it(`kubic ${argv.join(' ')}`, async () => {
      const r = await kubic(argv);
      expect(r.code).toBe(2);
      expect(r.out).toEqual([]);
      expect(r.err).toHaveLength(1);
      expect(r.err[0]).toMatch(message);
      expect(r.journal).toEqual([]);
      expect(r.git).toEqual([]);
    });
  }
});

describe('journal commands: parsed requests reach the runner', () => {
  it('diff maps every option, both --flag value and --flag=value forms', async () => {
    const r = await kubic([
      'diff',
      '--path',
      'src/a.ts',
      '--agent=w1',
      '--max-content-bytes',
      '0',
      '--session',
      'journal:s-1',
      '--json',
    ]);
    expect(r.code).toBe(0);
    expect(r.journal).toEqual([
      {
        command: 'diff',
        path: 'src/a.ts',
        agent: 'w1',
        maxContentBytes: 0,
        session: 'journal:s-1',
        json: true,
      },
    ]);
  });

  it('a bare command sends only its name', async () => {
    for (const command of ['diff', 'undo', 'log', 'status'] as const) {
      const r = await kubic([command]);
      expect(r.journal, command).toEqual([{ command }]);
    }
  });

  it('kubic commit -m <message> is kubic git commit (issue #268)', async () => {
    const plain = await kubic(['commit', '-m', 'fix: handle empty input']);
    expect(plain.code).toBe(0);
    expect(plain.git).toEqual([
      { command: 'commit', message: 'fix: handle empty input' },
    ]);
    expect(plain.journal).toEqual([]);
    const json = await kubic(['commit', '-m', 'wip', '--json']);
    expect(json.git).toEqual([
      { command: 'commit', message: 'wip', json: true },
    ]);
    // The verbatim message rule is the same as `git commit`'s: a message
    // that starts with `--` goes in the attached form.
    const flagLike = await kubic(['commit', '--message=--amend']);
    expect(flagLike.git).toEqual([{ command: 'commit', message: '--amend' }]);
  });

  it('undo takes the path operand (after -- too) and its flags', async () => {
    const r = await kubic([
      'undo',
      '--step',
      '--dry-run',
      '--force',
      '--json',
      '--session',
      's-2',
      '--',
      '--odd-name.txt',
    ]);
    expect(r.journal).toEqual([
      {
        command: 'undo',
        path: '--odd-name.txt',
        step: true,
        dryRun: true,
        force: true,
        json: true,
        session: 's-2',
      },
    ]);
  });

  it("the runner's exit code flows back (undo skips exit 1)", async () => {
    const r = await kubic(['undo'], { journal: () => 1 });
    expect(r.code).toBe(1);
  });

  it('log and status take --session and --json', async () => {
    for (const command of ['log', 'status'] as const) {
      const r = await kubic([command, '--json', '--session', 'abc']);
      expect(r.journal, command).toEqual([
        { command, json: true, session: 'abc' },
      ]);
    }
  });

  it('git subcommands map to typed requests', async () => {
    const r1 = await kubic(['git', 'status', '--json']);
    const r2 = await kubic(['git', 'log', '--max', '3']);
    const r3 = await kubic(['git', 'stage', 'a.txt', '--', '-b.txt']);
    const r4 = await kubic(['git', 'commit', '-m', 'fix: x', '--json']);
    const r5 = await kubic(['git', 'commit', '--message=--amend']);
    expect([...r1.git, ...r2.git, ...r3.git, ...r4.git, ...r5.git]).toEqual([
      { command: 'status', json: true },
      { command: 'log', max: 3 },
      { command: 'stage', paths: ['a.txt', '-b.txt'] },
      { command: 'commit', message: 'fix: x', json: true },
      { command: 'commit', message: '--amend' },
    ]);
    for (const r of [r1, r2, r3, r4, r5]) expect(r.code).toBe(0);
  });

  it("git's runner exit code flows back", async () => {
    const r = await kubic(['git', 'status'], { git: () => 1 });
    expect(r.code).toBe(1);
  });
});

describe('journal commands end to end over a temp journal', () => {
  const made: string[] = [];
  afterEach(() => {
    for (const dir of made.splice(0))
      rmSync(dir, { recursive: true, force: true });
  });

  function journalWithOneEdit(): { journalDir: string; root: string } {
    const journalDir = mkdtempSync(join(tmpdir(), 'kubic-cmd-j-'));
    const root = mkdtempSync(join(tmpdir(), 'kubic-cmd-ws-'));
    made.push(journalDir, root);
    new FileJournalStore(journalDir).append({
      path: 'a.txt',
      op: 'write',
      before: 'v1\n',
      after: 'v2\n',
      bytesDelta: 0,
      sessionId: 's1',
      agentId: 'root',
      toolCallId: 'call-1',
      timestamp: 1700000000000,
    });
    writeFileSync(join(root, 'a.txt'), 'v2\n');
    return { journalDir, root };
  }

  it('--json stdout is exactly one JSON document; stderr stays empty', async () => {
    const { journalDir, root } = journalWithOneEdit();
    for (const command of ['diff', 'log', 'status']) {
      const out: string[] = [];
      const r = await kubic([command, '--json'], {
        journal: (request) =>
          runJournalCommand(request, {
            journalDir,
            root,
            out: (line) => out.push(line),
            err: () => {
              throw new Error('--json must not log');
            },
          }),
      });
      expect(r.code, command).toBe(0);
      expect(r.err, command).toEqual([]);
      expect(out, command).toHaveLength(1);
      expect(() => JSON.parse(out[0] ?? ''), command).not.toThrow();
    }
  });

  it('a bad --session id is a usage error (exit 2) on stderr', async () => {
    const { journalDir, root } = journalWithOneEdit();
    const out: string[] = [];
    const r = await kubic(['diff', '--session', '../evil'], {
      journal: (request) =>
        runJournalCommand(request, {
          sessionsRoot: journalDir,
          root,
          out: (line) => out.push(line),
        }),
    });
    expect(r.code).toBe(2);
    expect(out).toEqual([]);
    expect(r.err).toEqual([
      'error: invalid --session id "../evil" (use [A-Za-z0-9_-] or journal:<id>)',
    ]);
  });
});
