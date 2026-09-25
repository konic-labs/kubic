// Per-worker approvals across the PROCESS boundary (issue #105).
// Criterion 1 is one run in which worker asks reach the user; the channel that
// makes that possible is a mailbox under
// <repo>/.kubic/orchestrator/approvals/asks/ that a CHILD process writes to and
// the manager answers. A test that fakes both ends proves nothing about the
// channel, so this file drives the REAL prod path — `runOrchestrateCommand`
// over `orchestrateDepsWithDefaults` against real git — with a REAL child
// process that speaks the mailbox contract:
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
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { orchestrateDepsWithDefaults } from '../../../apps/kubic/src/orchestrate-run.js';
import type { Provenance } from '../../exec/src/env.js';
import { NodeExecutionEnv } from '../../exec/src/env.js';
import { runOrchestrateCommand } from './orchestrate-cli.js';
import type { OrchestratorApprovalRequest } from './orchestrator/approvals/request.js';

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
  new URL('./orchestrator/approvals/worker-asks.js', import.meta.url),
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
const agentId = process.env.KUBIC_WORKER_ID ?? 'worker';
const { publishWorkerAsk, awaitWorkerAskAnswer } = await import(
  pathToFileURL(__MODULE_URL__).href
);
const published = publishWorkerAsk(dir, {
  trigger: 'network',
  toolName: 'bash',
  args: { command: 'curl https://example.com/release.tgz' },
  justification: 'worker needs the release tarball for its plan step',
  sessionId: process.env.KUBIC_ORCHESTRATOR_SESSION ?? 'unknown',
  agentId,
  role: 'worker',
  worktree: process.cwd(),
  provenance: { parentSessionId: process.env.KUBIC_ORCHESTRATOR_SESSION ?? 'unknown' },
});
const answer = await awaitWorkerAskAnswer(dir, published.request.key, {
  maxPendingMs: __BOUND_MS__,
  pollMs: 10,
});
writeFileSync(
  join(dir, agentId + '.child.json'),
  JSON.stringify({ key: published.request.key, answer }),
);
console.log(JSON.stringify({ key: published.request.key, answer }));
process.exit(answer.approved ? 0 : 4);
`;

function scratchRoot(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

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

describe('per-worker approvals: the mailbox crosses the process boundary (issue #105)', () => {
  it('AC1 (prod): a real child publishes its ask, the user answers it through the manager, and the child exits on that verdict', async () => {
    const h = await prodHarness();
    const deps = await orchestrateDepsWithDefaults({
      out: (line) => h.lines.push(line),
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
      ['-p', 'do the work', '--session', 'orch-105', '--agents', 'worker-1'],
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
      readFileSync(
        join(
          h.root,
          '.kubic',
          'orchestrator',
          'approvals',
          'worker-1.child.json',
        ),
        'utf8',
      ),
    ) as { key: string; answer: { approved: boolean } };
    expect(evidence.answer.approved).toBe(true);
    expect(evidence.key).toBe(h.asked[0]?.key);
  }, 60_000);

  it('AC2 (prod): with no user answer the child denies closed on its own bound with the named reason', async () => {
    const h = await prodHarness(300);
    const deps = await orchestrateDepsWithDefaults({
      out: () => undefined,
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
      ['-p', 'do the work', '--session', 'orch-105', '--agents', 'worker-1'],
      deps,
    );
    const elapsed = Date.now() - started;
    // The run ended on the approval terminus (exit 4), not a generic failure,
    // and it ended on the configured bound rather than hanging.
    expect(code).toBe(4);
    expect(elapsed).toBeLessThan(30_000);
    const evidence = JSON.parse(
      readFileSync(
        join(
          h.root,
          '.kubic',
          'orchestrator',
          'approvals',
          'worker-1.child.json',
        ),
        'utf8',
      ),
    ) as { answer: { approved: boolean; code: string; reason: string } };
    expect(evidence.answer.approved).toBe(false);
    expect(evidence.answer.reason).toMatch(/timed out|denied/i);
  }, 60_000);
});
