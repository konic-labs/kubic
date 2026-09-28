// Runtime-state exclude rules (issue #91; design §35, D34/D35).
//
// The split: `.kubic/config.toml` + `.kubic/roles/*.md` are committed;
// `.kubic/{sessions,journal,artifacts,wt,orchestrator}/` is runtime state
// and must never reach the commit path. The mechanism writes the runtime
// half into the repository's LOCAL, uncommitted exclude file
// (`.git/info/exclude`) so a user's committed `.gitignore` is never
// dirtied, and `.kubic/` itself stays unignored so roles stay committable.
//
// These tests drive real git in scratch repositories (no mocks): the
// assertions are the exact user-visible promise from the issue. Only
// packages/exec may spawn processes and touch node:fs (§9).
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  applyRuntimeExcludeBlock,
  ensureRuntimeExcludeRules,
  RUNTIME_EXCLUDE_BEGIN,
  RUNTIME_EXCLUDE_END,
  RUNTIME_EXCLUDE_ENTRIES,
  RuntimeExcludeError,
} from './runtime-exclude.js';

const scratchDirs: string[] = [];

afterEach(() => {
  for (const dir of scratchDirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

function scratchDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  scratchDirs.push(dir);
  return dir;
}

function git(cwd: string, args: string[]): string {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`);
  }
  return result.stdout;
}

function gitExit(cwd: string, args: string[]): number {
  return spawnSync('git', args, { cwd, encoding: 'utf8' }).status ?? 1;
}

function isIgnored(cwd: string, path: string): boolean {
  return gitExit(cwd, ['check-ignore', '-q', path]) === 0;
}

// A scratch repo with the committed half of the split already in place:
// tracked role documents and config, exactly like a user repo that set
// Kubic up before its first run.
function roleScratchRepo(): string {
  const dir = scratchDir('kubic-exclude-');
  git(dir, ['init', '-q', '-b', 'main', '.']);
  git(dir, ['config', 'user.email', 'test@example.com']);
  git(dir, ['config', 'user.name', 'test']);
  writeFileSync(join(dir, 'README.md'), '# scratch\n');
  mkdirSync(join(dir, '.kubic', 'roles'), { recursive: true });
  writeFileSync(join(dir, '.kubic', 'roles', 'reviewer.md'), '# reviewer\n');
  writeFileSync(
    join(dir, '.kubic', 'config.toml'),
    '[agent]\nname = "kubic"\n',
  );
  git(dir, ['add', '.kubic', 'README.md']);
  // No signing / hooks from the developer's global config.
  git(dir, [
    '-c',
    'commit.gpgsign=false',
    'commit',
    '--no-verify',
    '-qm',
    'init',
  ]);
  return dir;
}

// What the first `kubic run` / `kubic orchestrate` leaves behind: journal
// entries, orchestrator session state, agent worktrees, session scratch,
// artifacts — at the exact paths the runtime uses.
function createRuntimeState(dir: string): void {
  for (const sub of ['journal', 'orchestrator', 'sessions', 'artifacts']) {
    mkdirSync(join(dir, '.kubic', sub), { recursive: true });
  }
  writeFileSync(join(dir, '.kubic', 'journal', 'index.jsonl'), '{}\n');
  writeFileSync(join(dir, '.kubic', 'orchestrator', 'orch-1.json'), '{}\n');
  writeFileSync(join(dir, '.kubic', 'sessions', 's1'), 'x\n');
  writeFileSync(join(dir, '.kubic', 'artifacts', 'out.txt'), 'x\n');
  git(dir, [
    'worktree',
    'add',
    '-q',
    '.kubic/wt/worker-1',
    '-b',
    'kubic/worker-1',
  ]);
}

function status(dir: string): string[] {
  return git(dir, ['status', '--porcelain=v1'])
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

describe('applyRuntimeExcludeBlock (issue #91)', () => {
  it('renders the managed block with every runtime entry', () => {
    const { text, changed } = applyRuntimeExcludeBlock('');
    expect(changed).toBe(true);
    expect(text).toContain(RUNTIME_EXCLUDE_BEGIN);
    expect(text).toContain(RUNTIME_EXCLUDE_END);
    for (const entry of RUNTIME_EXCLUDE_ENTRIES) expect(text).toContain(entry);
  });

  it('never ignores .kubic/ itself (the committed half must stay so)', () => {
    const { text } = applyRuntimeExcludeBlock('');
    const patterns = text
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !line.startsWith('#'));
    for (const pattern of patterns) {
      expect(pattern).not.toBe('.kubic/');
      expect(pattern.startsWith('.kubic/')).toBe(true);
    }
  });
});

describe('ensureRuntimeExcludeRules (issue #91)', () => {
  it('writes the block into the repo-local exclude file', () => {
    const dir = roleScratchRepo();
    const result = ensureRuntimeExcludeRules({ cwd: dir });

    expect(result.skipped).toBeUndefined();
    expect(result.changed).toBe(true);
    expect(realpathSync(result.path as string)).toBe(
      realpathSync(join(dir, '.git', 'info', 'exclude')),
    );
    expect(readFileSync(result.path as string, 'utf8')).toContain(
      RUNTIME_EXCLUDE_BEGIN,
    );
  });

  it('keeps runtime state out of git status while roles stay trackable', () => {
    const dir = roleScratchRepo();
    ensureRuntimeExcludeRules({ cwd: dir });
    createRuntimeState(dir);

    // The whole promise of the issue: nothing of Kubic's own state in the
    // user's commit path.
    expect(status(dir)).toEqual([]);

    // The committed half stays committable.
    expect(isIgnored(dir, '.kubic/roles/reviewer.md')).toBe(false);
    expect(isIgnored(dir, '.kubic/config.toml')).toBe(false);
    expect(isIgnored(dir, '.kubic/roles/tester.md')).toBe(false);
    writeFileSync(join(dir, '.kubic', 'roles', 'tester.md'), '# tester\n');
    git(dir, ['add', '.kubic/roles/tester.md']);
    expect(git(dir, ['status', '--porcelain=v1', '--', '.kubic/roles'])).toBe(
      'A  .kubic/roles/tester.md\n',
    );
  });

  it('is idempotent: a second call rewrites nothing', () => {
    const dir = roleScratchRepo();
    const first = ensureRuntimeExcludeRules({ cwd: dir });
    const afterFirst = readFileSync(first.path as string, 'utf8');

    const second = ensureRuntimeExcludeRules({ cwd: dir });

    expect(second.changed).toBe(false);
    expect(readFileSync(second.path as string, 'utf8')).toBe(afterFirst);
  });

  it('preserves unrelated exclude entries', () => {
    const dir = roleScratchRepo();
    const file = join(dir, '.git', 'info', 'exclude');
    writeFileSync(file, '# other tool\nscratch-notes/\n');

    ensureRuntimeExcludeRules({ cwd: dir });

    const text = readFileSync(file, 'utf8');
    expect(text).toContain('# other tool');
    expect(text).toContain('scratch-notes/');
    expect(text).toContain(RUNTIME_EXCLUDE_BEGIN);
  });

  it('re-syncs a stale managed block in place (no duplication)', () => {
    const dir = roleScratchRepo();
    const file = join(dir, '.git', 'info', 'exclude');
    writeFileSync(
      file,
      [
        '# other tool',
        'scratch-notes/',
        RUNTIME_EXCLUDE_BEGIN,
        '.kubic/journal/',
        RUNTIME_EXCLUDE_END,
        'tail-entry/',
        '',
      ].join('\n'),
    );

    const result = ensureRuntimeExcludeRules({ cwd: dir });

    expect(result.changed).toBe(true);
    const text = readFileSync(file, 'utf8');
    expect(text).toContain('# other tool');
    expect(text).toContain('scratch-notes/');
    expect(text).toContain('tail-entry/');
    for (const entry of RUNTIME_EXCLUDE_ENTRIES) expect(text).toContain(entry);
    expect(text.split(RUNTIME_EXCLUDE_BEGIN)).toHaveLength(2);
    expect(text.split(RUNTIME_EXCLUDE_END)).toHaveLength(2);
  });

  it('skips (never throws) outside a git repository', () => {
    const dir = scratchDir('kubic-norepo-');
    const result = ensureRuntimeExcludeRules({ cwd: dir });
    expect(result.skipped).toBe('not-a-git-repo');
    expect(result.changed).toBe(false);
    expect(existsSync(join(dir, '.git'))).toBe(false);
  });

  it('writes the one shared file from a linked worktree', () => {
    const dir = roleScratchRepo();
    // The orchestrator's own layout: the agent worktree lives under
    // .kubic/wt/ so no run-time path can ever surface.
    git(dir, [
      'worktree',
      'add',
      '-q',
      '.kubic/wt/worker-1',
      '-b',
      'kubic/worker-1',
    ]);
    mkdirSync(join(dir, '.kubic', 'wt'), { recursive: true });
    const worktree = join(dir, '.kubic', 'wt', 'worker-1');

    const result = ensureRuntimeExcludeRules({ cwd: worktree });

    expect(result.changed).toBe(true);
    expect(realpathSync(result.path as string)).toBe(
      realpathSync(join(dir, '.git', 'info', 'exclude')),
    );
    // One file per repository: the main checkout sees the rules too.
    mkdirSync(join(dir, '.kubic', 'orchestrator'), { recursive: true });
    writeFileSync(join(dir, '.kubic', 'orchestrator', 'x.json'), '{}\n');
    expect(status(dir)).toEqual([]);
  });
});

describe('refusing hostile exclude entries (issue #133 review)', () => {
  it('refuses to render an entry carrying control characters', () => {
    // An entry is written one line at a time: a newline injects arbitrary
    // gitignore patterns, and a literal ESC would reach whatever reads the
    // file. Refused, never stripped — a hostile entry must not be silently
    // repaired into a different rule.
    expect(() =>
      applyRuntimeExcludeBlock('', ['.kubic/wt/', 'x\n*.log\n!keep/']),
    ).toThrow(RuntimeExcludeError);
    expect(() => applyRuntimeExcludeBlock('', ['wt\u001b[31mX/'])).toThrow(
      RuntimeExcludeError,
    );
    expect(() => applyRuntimeExcludeBlock('', ['wt\u0085X/'])).toThrow(
      RuntimeExcludeError,
    );
    // The message names the rule and never echoes the hostile bytes.
    try {
      applyRuntimeExcludeBlock('', ['x\n*.log\n!keep/']);
      expect.unreachable();
    } catch (error) {
      expect((error as Error).message).not.toContain('*.log');
      expect((error as Error).message).not.toContain('\n');
    }
  });

  it('refuses to render an entry carrying gitignore metacharacters', () => {
    // The entry is written verbatim as one gitignore pattern: `*`/`?`/`[`/
    // `]` make it match paths other than the one it names, a leading `#`
    // turns it into a comment, and a backslash escapes the next character
    // (a trailing one leaves an entry that matches nothing). Refused, never
    // escaped into a different rule.
    for (const entry of [
      '*/',
      'wt?.log/',
      'w[abc]/',
      'w]x/',
      '#comment/',
      'x\\/',
      'a\\b/',
    ]) {
      expect(
        () => applyRuntimeExcludeBlock('', ['.kubic/wt/', entry]),
        entry,
      ).toThrow(RuntimeExcludeError);
    }
    // The message names the rule and never echoes the hostile entry.
    try {
      applyRuntimeExcludeBlock('', ['*/']);
      expect.unreachable();
    } catch (error) {
      expect((error as Error).message).not.toContain('*');
      expect((error as Error).message).not.toContain('\\');
    }
  });

  it('never writes a metacharacter entry into the exclude file', () => {
    const dir = roleScratchRepo();
    // First run: the shipped block lands.
    ensureRuntimeExcludeRules({ cwd: dir });
    const file = join(dir, '.git', 'info', 'exclude');
    const before = readFileSync(file, 'utf8');

    // Second run with a wildcard entry: refused, nothing written.
    const result = ensureRuntimeExcludeRules({
      cwd: dir,
      entries: ['.kubic/wt/', '*/'],
    });
    expect(result.skipped).toBe('unavailable');
    expect(result.changed).toBe(false);
    expect(readFileSync(file, 'utf8')).toBe(before);

    // Ground truth: no `*/` rule is in force — a new file stays visible
    // and stageable.
    writeFileSync(join(dir, 'src-new.txt'), 'x\n');
    expect(isIgnored(dir, 'src-new.txt')).toBe(false);
    expect(status(dir)).toEqual(['?? src-new.txt']);
  });

  it('never writes a hostile entry into the exclude file', () => {
    const dir = roleScratchRepo();
    // First run: the shipped block lands.
    ensureRuntimeExcludeRules({ cwd: dir });
    const file = join(dir, '.git', 'info', 'exclude');
    const before = readFileSync(file, 'utf8');

    // Second run with a hostile entry: refused, nothing written.
    const result = ensureRuntimeExcludeRules({
      cwd: dir,
      entries: ['.kubic/wt/', 'x\n*.log\n!keep/'],
    });
    expect(result.skipped).toBe('unavailable');
    expect(result.changed).toBe(false);
    expect(readFileSync(file, 'utf8')).toBe(before);

    // Ground truth: the injected patterns are not in force.
    writeFileSync(join(dir, 'secret.log'), 'token=abc\n');
    expect(isIgnored(dir, 'secret.log')).toBe(false);
    expect(status(dir)).toEqual(['?? secret.log']);
  });
});
