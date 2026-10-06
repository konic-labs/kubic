// Resolver-child fixtures for the host orchestrate-conflict prod test
// (issue #420). They live in exec test-support because only exec-owned
// scaffolding may mention node:fs/child_process outside *.test.ts files
// (the dep-lint I/O confinement rule scans text, including these fixture
// strings) — and because they run in spawned children, not in the test.
//
// These scripts run in REAL spawned resolver children (written to scratch
// and executed by the run under test), so they cannot call the test's
// sandbox helper — they are child programs, not test code, which is also
// why they live here instead of inline in the .test.ts file the
// git-sandbox gate scans. Each one scrubs its own git view (an empty HOME
// plus GIT_CONFIG_NOSYSTEM, every inherited GIT_* deleted) and pins the
// commit identity per-commit, so neither a hostile developer config nor
// ambient GIT_* state can shape the settlement — defense in depth under
// the test's own injected sandbox env, which children inherit.
//
// Test-only scaffolding: never imported by production code (keep row in
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
gitEnv.HOME = mkdtempSync(join(tmpdir(), 'kubic-resolver-home-'));
gitEnv.XDG_CONFIG_HOME = mkdtempSync(join(tmpdir(), 'kubic-resolver-xdg-'));
gitEnv.GIT_CONFIG_NOSYSTEM = '1';
const git = (args) => execFileSync('git', args, { encoding: 'utf8', env: gitEnv });
const settleCommit = () =>
  git([
    '-c',
    'user.name=kubic-resolver',
    '-c',
    'user.email=kubic-resolver@local',
    '-c',
    'commit.gpgsign=false',
    'commit',
    '-m',
    'resolver: settle conflict',
  ]);
`;

// The resolver child that SETTLES: it makes the worker branch agree with the
// merge target on the conflicted line, which is the one resolution that lets
// the manager's re-merge run clean. The target branch is `main` because that
// is this test repo's merge target. The prompt the run hands it is written
// out first, so the test can read the §45.2 text the resolver actually got.
export const RESOLVER_SETTLE = `
import { writeFileSync } from 'node:fs';
${SCRUB_PRELUDE}
const argv = process.argv.slice(2);
const prompt = argv[argv.indexOf('-p') + 1] ?? '';
writeFileSync('resolver-prompt.txt', prompt);
writeFileSync('resolver-task-file.txt', process.env.KUBIC_TASK_FILE ?? '(none)');
for (const file of ['shared.txt']) {
  const target = git(['show', 'main:' + file]);
  writeFileSync(file, target);
}
git(['add', '-A']);
settleCommit();
process.stdout.write('KUBIC_WORKER_READY ' + (process.env.KUBIC_WORKER_ID ?? '') + '\\n');
if (0 === 0) { const a = process.argv; process.stdout.write(JSON.stringify({ ok: true, exitCode: 0, sessionId: a[a.indexOf('--session') + 1], status: 'completed', result: { summary: 'fixture done' } }) + String.fromCharCode(10)); }
process.exit(0);
`;

// The resolver child that dumps the approval identity it was launched with
// (issue #156) and then settles the conflict like RESOLVER_SETTLE. The dump
// is what proves the mailbox wiring reaches a REAL spawned resolver — a fakes
// test cannot: the composition root builds this child's env.
export const RESOLVER_DUMPS_ENV = `
import { writeFileSync } from 'node:fs';
${SCRUB_PRELUDE}
const argv = process.argv.slice(2);
const roleAt = argv.indexOf('--role');
writeFileSync('resolver-approvals-env.json', JSON.stringify({
  approvalsDir: process.env.KUBIC_APPROVALS_DIR ?? null,
  verifyKey: process.env.KUBIC_APPROVALS_VERIFY_KEY ?? null,
  orchestratorSession: process.env.KUBIC_ORCHESTRATOR_SESSION ?? null,
  workerSession: process.env.KUBIC_WORKER_SESSION ?? null,
  workerId: process.env.KUBIC_WORKER_ID ?? null,
  role: roleAt === -1 ? null : (argv[roleAt + 1] ?? null),
  boundMs: process.env.KUBIC_APPROVALS_BOUND_MS ?? null,
}));
for (const file of ['shared.txt']) {
  const target = git(['show', 'main:' + file]);
  writeFileSync(file, target);
}
git(['add', '-A']);
settleCommit();
process.stdout.write('KUBIC_WORKER_READY ' + (process.env.KUBIC_WORKER_ID ?? '') + '\\n');
if (0 === 0) { const a = process.argv; process.stdout.write(JSON.stringify({ ok: true, exitCode: 0, sessionId: a[a.indexOf('--session') + 1], status: 'completed', result: { summary: 'fixture done' } }) + String.fromCharCode(10)); }
process.exit(0);
`;
