// `kubic orchestrate` run from inside a LINKED git worktree (issue #279;
// §60): the manager's audit records and the worker-ask store must land in the
// repo runtime root — the MAIN checkout — the same place a worker child's own
// records and `kubic audit` resolve to (`resolveRepoRuntimeRoot`). Resolved
// from the raw `git rev-parse --show-toplevel`, they split into the linked
// worktree's own `.kubic/`, where `kubic audit` never looks. Real git, real
// child processes, no provider.

import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { orchestrateDepsWithDefaults } from '../../../apps/kubic/src/orchestrate-run.js';
import {
  createGitSandbox,
  disposeAllGitSandboxes,
  type GitSandbox,
} from '../../exec/src/test-support/git-sandbox.js';
import { runOrchestrateCommand } from './orchestrate-cli.js';
import { orchestratorStateRoot } from './orchestrator/approvals/worker-asks.js';
import {
  auditLedgerDir,
  auditLedgerDirFor,
  readAuditLedger,
} from './policy/audit-ledger.js';

const DUMP_MARKER = 'DUMPDIR=';

// The worker child: writes `<KUBIC_WORKER_ID>.txt` (the run commits it) and
// dumps where its approvals mailbox lives, then reports a completed envelope.
const WORKER_FIXTURE = `
import { writeFileSync } from 'node:fs';
const argv = process.argv.slice(2);
const at = argv.indexOf('-p');
const prompt = at === -1 ? '' : (argv[at + 1] ?? '');
const dump = new RegExp('${DUMP_MARKER}(\\\\S+)').exec(prompt);
const id = process.env.KUBIC_WORKER_ID ?? 'worker';
if (dump !== null) writeFileSync(dump[1] + '/' + id + '.approvals', process.env.KUBIC_APPROVALS_DIR ?? '');
writeFileSync(id + '.txt', 'work\\n');
process.stdout.write('KUBIC_WORKER_READY ' + id + '\\n');
const a = process.argv;
process.stdout.write(JSON.stringify({ ok: true, exitCode: 0, sessionId: a[a.indexOf('--session') + 1], status: 'completed', result: { summary: 'fixture done' } }) + String.fromCharCode(10));
process.exit(0);
`;

const scratchDirs: string[] = [];

function scratch(prefix: string): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  scratchDirs.push(dir);
  return dir;
}

afterEach(() => {
  driver = undefined;
  disposeAllGitSandboxes();
  for (const dir of scratchDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

// The test's git driver (issue #420). Set by mainAndLinked.
let driver: GitSandbox | undefined;

function git(cwd: string, args: string[]): string {
  if (driver === undefined)
    throw new Error('git() needs mainAndLinked() first');
  return driver.git(args, { cwd });
}

// A main checkout plus a linked worktree of it on its own branch. Injected:
// the run under test manages worktrees and commits through production git.
function mainAndLinked(): { main: string; linked: string } {
  const sandbox = createGitSandbox({ injectProcessEnv: true });
  driver = sandbox;
  const main = sandbox.path;
  writeFileSync(join(main, 'base.txt'), 'base\n');
  sandbox.git(['add', 'base.txt']);
  sandbox.git(['commit', '-m', 'base']);
  const linked = join(scratch('kubic-orch-lk-link-'), 'feature');
  git(main, ['worktree', 'add', linked, '-b', 'feature']);
  return { main, linked: realpathSync(linked) };
}

describe('orchestrate from a linked worktree resolves the repo runtime root (issue #279)', () => {
  it('writes the merge-gate audit record and the worker-ask store under the MAIN checkout', async () => {
    const { main, linked } = mainAndLinked();
    const dump = scratch('kubic-orch-lk-dump-');
    const childDir = scratch('kubic-orch-lk-child-');
    const fixture = join(childDir, 'worker-child.mjs');
    writeFileSync(fixture, WORKER_FIXTURE);
    const lines: string[] = [];
    const deps = await orchestrateDepsWithDefaults({
      out: (line) => lines.push(line),
      err: (line) => lines.push(line),
      cwd: linked,
      sessionsRoot: scratch('kubic-orch-lk-sessions-'),
      workerEntry: { cmd: process.execPath, args: [fixture] },
      signals: { install: () => () => undefined, reraise: () => undefined },
    });
    const code = await runOrchestrateCommand(
      {
        prompt: `do it ${DUMP_MARKER}${dump}`,
        agents: ['worker-1'],
        session: 'lk1',
        yes: true,
      },
      deps,
    );
    expect(code, lines.join('\n')).toBe(0);

    // The ledger `kubic audit` reads (and a worker's own records land in).
    expect(auditLedgerDirFor(linked)).toBe(auditLedgerDir(main));
    const merges = readAuditLedger(auditLedgerDir(main)).filter((record) =>
      record.what.startsWith('merge:'),
    );
    expect(merges).toHaveLength(1);
    expect(merges[0]?.what).toBe('merge:kubic/lk1/worker-1');
    // Nothing split off into the linked worktree's own `.kubic/`.
    expect(existsSync(join(auditLedgerDir(linked), 'audit.jsonl'))).toBe(false);

    // The worker-ask store (mailbox + decisions) the child is told about: it
    // is keyed by the REPO runtime root — so a run started in the linked
    // worktree and one started in the main checkout share it — and it lives
    // under the user home, outside the repo and every worktree (issue #149).
    expect(readdirSync(dump)).toEqual(['worker-1.approvals']);
    const mailbox = readFileSync(join(dump, 'worker-1.approvals'), 'utf8');
    expect(mailbox).toBe(
      join(orchestratorStateRoot(join(main, '.kubic', 'orchestrator')), 'lk1'),
    );
    expect(mailbox.startsWith(main)).toBe(false);
    expect(mailbox.startsWith(linked)).toBe(false);
    expect(
      existsSync(join(linked, '.kubic', 'orchestrator', 'approvals')),
    ).toBe(false);
  });
});
