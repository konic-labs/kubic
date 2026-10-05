// Manager-lane worker fixture for the #431 prod acceptance
// (`apps/kubic/src/orchestrate-manager-lane-prod.test.ts`). It lives in
// exec test-support because only exec-owned scaffolding may mention
// node:fs/child_process outside *.test.ts files (the dep-lint I/O
// confinement rule scans text, including fixture strings) — and because
// it runs in a spawned child, not in the test, so it cannot call the
// test's sandbox helper (the git-sandbox gate scans .test.ts text, which
// is also why this string is not inline there).
//
// The script runs as a REAL worker child (written to scratch and executed
// by the run under test): it writes work.txt into its worktree (its cwd),
// commits it so the lane's `git diff HEAD...branch` has a change to drive,
// then reports the §68 result shape and exits 0. Each commit pins its own
// identity and the prelude scrubs the inherited git view (an empty HOME,
// no system config, no GIT_* inheritance), so neither a hostile developer
// config nor ambient GIT_* state can shape the run — defense in depth
// under the test's own injected sandbox env, which children inherit.
//
// Test-only scaffolding: never imported by production code (row kept in
// docs/dead-surface.md, like the git sandbox itself).
const SCRUB_PRELUDE = `
import { execFileSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
// Hermetic git (issue #420): scrub the inherited view — an empty HOME and
// XDG_CONFIG_HOME, no system config, no GIT_* inheritance.
const gitEnv = { ...process.env };
for (const key of Object.keys(gitEnv)) {
  if (key.startsWith('GIT_')) delete gitEnv[key];
}
gitEnv.HOME = mkdtempSync(join(tmpdir(), 'kubic-lane-home-'));
gitEnv.XDG_CONFIG_HOME = mkdtempSync(join(tmpdir(), 'kubic-lane-xdg-'));
gitEnv.GIT_CONFIG_NOSYSTEM = '1';
const git = (args) =>
  execFileSync('git', args, { cwd: process.cwd(), stdio: 'ignore', env: gitEnv });
const ident = [
  '-c',
  'user.name=kubic-lane',
  '-c',
  'user.email=kubic-lane@local',
  '-c',
  'commit.gpgsign=false',
];
const commitWork = () => {
  git([...ident, 'add', 'work.txt']);
  git([...ident, 'commit', '-m', 'worker-1 work']);
};
`;

export const LANE_WORKER_CHILD = `
import { writeFileSync } from 'node:fs';
${SCRUB_PRELUDE}
writeFileSync(join(process.cwd(), 'work.txt'), 'lane acceptance\\n');
commitWork();
process.stdout.write('KUBIC_WORKER_READY ' + (process.env.KUBIC_WORKER_ID ?? '') + '\\n');
const a = process.argv;
process.stdout.write(JSON.stringify({ ok: true, exitCode: 0, sessionId: a[a.indexOf('--session') + 1], status: 'completed', result: { summary: 'fixture done', filesChanged: ['work.txt'] } }) + String.fromCharCode(10));
process.exit(0);
`;
