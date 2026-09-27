// Ship-vs-ignore split gate for `.kubic/` runtime state (issue #91).
//
// This is NOT a unit test of the writer helper: it is the repo-level gate
// that enforces the split the docs and the design claim —
//
//   1. in ANY user repo, the first `kubic run` / `kubic orchestrate` must
//      leave nothing of Kubic's own state in `git status` (scripted proof
//      against real git in a scratch repo, including a real worktree under
//      `.kubic/wt/`);
//   2. `.kubic/config.toml` and `.kubic/roles/*.md` stay trackable — the
//      directory is mixed by construction, so `.kubic/` itself is never
//      ignored;
//   3. THIS repo ships the same split in its `.gitignore` (ground truth
//      from `git check-ignore`, not from the file text), and no runtime
//      path is tracked;
//   4. `docs/cli/configuration.md` states exactly the rules that ship.
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
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  ensureRuntimeExcludeRules,
  RUNTIME_EXCLUDE_ENTRIES,
} from '../packages/exec/src/runtime-exclude.ts';

// Issue #90 criterion 5: the rule checker (`checkGitignoreSplit`) now runs on
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
// then runs and orchestrates there.
function scratchUserRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'kubic-gate-'));
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
  git(dir, ['commit', '-qm', 'init']);
  return dir;
}

// What a real run/orchestrate leaves on disk, at the real paths.
function simulateRuntimeState(dir) {
  for (const sub of ['journal', 'orchestrator', 'sessions', 'artifacts']) {
    mkdirSync(join(dir, '.kubic', sub), { recursive: true });
  }
  writeFileSync(join(dir, '.kubic', 'journal', 'index.jsonl'), '{}\n');
  mkdirSync(join(dir, '.kubic', 'journal', 'blobs'), { recursive: true });
  writeFileSync(join(dir, '.kubic', 'journal', 'blobs', 'abc'), 'x\n');
  writeFileSync(join(dir, '.kubic', 'orchestrator', 'orch-1.json'), '{}\n');
  writeFileSync(join(dir, '.kubic', 'sessions', 's1'), 'x\n');
  writeFileSync(join(dir, '.kubic', 'artifacts', 'out.txt'), 'x\n');
  // The orchestrator's agent checkout: a real linked worktree.
  git(dir, [
    'worktree',
    'add',
    '-q',
    '.kubic/wt/worker-1',
    '-b',
    'kubic/worker-1',
  ]);
}

describe('kubic runtime state never reaches the commit path (issue #91)', () => {
  it('keeps a user repo clean after run/orchestrate state lands', () => {
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

  it('refuses a hostile entry instead of injecting patterns (issue #133 review)', () => {
    // An entry is written one line at a time: a newline in one would inject
    // arbitrary gitignore patterns into .git/info/exclude. Refused at render
    // time — the file is untouched and the patterns never take effect.
    const dir = scratchUserRepo();
    ensureRuntimeExcludeRules({ cwd: dir });
    const file = join(dir, '.git', 'info', 'exclude');
    const before = readFileSync(file, 'utf8');

    const result = ensureRuntimeExcludeRules({
      cwd: dir,
      entries: ['.kubic/wt/', 'x\n*.log\n!keep/'],
    });

    assert.equal(result.skipped, 'unavailable');
    assert.equal(result.changed, false);
    assert.equal(readFileSync(file, 'utf8'), before);
    writeFileSync(join(dir, 'secret.log'), 'token=abc\n');
    assert.equal(isIgnored(dir, 'secret.log'), false);
  });

  it('refuses a metacharacter entry instead of writing a wildcard rule (issue #133 re-review)', () => {
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
      entries: ['.kubic/wt/', '*/'],
    });

    assert.equal(result.skipped, 'unavailable');
    assert.equal(result.changed, false);
    assert.equal(readFileSync(file, 'utf8'), before);
    writeFileSync(join(dir, 'src-new.txt'), 'x\n');
    assert.equal(isIgnored(dir, 'src-new.txt'), false);
  });
});

describe('this repo ships the split (issue #91)', () => {
  it('wires the rules into every mode that creates state', () => {
    // Criterion 1 is only met if the mechanism is actually reachable from
    // the CLI: `kubic run`, `kubic orchestrate` and `kubic tui` (issue #113:
    // a TUI session creates in-repo state the moment config relocates it)
    // must all ship the rules before they create state. Pin the dispatch,
    // not a helper. Issue #135: the dispatch moved to apps/kubic/src/dispatch.ts
    // (main.ts is the thin entry); the seam it calls is deps.ensureRuntimeExclude.
    const dispatch = readFileSync(
      join(ROOT, 'apps', 'kubic', 'src', 'dispatch.ts'),
      'utf8',
    );
    const call = dispatch.match(
      /if \(command === 'run' \|\| command === 'orchestrate' \|\| command === 'tui'\) \{\n\s*deps\.ensureRuntimeExclude\(/,
    );
    assert.ok(
      call !== null,
      'apps/kubic/src/dispatch.ts must call the runtime-exclude seam for run + orchestrate + tui',
    );
    // No mode that writes state may be added without it: the dispatch
    // names exactly the state-creating commands.
    for (const mode of ['run', 'orchestrate', 'tui']) {
      assert.match(dispatch, new RegExp(`command === '${mode}'`));
    }
    // The dispatch delegates to the injected seam, so CLI-reachability needs
    // the production wiring too (the pre-#135 pin asserted exactly this,
    // against main.ts): the entry point must wire the real rules into the
    // seam it hands the dispatch — a no-op seam must not pass this test.
    // Issue #133: the seam takes the config-derived entry list (the shipped
    // prefixes plus a configured `[orchestrator].root`), so the pin reads the
    // wiring with its argument.
    const main = readFileSync(
      join(ROOT, 'apps', 'kubic', 'src', 'main.ts'),
      'utf8',
    );
    assert.match(
      main,
      /ensureRuntimeExclude:\s*\(entries\)\s*=>\s*ensureRuntimeExcludeRules\(\{\s*cwd: process\.cwd\(\),\s*entries\s*\}\)/,
      'apps/kubic/src/main.ts must wire ensureRuntimeExcludeRules into the dispatch seam (with the config-derived entries, issue #133)',
    );
    assert.match(
      dispatch,
      /deps\.ensureRuntimeExclude\(\s*runtimeExcludeEntriesFor\(cliConfig\.runtime\?\.orchestrator\.root\)/,
      'apps/kubic/src/dispatch.ts must ship the configured worktree parent with the runtime prefixes (issue #133)',
    );
  });
  // Issue #90 criterion 5: `checkGitignoreSplit` is the rule checker, and it
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
      /checkWorkspaceIgnoreSplit\(bridge, cwd\)/,
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
    assert.equal(isIgnored(ROOT, '.kubic/config.toml'), false);
    assert.equal(isIgnored(ROOT, '.kubic/roles/reviewer.md'), false);
  });

  it('ignores its own runtime state, keeps roles trackable', () => {
    for (const entry of RUNTIME_EXCLUDE_ENTRIES) {
      assert.equal(
        isIgnored(ROOT, `${entry}probe`),
        true,
        `${entry} must be ignored by this repo's .gitignore`,
      );
    }
    assert.equal(isIgnored(ROOT, '.kubic/roles/reviewer.md'), false);
    assert.equal(isIgnored(ROOT, '.kubic/config.toml'), false);

    // No runtime path may be tracked (a force-added one would defeat the
    // split: `git status` would stay quiet while state sits in history).
    // `git ls-files .kubic` may only return the committed half.
    const tracked = git(ROOT, ['ls-files', '.kubic'])
      .split('\n')
      .filter((line) => line.length > 0);
    const leaked = tracked.filter(
      (path) =>
        !(path === '.kubic/config.toml' || path.startsWith('.kubic/roles/')),
    );
    assert.deepEqual(
      leaked,
      [],
      `runtime paths must not be tracked: ${leaked.join(', ')}`,
    );
    assert.ok(
      tracked.some((path) => path.startsWith('.kubic/roles/')),
      'the role documents must stay tracked (the committed half)',
    );
  });

  it('docs state exactly the shipped rules and how a repo gets them', () => {
    const doc = readFileSync(
      join(ROOT, 'docs', 'cli', 'configuration.md'),
      'utf8',
    );
    const section = doc.slice(doc.indexOf('## What lives where'));
    assert.ok(
      section.length > 0,
      'configuration.md must keep a What-lives-where section',
    );
    for (const entry of RUNTIME_EXCLUDE_ENTRIES) {
      assert.ok(
        section.includes(entry),
        `configuration.md must state the shipped rule ${entry}`,
      );
    }
    assert.ok(
      section.includes('git/info/exclude'),
      'configuration.md must say how a user repo gets the rules',
    );
    assert.ok(
      section.includes('.kubic/config.toml') &&
        section.includes('.kubic/roles/*.md'),
      'configuration.md must state the committed half',
    );
    assert.ok(
      !/^\s*\.kubic\/\s*$/m.test(section),
      'configuration.md must not claim .kubic/ itself is ignored',
    );
  });
});
