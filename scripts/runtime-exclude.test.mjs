// Ship-vs-ignore split gate for `.kubic/` runtime state.
//
// This is NOT a unit test of the writer helper: it is the repo-level gate
// that enforces the split —
//
//   1. in ANY user repo, the first `kubic run` must leave nothing of
//      Kubic's own state in `git status` (scripted proof against real git
//      in a scratch repo);
//   2. `.kubic/config.toml` and `.kubic/roles/*.md` stay trackable — the
//      directory is mixed by construction, so `.kubic/` itself is never
//      ignored;
//   3. THIS repo ignores its whole `.kubic/` directory (ground truth from
//      `git check-ignore`, not from the file text), and nothing under it is
//      tracked.
//
// Real code, real git, zero network. Runs from `npm test` (node --test) so
// it gates CI alongside the other script gates.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  ensureRuntimeExcludeRules,
  RUNTIME_EXCLUDE_ENTRIES,
} from '@kubic/exec/runtime-exclude';

// The rule checker (`checkGitignoreSplit`) runs on
// a production path — `loadCliConfig` → `checkWorkspaceIgnoreSplit` on every
// `kubic config` / `kubic doctor`. The host module cannot be imported here
// (plain-node resolution does not map its `.js` specifiers), so this gate
// pins the call sites by source text and leaves the rule agreement itself to
// packages/host/src/config/runtime.test.ts, which imports the real module.

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' });
}

function gitCode(cwd, args) {
  return spawnSync('git', args, { cwd, encoding: 'utf8' }).status ?? 1;
}

function isIgnored(cwd, path) {
  return gitCode(cwd, ['check-ignore', '-q', path]) === 0;
}

function porcelain(cwd) {
  return git(cwd, ['status', '--porcelain=v1'])
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

// A user repo that already has the committed half of the split in place,
// then runs there.
const scratchRepos = [];
after(() => {
  for (const dir of scratchRepos) rmSync(dir, { recursive: true, force: true });
});

function scratchUserRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'kubic-gate-'));
  scratchRepos.push(dir);
  git(dir, ['init', '-q', '-b', 'main', '.']);
  git(dir, ['config', 'user.email', 'test@example.com']);
  git(dir, ['config', 'user.name', 'test']);
  writeFileSync(join(dir, 'README.md'), '# scratch\n');
  writeFileSync(join(dir, '.gitignore'), 'node_modules/\n');
  mkdirSync(join(dir, '.kubic', 'roles'), { recursive: true });
  writeFileSync(join(dir, '.kubic', 'roles', 'reviewer.md'), '# reviewer\n');
  writeFileSync(
    join(dir, '.kubic', 'config.toml'),
    '[agent]\nname = "kubic"\n',
  );
  git(dir, ['add', '.kubic', '.gitignore', 'README.md']);
  // A developer's global commit.gpgsign must not break the scratch commit.
  git(dir, ['-c', 'commit.gpgsign=false', 'commit', '-qm', 'init']);
  return dir;
}

// What a real run leaves on disk, at the real paths.
function simulateRuntimeState(dir) {
  for (const sub of ['journal', 'audit', 'sessions', 'artifacts']) {
    mkdirSync(join(dir, '.kubic', sub), { recursive: true });
  }
  writeFileSync(join(dir, '.kubic', 'journal', 'index.jsonl'), '{}\n');
  mkdirSync(join(dir, '.kubic', 'journal', 'blobs'), { recursive: true });
  writeFileSync(join(dir, '.kubic', 'journal', 'blobs', 'abc'), 'x\n');
  writeFileSync(join(dir, '.kubic', 'audit', 'audit.jsonl'), '{}\n');
  writeFileSync(join(dir, '.kubic', 'sessions', 's1'), 'x\n');
  writeFileSync(join(dir, '.kubic', 'artifacts', 'out.txt'), 'x\n');
}

describe('kubic runtime state never reaches the commit path', () => {
  it('keeps a user repo clean after run state lands', () => {
    const dir = scratchUserRepo();
    // Before the rules ship: the state is untracked and visible — the bug.
    simulateRuntimeState(dir);
    assert.ok(
      porcelain(dir).some((line) => line.includes('.kubic')),
      'fixture must reproduce the leak before the rules are written',
    );

    ensureRuntimeExcludeRules({ cwd: dir });

    assert.deepEqual(
      porcelain(dir),
      [],
      'no .kubic/ runtime path may surface in git status after the rules ship',
    );
    // Idempotent: a second run (the second `kubic run`) changes nothing.
    assert.equal(ensureRuntimeExcludeRules({ cwd: dir }).changed, false);
    assert.deepEqual(porcelain(dir), []);
  });

  it('keeps .kubic/roles and .kubic/config.toml trackable', () => {
    const dir = scratchUserRepo();
    ensureRuntimeExcludeRules({ cwd: dir });
    assert.equal(isIgnored(dir, '.kubic/roles/reviewer.md'), false);
    assert.equal(isIgnored(dir, '.kubic/config.toml'), false);
    assert.equal(isIgnored(dir, '.kubic/roles/tester.md'), false);

    // Committable, not merely unignored: stage and commit a new role.
    writeFileSync(join(dir, '.kubic', 'roles', 'tester.md'), '# tester\n');
    git(dir, ['add', '.kubic/roles/tester.md']);
    assert.match(
      git(dir, ['status', '--porcelain=v1', '--', '.kubic/roles']),
      /A {2}\.kubic\/roles\/tester\.md/,
    );
  });

  it('covers every shipped runtime entry and nothing of the committed half', () => {
    const dir = scratchUserRepo();
    ensureRuntimeExcludeRules({ cwd: dir });
    for (const entry of RUNTIME_EXCLUDE_ENTRIES) {
      const probe = `${entry}probe`;
      assert.equal(isIgnored(dir, probe), true, `${probe} must be ignored`);
    }
    assert.deepEqual(
      porcelain(dir),
      [],
      'a scratch repo with only committed-half content is clean',
    );
    assert.equal(isIgnored(dir, '.kubic/'), false);
  });

  it('refuses a hostile entry instead of injecting patterns', () => {
    // An entry is written one line at a time: a newline in one would inject
    // arbitrary gitignore patterns into .git/info/exclude. Refused at render
    // time — the file is untouched and the patterns never take effect.
    const dir = scratchUserRepo();
    ensureRuntimeExcludeRules({ cwd: dir });
    const file = join(dir, '.git', 'info', 'exclude');
    const before = readFileSync(file, 'utf8');

    const result = ensureRuntimeExcludeRules({
      cwd: dir,
      entries: ['.kubic/journal/', 'x\n*.log\n!keep/'],
    });

    assert.equal(result.skipped, 'unavailable');
    assert.equal(result.changed, false);
    assert.equal(readFileSync(file, 'utf8'), before);
    writeFileSync(join(dir, 'secret.log'), 'token=abc\n');
    assert.equal(isIgnored(dir, 'secret.log'), false);
  });

  it('refuses a metacharacter entry instead of writing a wildcard rule', () => {
    // The entry is written verbatim as one gitignore pattern: `*/` would
    // hide every new path from `git add -A` and the pre-merge clean-tree
    // guard. Refused at render time — the file is untouched and the
    // wildcard never takes effect.
    const dir = scratchUserRepo();
    ensureRuntimeExcludeRules({ cwd: dir });
    const file = join(dir, '.git', 'info', 'exclude');
    const before = readFileSync(file, 'utf8');

    const result = ensureRuntimeExcludeRules({
      cwd: dir,
      entries: ['.kubic/journal/', '*/'],
    });

    assert.equal(result.skipped, 'unavailable');
    assert.equal(result.changed, false);
    assert.equal(readFileSync(file, 'utf8'), before);
    writeFileSync(join(dir, 'src-new.txt'), 'x\n');
    assert.equal(isIgnored(dir, 'src-new.txt'), false);
  });
});

describe('this repo ships the split', () => {
  it('wires the rules into every mode that creates state', () => {
    // Criterion 1 is only met if the mechanism is actually reachable from
    // the CLI: `kubic run` and `kubic tui` (a TUI session creates in-repo
    // state too) must both ship the rules before they create state. Pin the dispatch,
    // not a helper. The dispatch moved to apps/kubic/src/dispatch.ts
    // (main.ts is the thin entry); the seam it calls is deps.ensureRuntimeExclude.
    const dispatch = readFileSync(
      join(ROOT, 'apps', 'kubic', 'src', 'dispatch.ts'),
      'utf8',
    );
    // The commander migration keeps the pre-parse step: the state-creating
    // modes are one named set, checked before the runtime-exclude call —
    // skipped only for a help request (`--help` is side-effect
    // free, commander answers it before any action).
    const call = dispatch.match(
      /if \(\s*command !== undefined &&\s*STATE_CREATING_COMMANDS\.has\(command\) &&\s*!helpRequested\s*\) \{\n\s*deps\.ensureRuntimeExclude\(/,
    );
    assert.ok(
      call !== null,
      'apps/kubic/src/dispatch.ts must call the runtime-exclude seam for run + tui',
    );
    // No mode that writes state may be added without it: the set names
    // exactly the state-creating commands.
    const set = dispatch.match(
      /const STATE_CREATING_COMMANDS[^=]*= new Set\(\[([^\]]*)\]\)/,
    );
    assert.ok(set !== null, 'dispatch.ts must declare STATE_CREATING_COMMANDS');
    assert.deepEqual(
      [...set[1].matchAll(/'([^']+)'/g)].map((m) => m[1]).sort(),
      ['run', 'tui'],
    );
    // The dispatch delegates to the injected seam, so CLI-reachability needs
    // the production wiring too (the pre pin asserted exactly this,
    // against main.ts): the entry point must wire the real rules into the
    // seam it hands the dispatch — a no-op seam must not pass this test.
    // The pin reads the wiring with its argument (the entry list).
    const main = readFileSync(
      join(ROOT, 'apps', 'kubic', 'src', 'main.ts'),
      'utf8',
    );
    assert.match(
      main,
      /ensureRuntimeExclude:\s*\(entries\)\s*=>\s*ensureRuntimeExcludeRules\(\{\s*cwd: process\.cwd\(\),\s*entries\s*\}\)/,
      'apps/kubic/src/main.ts must wire ensureRuntimeExcludeRules into the dispatch seam (with its entries)',
    );
    assert.match(
      dispatch,
      /deps\.ensureRuntimeExclude\(RUNTIME_EXCLUDE_ENTRIES\)/,
      'apps/kubic/src/dispatch.ts must ship the runtime prefixes',
    );
  });
  // `checkGitignoreSplit` is the rule checker, and it
  // is invoked by a real gate — `loadCliConfig` runs it on every
  // `kubic config` / `kubic doctor`, not only in a unit test. Pin the call
  // sites so the wiring cannot be dropped silently.
  it('invokes the ignore-split check from the production config path', () => {
    const runtime = readFileSync(
      join(ROOT, 'apps', 'kubic', 'src', 'config-runtime.ts'),
      'utf8',
    );
    assert.match(
      runtime,
      // The check resolves the toplevel and the exclude the
      // way the writer does, so the runner (exec's sync git probe) is part
      // of the pinned wiring — dropping it would re-break worktrees.
      /checkWorkspaceIgnoreSplit\(\s*bridge,\s*projectRoot,\s*gitSync/,
      'apps/kubic/src/config-runtime.ts must run the ignore-split check on the real repo',
    );
    const hostRuntime = readFileSync(
      join(ROOT, 'packages', 'host', 'src', 'config', 'runtime.ts'),
      'utf8',
    );
    assert.match(
      hostRuntime,
      /export function checkWorkspaceIgnoreSplit/,
      'the production ignore-split check lives in packages/host/src/config/runtime.ts',
    );
    const probe = readFileSync(
      join(ROOT, 'packages', 'host', 'src', 'config', 'config-doctor.ts'),
      'utf8',
    );
    assert.match(
      probe,
      /ignoreSplitMissing/,
      'doctor must report missing runtime-ignore prefixes',
    );
  });

  it('agrees with the git ground truth for this repo, rule by rule', () => {
    // Git decides independently: every shipped rule must really be ignored
    // here, and the committed half must stay trackable. The production
    // checker reads these same two files (it is pinned above), so this is
    // the ground truth its verdict is measured against.
    const exclude = join(ROOT, '.git', 'info', 'exclude');
    const productionInput =
      readFileSync(join(ROOT, '.gitignore'), 'utf8') +
      '\n' +
      (existsSync(exclude) ? readFileSync(exclude, 'utf8') : '');
    for (const entry of RUNTIME_EXCLUDE_ENTRIES) {
      assert.equal(isIgnored(ROOT, `${entry}probe`), true);
      assert.ok(
        productionInput.includes(entry),
        `the checker's input must carry the rule ${entry}`,
      );
    }
    assert.equal(isIgnored(ROOT, '.kubic/config.toml'), true);
    assert.equal(isIgnored(ROOT, '.kubic/roles/reviewer.md'), true);
  });

  it('ignores its own .kubic/ directory, so nothing under it is tracked', () => {
    for (const entry of RUNTIME_EXCLUDE_ENTRIES) {
      assert.equal(
        isIgnored(ROOT, `${entry}probe`),
        true,
        `${entry} must be ignored by this repo's .gitignore`,
      );
    }
    assert.equal(isIgnored(ROOT, '.kubic/roles/reviewer.md'), true);
    assert.equal(isIgnored(ROOT, '.kubic/config.toml'), true);

    // No path under .kubic/ may be tracked: a force-added file would sit in
    // history while `git status` stays quiet.
    const tracked = git(ROOT, ['ls-files', '.kubic'])
      .split('\n')
      .filter((line) => line.length > 0);
    assert.deepEqual(
      tracked,
      [],
      `nothing under .kubic/ may be tracked: ${tracked.join(', ')}`,
    );
  });
});
