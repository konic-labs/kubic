// Per-worker approvals across the PROCESS boundary (issue #105).
// Criterion 1 is one run in which worker asks reach the user; the channel that
// makes that possible is a mailbox directory that a CHILD process writes to and
// the manager answers. It lives under the USER's home, keyed by the repo
// runtime root — outside the repo and every worktree (issue #149) — and the
// manager's answers carry a MAC the child verifies. A test that fakes both
// ends proves nothing about the channel, so this file drives the REAL prod
// path — `runOrchestrateCommand` over `orchestrateDepsWithDefaults` against
// real git — with a REAL child process that speaks the mailbox contract:
//
//   child    ── publishWorkerAsk ─────►  asks/<key>.json
//   manager  ── router + user seat ───►  asks/<key>.answer.json
//   child    ── awaitWorkerAskAnswer ─►  the user's verdict, or a named denial
//
// No provider, no network, no paid tokens: the fixture publishes, waits and
// reports what it got. What this pins is exactly what a fake could not — the
// env allowlist carrying KUBIC_APPROVALS_DIR to the child, the mailbox
// atomicity across processes, the manager's interval pump answering a live
// ask, and the child's own bounded wait denying closed when nobody answers.
import {
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import type { Provenance } from '../../../packages/exec/src/env.js';
import { NodeExecutionEnv } from '../../../packages/exec/src/env.js';
import { runOrchestrateCommand } from '../../../packages/host/src/orchestrate-cli.js';
import type { OrchestratorApprovalRequest } from '../../../packages/host/src/orchestrator/approvals/request.js';
import {
  approvalsSessionDir,
  workerSeatForRun,
} from '../../../packages/host/src/orchestrator/approvals/worker-asks.js';
import {
  auditLedgerDir,
  readAuditLedger,
} from '../../../packages/host/src/policy/audit-ledger.js';
import { orchestrateDepsWithDefaults } from './orchestrate-run.js';

const PROVENANCE: Provenance = {
  sessionId: 'issue-105',
  agentId: 'manager',
  toolCallId: 'issue-105-prod',
  turnId: 0,
  operation: 'issue_105_prod',
};

// The approvals module the fixture imports. It is BAKED INTO the fixture
// source at write time: the spawn site owns the child's argv (`run -p <prompt>
// …`), so a fixture cannot read a path from argv, and the module location is
// not something the §3.8 env allowlist should carry.
const MODULE_URL = fileURLToPath(
  new URL(
    '../../../packages/host/src/orchestrator/approvals/worker-asks.js',
    import.meta.url,
  ),
);

// A child process that imports this repo's TypeScript by its `.js` specifier
// needs a resolve hook (NodeNext spells `.js` over `.ts` sources; plain node
// does not). The hook only rewrites a relative `.js` to the `.ts` beside it
// when that file exists — the same resolution vitest/tsc use — and it is
// inert for everything else. `--experimental-strip-types` then runs the
// source directly, so the child under test is the REAL module.
const LOADER_HOOK = `
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
export async function resolve(specifier, context, next) {
  if (specifier.endsWith('.js')) {
    try {
      // Relative, absolute-path and file:// specifiers all resolve; the
      // rewrite fires only when the .ts sibling really exists.
      const base =
        specifier.startsWith('file://')
          ? specifier
          : specifier.startsWith('/')
            ? 'file://' + specifier
            : context.parentURL === undefined
              ? undefined
              : new URL(specifier, context.parentURL).href;
      if (base !== undefined) {
        const candidate = new URL(base.slice(0, -3) + '.ts');
        if (existsSync(fileURLToPath(candidate))) {
          return next(candidate.href, context);
        }
      }
    } catch {
      // Fall through to normal resolution.
    }
  }
  return next(specifier, context);
}
`;

const LOADER_REGISTER = `
import { register } from 'node:module';
register('./loader-hook.mjs', import.meta.url);
`;

function fixtureSource(boundMs: number): string {
  return FIXTURE.replace('__MODULE_URL__', JSON.stringify(MODULE_URL)).replace(
    '__BOUND_MS__',
    String(boundMs),
  );
}

// The child contract, as a real process. It announces readiness the way every
// worker child does (the launch waits for exactly that line), then reads the
// mailbox from its OWN environment (the orchestration put it there through the
// §3.8 allowlist), publishes one ask, waits the bounded time for the
// manager's answer, writes the outcome beside the ask as evidence, and exits
// on its own §78 terminus (0 approved, 4 denied) — the same mapping a worker
// child makes.
const FIXTURE = `
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';

process.stdout.write('KUBIC_WORKER_READY ' + (process.env.KUBIC_WORKER_ID ?? '') + String.fromCharCode(10));
const dir = process.env.KUBIC_APPROVALS_DIR;
if (dir === undefined || dir === '') {
  console.log(JSON.stringify({ ok: false, why: 'no KUBIC_APPROVALS_DIR' }));
  process.exit(9);
}
const verifyKey = process.env.KUBIC_APPROVALS_VERIFY_KEY;
if (verifyKey === undefined || verifyKey === '') {
  console.log(JSON.stringify({ ok: false, why: 'no KUBIC_APPROVALS_VERIFY_KEY' }));
  process.exit(9);
}
const agentId = process.env.KUBIC_WORKER_ID ?? 'worker';
const { publishWorkerAsk, awaitWorkerAskAnswer } = await import(
  pathToFileURL(__MODULE_URL__).href
);
// Issue #159 (§23): the two ids are distinct — the worker's OWN session in
// KUBIC_WORKER_SESSION, the run that spawned it in KUBIC_ORCHESTRATOR_SESSION.
const workerSession = process.env.KUBIC_WORKER_SESSION ?? 'unknown';
const orchestratorSession = process.env.KUBIC_ORCHESTRATOR_SESSION ?? 'unknown';
const published = publishWorkerAsk(dir, {
  trigger: 'network',
  toolName: 'bash',
  args: { command: 'curl https://example.com/release.tgz' },
  justification: 'worker needs the release tarball for its plan step',
  sessionId: workerSession,
  agentId,
  role: 'worker',
  worktree: process.cwd(),
  provenance: { parentSessionId: orchestratorSession },
});
const answer = await awaitWorkerAskAnswer(dir, published.request.key, {
  maxPendingMs: __BOUND_MS__,
  pollMs: 10,
  verifyKey,
  nonce: published.nonce,
});
writeFileSync(
  join(dir, agentId + '.child.json'),
  JSON.stringify({
    key: published.request.key,
    answer,
    workerSession,
    orchestratorSession,
  }),
);
console.log(JSON.stringify({ key: published.request.key, answer }));
if ((answer.approved ? 0 : 4) === 0) { const a = process.argv; process.stdout.write(JSON.stringify({ ok: true, exitCode: 0, sessionId: a[a.indexOf('--session') + 1], status: 'completed', result: { summary: 'fixture done' } }) + String.fromCharCode(10)); }
process.exit(answer.approved ? 0 : 4);
`;

// Every scratch dir is removed after each test (worktrees live under the repo
// root, so removing it disposes them too) — nothing accumulates in tmpdir.
const scratchDirs: string[] = [];

function scratchRoot(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  scratchDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of scratchDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

async function gitIn(
  cwd: string,
  args: string[],
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const env = new NodeExecutionEnv(cwd);
  return env.shell.spawn('git', args, { provenance: PROVENANCE }).wait();
}

async function initRepo(): Promise<string> {
  const root = scratchRoot('kubic-105-prod-');
  await gitIn(root, ['init', '-b', 'main']);
  await gitIn(root, ['config', 'user.email', 'issue105@kubic.dev']);
  await gitIn(root, ['config', 'user.name', 'kubic issue 105']);
  await gitIn(root, ['config', 'commit.gpgsign', 'false']);
  writeFileSync(join(root, 'base.txt'), 'base\n');
  await gitIn(root, ['add', 'base.txt']);
  await gitIn(root, ['commit', '-m', 'base']);
  return root;
}

interface ProdHarness {
  root: string;
  sessionsRoot: string;
  fixture: string;
  asked: OrchestratorApprovalRequest[];
  lines: string[];
  debugLines: string[];
}

// The run's own mailbox for this session: outside the repo, under the user
// home (issue #149). The child writes its evidence file here. Keyed by the
// repo runtime root the run itself resolves it from (`git rev-parse
// --show-toplevel` reports the physical path, so a symlinked tmpdir must be
// resolved here too) and named for this session.
function mailboxDir(root: string): string {
  return approvalsSessionDir(
    join(realpathSync(root), '.kubic', 'orchestrator'),
    'orch-105',
  );
}

async function prodHarness(boundMs = 8_000): Promise<ProdHarness> {
  const root = await initRepo();
  const sessionsRoot = scratchRoot('kubic-105-sessions-');
  const scratch = scratchRoot('kubic-105-child-');
  const fixture = join(scratch, 'worker-child.mjs');
  writeFileSync(fixture, fixtureSource(boundMs));
  writeFileSync(join(scratch, 'loader-hook.mjs'), LOADER_HOOK);
  writeFileSync(join(scratch, 'loader-register.mjs'), LOADER_REGISTER);
  const asked: OrchestratorApprovalRequest[] = [];
  const lines: string[] = [];
  const debugLines: string[] = [];
  return { root, sessionsRoot, fixture, asked, lines, debugLines };
}

describe('the run attaches a seat when a user is present (issue #105)', () => {
  it('a TTY run gets the interactive seat; a headless run gets none', () => {
    // The prod decision, as a pure function of `isTTY` (the same test the
    // shipped merge prompt uses). This is the wiring that makes a worker's
    // challenged call reach the user on a real `kubic orchestrate`, and the
    // wiring that keeps a headless run denying closed instead of hanging.
    expect(workerSeatForRun(false)).toBeUndefined();
    const seat = workerSeatForRun(true, { prompt: async () => 'y' });
    expect(seat).toBeTypeOf('function');
  });

  it("the seat the run attaches presents the ask and returns the user's verdict", async () => {
    const asked: string[] = [];
    const seat = workerSeatForRun(true, {
      prompt: async (question: string) => {
        asked.push(question);
        return 'y';
      },
    });
    const verdict = await seat?.(baseRequest());
    expect(verdict?.approved).toBe(true);
    expect(asked).toHaveLength(1);
    expect(asked[0]).toContain('worker-1');
    expect(asked[0]).toContain('network');
  });

  it('a run with an injected seat uses it verbatim — prod only supplies the default', async () => {
    // The composition root's precedence rule: an injected seat WINS over the
    // TTY default, which is how an embedder (or a test) states its own
    // surface. Asserted on the real factory so the rule cannot drift.
    const h = await prodHarness();
    const injected: OrchestratorApprovalRequest[] = [];
    const deps = await orchestrateDepsWithDefaults({
      out: (line) => h.lines.push(line),
      err: (line) => h.lines.push(line),
      debug: () => undefined,
      cwd: h.root,
      sessionsRoot: h.sessionsRoot,
      approvalsSeat: async (request) => {
        injected.push(request);
        return { approved: false, reason: 'the injected seat declined' };
      },
      workerEntry: {
        cmd: process.execPath,
        args: [
          '--experimental-strip-types',
          '--import',
          join(dirname(h.fixture), 'loader-register.mjs'),
          h.fixture,
        ],
      },
    });
    const code = await runOrchestrateCommand(
      { prompt: 'do the work', session: 'orch-105', agents: ['worker-1'] },
      deps,
    );
    // The injected seat was consulted (not bypassed in favour of the TTY
    // default), its denial reached the child, and the child denied closed.
    expect(injected).toHaveLength(1);
    expect(injected[0]?.agentId).toBe('worker-1');
    expect(code).toBe(4);
    // Exit 4 alone cannot tell the seat's denial from the headless merge
    // denial (AC1 below exits 4 on an APPROVED ask), so read the child's own
    // evidence: it received the injected seat's verdict under the same key.
    const evidence = JSON.parse(
      readFileSync(join(mailboxDir(h.root), 'worker-1.child.json'), 'utf8'),
    ) as { key: string; answer: { approved: boolean; reason: string } };
    expect(evidence.key).toBe(injected[0]?.key);
    expect(evidence.answer.approved).toBe(false);
    expect(evidence.answer.reason).toContain('the injected seat declined');
  }, 60_000);
});

// A minimal, complete request envelope: what the interactive seat reads to
// compose the question the user sees. Kept explicit so the display contract is
// pinned rather than incidental.
function baseRequest(): OrchestratorApprovalRequest {
  return {
    key: 'a'.repeat(16),
    agentId: 'worker-1',
    sessionId: 'orch-105',
    trigger: 'network',
    toolName: 'bash',
    // The envelope the seat reads: a SUMMARY of the challenged call (never raw
    // args — those stay inside the envelope's canonical form) and the
    // justification the ask carries.
    summary: 'curl https://example.com/1.tgz',
    justification: 'worker-1 needs the network for its step',
    worktree: '/repo/.kubic/wt/worker-1',
    role: 'worker',
    provenance: { parentSessionId: 'orch-105' },
  };
}

describe('per-worker approvals: the mailbox crosses the process boundary (issue #105)', () => {
  it('AC1 (prod): a real child publishes its ask, the user answers it through the manager, and the child exits on that verdict', async () => {
    const h = await prodHarness();
    const deps = await orchestrateDepsWithDefaults({
      out: (line) => h.lines.push(line),
      err: (line) => h.lines.push(line),
      debug: (line) => h.debugLines.push(line),
      cwd: h.root,
      sessionsRoot: h.sessionsRoot,
      approvalsSeat: async (request) => {
        h.asked.push(request);
        return { approved: true, by: 'user' };
      },
      workerEntry: {
        cmd: process.execPath,
        args: [
          '--experimental-strip-types',
          '--import',
          join(dirname(h.fixture), 'loader-register.mjs'),
          h.fixture,
        ],
      },
    });
    const code = await runOrchestrateCommand(
      // NO `--yes`: that flag is the user's standing answer and would answer
      // the worker's ask without ever consulting the seat. This test is about
      // the seat, so the run keeps the interactive posture. (The merge that
      // follows still denies closed headless, which is the already-shipped
      // merge contract and is asserted below.)
      { prompt: 'do the work', session: 'orch-105', agents: ['worker-1'] },
      deps,
    );

    // The manager routed the child's ask to the USER (not to the manager, not
    // silently) and the run completed.
    expect(h.asked.length).toBe(1);
    expect(h.asked[0]?.trigger).toBe('network');
    expect(h.asked[0]?.agentId).toBe('worker-1');
    // The worker's ask was answered by the user (above); what the run exits on
    // is the MERGE approval, which has no decider headless — the shipped exit-4
    // contract, untouched by this issue.
    expect(code).toBe(4);

    // The child's own evidence: it saw exactly the user's verdict under the
    // key the router recomputed, and exited 0 on it.
    const evidence = JSON.parse(
      readFileSync(join(mailboxDir(h.root), 'worker-1.child.json'), 'utf8'),
    ) as {
      key: string;
      answer: { approved: boolean };
      workerSession: string;
      orchestratorSession: string;
    };
    expect(evidence.answer.approved).toBe(true);
    expect(evidence.key).toBe(h.asked[0]?.key);
    // Issue #159: the child was told its OWN session and the run it belongs
    // to — two distinct ids, the worker's being `<orch>-<agent>`.
    expect(evidence.workerSession).toBe('orch-105-worker-1');
    expect(evidence.orchestratorSession).toBe('orch-105');
    // And the manager's §60 row carries that same ancestry, so `kubic audit
    // --session orch-105` can attribute the decision to the run and the role
    // that asked.
    const row = readAuditLedger(auditLedgerDir(h.root)).find(
      (record) => record.what === 'tool:bash',
    );
    expect(row).toMatchObject({
      agent: {
        session: 'orch-105-worker-1',
        role: 'worker',
        parent: 'orch-105',
      },
      mode: 'orchestrator',
    });
  }, 60_000);

  it('AC2 (prod): with no user answer the child denies closed on its own bound with the named reason', async () => {
    const h = await prodHarness(100);
    const deps = await orchestrateDepsWithDefaults({
      out: () => undefined,
      err: () => undefined,
      debug: () => undefined,
      cwd: h.root,
      sessionsRoot: h.sessionsRoot,
      // NO seat: nothing can answer, so the manager's own bound denies closed.
      workerEntry: {
        cmd: process.execPath,
        args: [
          '--experimental-strip-types',
          '--import',
          join(dirname(h.fixture), 'loader-register.mjs'),
          h.fixture,
        ],
      },
    });
    const started = Date.now();
    const code = await runOrchestrateCommand(
      { prompt: 'do the work', session: 'orch-105', agents: ['worker-1'] },
      deps,
    );
    const elapsed = Date.now() - started;
    // The run ended on the approval terminus (exit 4), not a generic failure,
    // and it ended on the configured bound rather than hanging.
    expect(code).toBe(4);
    expect(elapsed).toBeLessThan(30_000);
    const evidence = JSON.parse(
      readFileSync(join(mailboxDir(h.root), 'worker-1.child.json'), 'utf8'),
    ) as { answer: { approved: boolean; code: string; reason: string } };
    expect(evidence.answer.approved).toBe(false);
    // The CHILD's own bound fired (the manager has no seat to answer with):
    // the named code, and a reason that carries the configured bound.
    expect(evidence.answer.code).toBe('approval_timeout');
    expect(evidence.answer.reason).toMatch(/timed out after 100ms/);
  }, 60_000);
});
