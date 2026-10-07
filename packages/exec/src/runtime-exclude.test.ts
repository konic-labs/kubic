// Runtime-state exclude rules.
//
// The split: `.kubic/config.toml` + `.kubic/roles/*.md` are committed;
// `.kubic/{sessions,journal,artifacts,audit}/` is runtime state
// and must never reach the commit path. The mechanism writes the runtime
// half into the repository's LOCAL, uncommitted exclude file
// (`.git/info/exclude`) so a user's committed `.gitignore` is never
// dirtied, and `.kubic/` itself stays unignored so roles stay committable.
//
// These tests drive real git in sandboxed scratch repositories (scrubbed env,
// never the inherited one) with no mocks: the assertions are the exact
// user-visible promise from the issue. Only packages/exec may spawn processes
// and touch node:fs.
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
import {
  createGitSandbox,
  disposeAllGitSandboxes,
  type GitSandbox,
} from './test-support/git-sandbox.js';

const scratchDirs: string[] = [];

afterEach(() => {
  disposeAllGitSandboxes();
  for (const dir of scratchDirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

// Plain temp dir, for the not-a-repo path that never touches git.
function scratchDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  scratchDirs.push(dir);
  return dir;
}

function isIgnored(repo: GitSandbox, path: string): boolean {
  return repo.gitResult(['check-ignore', '-q', path]).status === 0;
}

// A scratch repo with the committed half of the split already in place:
// tracked role documents and config, exactly like a user repo that set
// Kubic up before its first run. Activated: ensureRuntimeExcludeRules
// resolves the repo by spawning git on the inherited environment, so
// process.env itself must be the sandbox's while it runs.
function roleScratchRepo(): GitSandbox {
  const repo = createGitSandbox({
    prefix: 'kubic-exclude-',
    injectProcessEnv: true,
  });
  writeFileSync(join(repo.path, 'README.md'), '# scratch\n');
  mkdirSync(join(repo.path, '.kubic', 'roles'), { recursive: true });
  writeFileSync(
    join(repo.path, '.kubic', 'roles', 'reviewer.md'),
    '# reviewer\n',
  );
  writeFileSync(
    join(repo.path, '.kubic', 'config.toml'),
    '[agent]\nname = "kubic"\n',
  );
  repo.git(['add', '.kubic', 'README.md']);
  // No signing / hooks from the developer's global config (sandbox-local
  // config pins both; --no-verify is belt and braces).
  repo.git(['commit', '--no-verify', '-qm', 'init']);
  return repo;
}

// What the first `kubic run` leaves behind: journal entries, the audit
// ledger, session scratch, artifacts — at the exact paths the runtime uses.
function createRuntimeState(repo: GitSandbox): void {
  const dir = repo.path;
  for (const sub of ['journal', 'audit', 'sessions', 'artifacts']) {
    mkdirSync(join(dir, '.kubic', sub), { recursive: true });
  }
  writeFileSync(join(dir, '.kubic', 'journal', 'index.jsonl'), '{}\n');
  writeFileSync(join(dir, '.kubic', 'audit', 'audit.jsonl'), '{}\n');
  writeFileSync(join(dir, '.kubic', 'sessions', 's1'), 'x\n');
  writeFileSync(join(dir, '.kubic', 'artifacts', 'out.txt'), 'x\n');
}

function status(repo: GitSandbox): string[] {
  return repo
    .git(['status', '--porcelain=v1'])
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

describe('applyRuntimeExcludeBlock', () => {
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

describe('ensureRuntimeExcludeRules', () => {
  it('writes the block into the repo-local exclude file', () => {
    const repo = roleScratchRepo();
    const result = ensureRuntimeExcludeRules({ cwd: repo.path });

    expect(result.skipped).toBeUndefined();
    expect(result.changed).toBe(true);
    expect(realpathSync(result.path as string)).toBe(
      realpathSync(join(repo.path, '.git', 'info', 'exclude')),
    );
    expect(readFileSync(result.path as string, 'utf8')).toContain(
      RUNTIME_EXCLUDE_BEGIN,
    );
  });

  it('keeps runtime state out of git status while roles stay trackable', () => {
    const repo = roleScratchRepo();
    ensureRuntimeExcludeRules({ cwd: repo.path });
    createRuntimeState(repo);

    // The whole promise of the issue: nothing of Kubic's own state in the
    // user's commit path.
    expect(status(repo)).toEqual([]);

    // The committed half stays committable.
    expect(isIgnored(repo, '.kubic/roles/reviewer.md')).toBe(false);
    expect(isIgnored(repo, '.kubic/config.toml')).toBe(false);
    expect(isIgnored(repo, '.kubic/roles/tester.md')).toBe(false);
    writeFileSync(
      join(repo.path, '.kubic', 'roles', 'tester.md'),
      '# tester\n',
    );
    repo.git(['add', '.kubic/roles/tester.md']);
    expect(repo.git(['status', '--porcelain=v1', '--', '.kubic/roles'])).toBe(
      'A  .kubic/roles/tester.md\n',
    );
  });

  it('is idempotent: a second call rewrites nothing', () => {
    const repo = roleScratchRepo();
    const first = ensureRuntimeExcludeRules({ cwd: repo.path });
    const afterFirst = readFileSync(first.path as string, 'utf8');

    const second = ensureRuntimeExcludeRules({ cwd: repo.path });

    expect(second.changed).toBe(false);
    expect(readFileSync(second.path as string, 'utf8')).toBe(afterFirst);
  });

  it('preserves unrelated exclude entries', () => {
    const repo = roleScratchRepo();
    const file = join(repo.path, '.git', 'info', 'exclude');
    writeFileSync(file, '# other tool\nscratch-notes/\n');

    ensureRuntimeExcludeRules({ cwd: repo.path });

    const text = readFileSync(file, 'utf8');
    expect(text).toContain('# other tool');
    expect(text).toContain('scratch-notes/');
    expect(text).toContain(RUNTIME_EXCLUDE_BEGIN);
  });

  it('re-syncs a stale managed block in place (no duplication)', () => {
    const repo = roleScratchRepo();
    const file = join(repo.path, '.git', 'info', 'exclude');
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

    const result = ensureRuntimeExcludeRules({ cwd: repo.path });

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
    const repo = roleScratchRepo();
    // A linked worktree of the repository, checked out elsewhere: its
    // `.git` is a file pointing at the common dir.
    const worktree = join(scratchDir('kubic-linked-'), 'linked');
    repo.git(['worktree', 'add', '-q', worktree, '-b', 'linked']);

    const result = ensureRuntimeExcludeRules({ cwd: worktree });

    expect(result.changed).toBe(true);
    expect(realpathSync(result.path as string)).toBe(
      realpathSync(join(repo.path, '.git', 'info', 'exclude')),
    );
    // One file per repository: the main checkout sees the rules too.
    mkdirSync(join(repo.path, '.kubic', 'audit'), { recursive: true });
    writeFileSync(join(repo.path, '.kubic', 'audit', 'audit.jsonl'), '{}\n');
    expect(status(repo)).toEqual([]);
  });
});

describe('refusing hostile exclude entries', () => {
  it('refuses to render an entry carrying control characters', () => {
    // An entry is written one line at a time: a newline injects arbitrary
    // gitignore patterns, and a literal ESC would reach whatever reads the
    // file. Refused, never stripped — a hostile entry must not be silently
    // repaired into a different rule.
    expect(() =>
      applyRuntimeExcludeBlock('', ['.kubic/journal/', 'x\n*.log\n!keep/']),
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
        () => applyRuntimeExcludeBlock('', ['.kubic/journal/', entry]),
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
    const repo = roleScratchRepo();
    // First run: the shipped block lands.
    ensureRuntimeExcludeRules({ cwd: repo.path });
    const file = join(repo.path, '.git', 'info', 'exclude');
    const before = readFileSync(file, 'utf8');

    // Second run with a wildcard entry: refused, nothing written.
    const result = ensureRuntimeExcludeRules({
      cwd: repo.path,
      entries: ['.kubic/journal/', '*/'],
    });
    expect(result.skipped).toBe('unavailable');
    expect(result.changed).toBe(false);
    expect(readFileSync(file, 'utf8')).toBe(before);

    // Ground truth: no `*/` rule is in force — a new file stays visible
    // and stageable.
    writeFileSync(join(repo.path, 'src-new.txt'), 'x\n');
    expect(isIgnored(repo, 'src-new.txt')).toBe(false);
    expect(status(repo)).toEqual(['?? src-new.txt']);
  });

  it('never writes a hostile entry into the exclude file', () => {
    const repo = roleScratchRepo();
    // First run: the shipped block lands.
    ensureRuntimeExcludeRules({ cwd: repo.path });
    const file = join(repo.path, '.git', 'info', 'exclude');
    const before = readFileSync(file, 'utf8');

    // Second run with a hostile entry: refused, nothing written.
    const result = ensureRuntimeExcludeRules({
      cwd: repo.path,
      entries: ['.kubic/journal/', 'x\n*.log\n!keep/'],
    });
    expect(result.skipped).toBe('unavailable');
    expect(result.changed).toBe(false);
    expect(readFileSync(file, 'utf8')).toBe(before);

    // Ground truth: the injected patterns are not in force.
    writeFileSync(join(repo.path, 'secret.log'), 'token=abc\n');
    expect(isIgnored(repo, 'secret.log')).toBe(false);
    expect(status(repo)).toEqual(['?? secret.log']);
  });
});
