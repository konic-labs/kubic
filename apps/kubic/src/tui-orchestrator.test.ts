// The interactive orchestrator entry (issue #327; §17, §81): mode resolution
// (flag over config default), the non-git refusal (exit 5), the Ctrl-G toggle
// routing the NEXT submit to the orchestrator drive, and the solo default
// staying pinned.
//
// This file lives in the composition root because that is what it exercises:
// the root's wiring of host contracts to the TUI presentation seam. The
// orchestrator drive is a stub here — no workers, no network, no real
// manager: the real delegation run is exercised by the orchestrate suites.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildOrchestratorWorktreeNotice } from '../../../packages/host/src/limits/orchestrator-notice.js';
import type {
  OrchestrateCliOptions,
  OrchestrateCommandDeps,
} from '../../../packages/host/src/orchestrate-cli.js';
import {
  createOrchestratorApprovalsRun,
  publishWorkerAsk,
  readWorkerAskAnswer,
} from '../../../packages/host/src/orchestrator/approvals/worker-asks.js';
import { createApprovalSurface } from '../../../packages/tui/src/approval-surface.js';
import type { Terminal } from '../../../packages/tui/src/tui-boundary.js';
import { BACKGROUND_CONTEXT } from '../../../packages/worker/src/pi-boundary.js';
import { fakeTerminal as sharedFakeTerminal } from '../../../test/fake-terminal.js';
import {
  createProdTuiOrchestrator,
  mergeSeatFromAnswer,
  workerAskSeatFromAnswer,
} from './tui-orchestrator.js';
import {
  TuiOrchestratorTurn as OrchestratorTurn,
  runTuiCommand,
  type TuiLaneLoop,
  type TuiOrchestratorRun,
  type TuiRunDeps,
  type TuiTurnOutcome,
} from './tui-run.js';

const roots: string[] = [];

function tmpRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), 'kubic-327-asks-'));
  roots.push(dir);
  return dir;
}

afterEach(() => {
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function fakeTerminal(width: number): Terminal & {
  writes: string[];
  started: number;
  stopped: number;
  feed: (data: string) => void;
} {
  return sharedFakeTerminal(width, 30);
}

async function waitFor(condition: () => boolean): Promise<void> {
  for (let i = 0; i < 500 && !condition(); i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  expect(condition()).toBe(true);
}

function deps(
  terminal: Terminal,
  overrides: Partial<TuiRunDeps> = {},
): TuiRunDeps {
  return {
    out: () => {},
    createTerminal: () => terminal,
    colorLevel: 'none',
    bootLane: async (sessionId?: string) => ({
      sessionId: sessionId ?? 's1',
      model: 'faux/test',
    }),
    ...overrides,
  };
}

// A minimal solo loop: takes prompts, settles completed. No events, no
// tools — the routing decision is what these tests observe.
function fakeLoop(admitted: string[]): TuiLaneLoop {
  return {
    runTurn: async (prompt: string) => {
      admitted.push(prompt);
      return { kind: 'completed', submissionId: `sub-${admitted.length}` };
    },
    subscribe: async () => async () => {},
    entries: async () => [],
    abort: async () => {},
    forgetKills: () => {},
    killsKey: 'conversation',
    kills: { track: () => {}, drain: () => [] },
    context: BACKGROUND_CONTEXT,
  } as unknown as TuiLaneLoop;
}

interface FakeDrive {
  objectives: string[];
  run: (
    objective: string,
    report?: (line: string) => void,
  ) => Promise<{ status: 'completed' }>;
}

function fakeDrive(): FakeDrive {
  const drive: FakeDrive = {
    objectives: [],
    run: async (objective, report) => {
      drive.objectives.push(objective);
      report?.('manager: planning');
      return { status: 'completed' };
    },
  };
  return drive;
}

describe('orchestrator entry: mode resolution (issue #327)', () => {
  it('--orchestrator boots the TUI with the mode in the header', async () => {
    const terminal = fakeTerminal(100);
    const pending = runTuiCommand({ orchestrator: true }, deps(terminal));
    await waitFor(() => terminal.started === 1);
    const frame = terminal.writes.join('');
    expect(frame).toContain('[ORCHESTRATOR] approvals on');
    expect(frame).toContain('faux/test · off');
    terminal.feed('\x03');
    terminal.feed('\x03');
    expect(await pending).toBe(0);
  });

  it('config [modes] orchestrator = true starts solo-flagless sessions in orchestrator mode', async () => {
    const terminal = fakeTerminal(100);
    const pending = runTuiCommand(
      {},
      deps(terminal, { modes: { orchestrator: true } }),
    );
    await waitFor(() => terminal.started === 1);
    const frame = terminal.writes.join('');
    expect(frame).toContain('[ORCHESTRATOR] approvals on');
    expect(frame).toContain('faux/test · off');
    terminal.feed('\x03');
    terminal.feed('\x03');
    expect(await pending).toBe(0);
  });

  it('the flag wins over a config that says solo, and solo stays the default', async () => {
    const flagged = fakeTerminal(100);
    const run = runTuiCommand(
      { orchestrator: true },
      deps(flagged, { modes: { orchestrator: false } }),
    );
    await waitFor(() => flagged.started === 1);
    expect(flagged.writes.join('')).toContain('[ORCHESTRATOR] approvals on');
    flagged.feed('\x03');
    flagged.feed('\x03');
    await run;

    const plain = fakeTerminal(100);
    const solo = runTuiCommand(
      {},
      deps(plain, { modes: { orchestrator: false } }),
    );
    await waitFor(() => plain.started === 1);
    const frame = plain.writes.join('');
    expect(frame).toContain('[SOLO] approvals on');
    expect(frame).not.toContain('[ORCHESTRATOR]');
    plain.feed('\x03');
    plain.feed('\x03');
    await solo;
  });
});

describe('orchestrator entry: the non-git refusal (issue #327)', () => {
  it('--orchestrator outside a git repo exits 5 with the named message', async () => {
    const err: string[] = [];
    const terminal = fakeTerminal(100);
    const code = await runTuiCommand(
      { orchestrator: true },
      deps(terminal, {
        err: (line: string) => err.push(line),
        isGitRepo: () => false,
      }),
    );
    expect(code).toBe(5);
    expect(terminal.started).toBe(0);
    expect(err.join('\n')).toContain('needs a git repository');
  });

  it('a config-driven orchestrator session is refused on the same path', async () => {
    const terminal = fakeTerminal(100);
    const code = await runTuiCommand(
      {},
      deps(terminal, { modes: { orchestrator: true }, isGitRepo: () => false }),
    );
    expect(code).toBe(5);
    expect(terminal.started).toBe(0);
  });

  it('solo sessions never probe git', async () => {
    const probe = vi.fn(() => true);
    const terminal = fakeTerminal(100);
    const pending = runTuiCommand({}, deps(terminal, { isGitRepo: probe }));
    await waitFor(() => terminal.started === 1);
    terminal.feed('\x03');
    terminal.feed('\x03');
    expect(await pending).toBe(0);
    expect(probe).not.toHaveBeenCalled();
  });
});

describe('orchestrator entry: the toggle routes the next submit (issue #327)', () => {
  it('Ctrl-G flips the indicator and the next prompt takes the orchestrator path', async () => {
    const terminal = fakeTerminal(120);
    const admitted: string[] = [];
    const drive = fakeDrive();
    const pending = runTuiCommand(
      {},
      deps(terminal, {
        bootLane: async (sessionId?: string) => ({
          sessionId: sessionId ?? 's1',
          model: 'faux/test',
          loop: fakeLoop(admitted),
          orchestrator: drive,
        }),
      }),
    );
    await waitFor(() => terminal.started === 1);
    terminal.feed('\x07');
    await waitFor(() => terminal.writes.join('').includes('[ORCHESTRATOR]'));
    terminal.feed('do it');
    terminal.feed('\r');
    await waitFor(() => drive.objectives.length === 1);
    expect(drive.objectives).toEqual(['do it']);
    expect(admitted).toEqual([]);
    // The drive's report callback lands in the transcript, not nowhere.
    await waitFor(() => terminal.writes.join('').includes('manager: planning'));
    terminal.feed('\x03');
    terminal.feed('\x03');
    expect(await pending).toBe(0);
  });

  it('the solo default is pinned: without the toggle the prompt stays on the solo lane', async () => {
    const terminal = fakeTerminal(120);
    const admitted: string[] = [];
    const drive = fakeDrive();
    const pending = runTuiCommand(
      {},
      deps(terminal, {
        bootLane: async (sessionId?: string) => ({
          sessionId: sessionId ?? 's1',
          model: 'faux/test',
          loop: fakeLoop(admitted),
          orchestrator: drive,
        }),
      }),
    );
    await waitFor(() => terminal.started === 1);
    terminal.feed('solo work');
    terminal.feed('\r');
    await waitFor(() => admitted.length === 1);
    expect(admitted).toEqual(['solo work']);
    expect(drive.objectives).toEqual([]);
    terminal.feed('\x03');
    terminal.feed('\x03');
    expect(await pending).toBe(0);
  });
});

describe('orchestrator worker asks reach the TUI surface and the worker (issue #327)', () => {
  const ask = {
    trigger: 'destructive-shell',
    toolName: 'bash',
    args: { command: 'rm -rf /tmp/kubic-327-scratch' },
    justification: 'worker must clear its own temp tree before the next step',
    sessionId: 'orch-327',
    agentId: 'worker-1',
    role: 'worker',
    worktree: '/repo/.kubic/wt/worker-1',
    provenance: { parentSessionId: 'orch-327' },
  } as const;

  it('a published worker ask reaches the surface and the allow decision reaches the mailbox', async () => {
    const dir = tmpRoot();
    const surface = createApprovalSurface({ armingMs: 0 });
    const approvals = createOrchestratorApprovalsRun({
      dir,
      sessionId: 'orch-327',
      maxPendingMs: 5_000,
      seat: workerAskSeatFromAnswer(surface.seat),
      pollMs: 5,
    });
    const published = publishWorkerAsk(approvals.mailboxDir(), ask);
    const pumped = approvals.pump({
      sessionId: 'orch-327',
      agentId: 'worker-1',
      worktree: ask.worktree,
    });
    await waitFor(() => surface.isShowing());
    const shown = surface.pending();
    // The card names the worker, the tool and the full command: the
    // operator decides on what will run, not on a bare tool name.
    expect(shown?.toolName).toBe('bash');
    expect(shown?.summary).toContain("worker 'worker-1'");
    expect(shown?.command).toContain('rm -rf /tmp/kubic-327-scratch');
    // The operator answers through the same key path the TUI routes.
    expect(surface.decide('a')).toBe(true);
    expect(await pumped).toBeUndefined();
    expect(
      readWorkerAskAnswer(approvals.mailboxDir(), published.request.key, {
        verifyKey: approvals.verifyKey(),
        nonce: published.nonce,
      }),
    ).toEqual({ state: 'verified', verdict: { approved: true, by: 'user' } });
  });

  it('a deny decision reaches the mailbox as a refusal the worker unblocks on', async () => {
    const dir = tmpRoot();
    const surface = createApprovalSurface({ armingMs: 0 });
    const approvals = createOrchestratorApprovalsRun({
      dir,
      sessionId: 'orch-327',
      maxPendingMs: 5_000,
      seat: workerAskSeatFromAnswer(surface.seat),
      pollMs: 5,
    });
    const published = publishWorkerAsk(approvals.mailboxDir(), ask);
    const pumped = approvals.pump({
      sessionId: 'orch-327',
      agentId: 'worker-1',
      worktree: ask.worktree,
    });
    await waitFor(() => surface.isShowing());
    surface.decide('d');
    const termination = await pumped;
    expect(termination?.exitCode).toBe(4);
    const answer = readWorkerAskAnswer(
      approvals.mailboxDir(),
      published.request.key,
      { verifyKey: approvals.verifyKey(), nonce: published.nonce },
    );
    expect(answer.state).toBe('verified');
    expect(answer.state === 'verified' && answer.verdict.approved).toBe(false);
  });
});

describe('orchestrator cancellation is honest (issue #327)', () => {
  it('a drive without an abort seam cannot be cancelled; a drive with one can', async () => {
    const noAbort = new OrchestratorTurn(
      { run: () => new Promise<TuiTurnOutcome>(() => {}) },
      () => {},
    );
    expect(noAbort.canCancel()).toBe(false);
    void noAbort.run('x');
    await waitFor(() => noAbort.isRunning());
    expect(await noAbort.cancel()).toBe(false);
    expect(noAbort.isCancelling()).toBe(false);

    let aborted = 0;
    const withAbort = new OrchestratorTurn(
      {
        run: () => new Promise<TuiTurnOutcome>(() => {}),
        abort: () => {
          aborted += 1;
        },
      },
      () => {},
    );
    expect(withAbort.canCancel()).toBe(true);
    void withAbort.run('x');
    await waitFor(() => withAbort.isRunning());
    expect(await withAbort.cancel()).toBe(true);
    expect(aborted).toBe(1);
    expect(withAbort.isCancelling()).toBe(true);
  });

  it('Ctrl-C on a non-cancellable orchestrator run quits instead of faking a cancel', async () => {
    const terminal = fakeTerminal(120);
    let started = false;
    const drive: TuiOrchestratorRun = {
      run: () => {
        started = true;
        return new Promise<TuiTurnOutcome>(() => {});
      },
    };
    const pending = runTuiCommand(
      { orchestrator: true },
      deps(terminal, {
        isGitRepo: () => true,
        drainTimeoutMs: 0,
        bootLane: async (sessionId?: string) => ({
          sessionId: sessionId ?? 's1',
          model: 'faux/test',
          orchestrator: drive,
        }),
      }),
    );
    await waitFor(() => terminal.started === 1);
    terminal.feed('long task');
    terminal.feed('\r');
    await waitFor(() => started);
    terminal.feed('\x03');
    terminal.feed('\x03');
    expect(await pending).toBe(0);
    expect(terminal.stopped).toBe(1);
  });
});

describe('createProdTuiOrchestrator (issue #327)', () => {
  it('runs the objective through the manager-lane command with the TUI seat attached', async () => {
    const seen: {
      options?: OrchestrateCliOptions;
      depsOptions?: { approvalsSeat?: unknown };
      lines: string[];
    } = { lines: [] };
    const drive = createProdTuiOrchestrator({
      sessionId: 'orch-9',
      out: () => {},
      now: () => 1_000_000,
      seat: async () => ({ approved: true, by: 'user' }),
      createDeps: async (options) => {
        seen.depsOptions = options;
        return { out: options.out } as OrchestrateCommandDeps;
      },
      runCommand: async (options, deps) => {
        seen.options = options;
        // The report sink the drive passed to the deps is the per-turn one.
        deps.out('session: orch-9');
        return 0;
      },
    });
    const outcome = await drive.run('refactor the parser', (line) =>
      seen.lines.push(line),
    );
    // Each turn is its own orchestrator session, named after the TUI session
    // plus a time stamp (issue #327): worktrees are retained per session.
    expect(seen.options).toEqual({
      prompt: 'refactor the parser',
      session: `orch-9-o${(1_000_000).toString(36)}`,
    });
    expect(typeof seen.depsOptions?.approvalsSeat).toBe('function');
    expect(seen.lines).toEqual(['session: orch-9']);
    expect(outcome).toEqual({ status: 'completed' });
  });

  it('maps a non-zero exit to a failed turn with the code named', async () => {
    const drive = createProdTuiOrchestrator({
      sessionId: 'orch-9',
      out: () => {},
      createDeps: async () => ({}) as OrchestrateCommandDeps,
      runCommand: async () => 3,
    });
    expect(await drive.run('spend too much')).toEqual({
      status: 'failed',
      detail: 'the orchestrator run failed (exit 3)',
    });
  });

  it('builds the run deps per turn, never reusing a previous run\u2019s state', async () => {
    let built = 0;
    const drive = createProdTuiOrchestrator({
      sessionId: 'orch-9',
      out: () => {},
      createDeps: async () => {
        built += 1;
        return {} as OrchestrateCommandDeps;
      },
      runCommand: async () => 0,
    });
    await drive.run('one');
    await drive.run('two');
    expect(built).toBe(2);
  });

  it("hands the lane's current model to each delegation (issue #202)", async () => {
    // A `/model` switch is what the next delegation's workers inherit: the
    // model is read per turn, and the frozen enterprise pin still wins.
    const seen: Array<{
      model?: { provider: string; id: string };
      modelPinFrozen?: boolean;
    }> = [];
    let current = { provider: 'acme', id: 'm1' };
    const drive = createProdTuiOrchestrator({
      sessionId: 'orch-9',
      out: () => {},
      currentModel: () => current,
      createDeps: async (options) => {
        seen.push({
          ...(options.model === undefined ? {} : { model: options.model }),
          ...(options.modelPinFrozen === undefined
            ? {}
            : { modelPinFrozen: options.modelPinFrozen }),
        });
        return {} as OrchestrateCommandDeps;
      },
      runCommand: async () => 0,
    });
    await drive.run('one');
    current = { provider: 'acme', id: 'm2' };
    await drive.run('two');
    expect(seen).toEqual([
      { model: { provider: 'acme', id: 'm1' } },
      { model: { provider: 'acme', id: 'm2' } },
    ]);

    const frozen: typeof seen = [];
    const frozenDrive = createProdTuiOrchestrator({
      sessionId: 'orch-9',
      out: () => {},
      currentModel: () => current,
      frozenModel: { provider: 'enterprise', id: 'pinned' },
      createDeps: async (options) => {
        frozen.push({
          ...(options.model === undefined ? {} : { model: options.model }),
          ...(options.modelPinFrozen === undefined
            ? {}
            : { modelPinFrozen: options.modelPinFrozen }),
        });
        return {} as OrchestrateCommandDeps;
      },
      runCommand: async () => 0,
    });
    await frozenDrive.run('three');
    expect(frozen).toEqual([
      {
        model: { provider: 'enterprise', id: 'pinned' },
        modelPinFrozen: true,
      },
    ]);
  });

  it('gives every prompt its OWN orchestrator session id: retained worktrees are session-scoped (issue #327)', async () => {
    const sessions: string[] = [];
    const drive = createProdTuiOrchestrator({
      sessionId: 'orch-9',
      out: () => {},
      // A frozen clock: the second prompt still gets a different id.
      now: () => 5_000,
      createDeps: async () => ({}) as OrchestrateCommandDeps,
      runCommand: async (options) => {
        sessions.push(options.session as string);
        return 0;
      },
    });
    await drive.run('first objective');
    await drive.run('second objective');
    await drive.run('third objective');
    expect(new Set(sessions).size).toBe(3);
    for (const session of sessions) {
      // Valid for worktree/branch names and the worker session ids.
      expect(session).toMatch(/^orch-9-o[a-z0-9]+$/);
    }
    // Strictly increasing stamps, never the bare TUI session id.
    const stamps = sessions.map((id) => Number.parseInt(id.slice(8), 36));
    expect(stamps).toEqual([5_000, 5_001, 5_002]);
    expect(sessions).not.toContain('orch-9');
  });

  it('a resumed TUI session (a fresh drive, same session id) never reuses an earlier run\u2019s orchestrator session', async () => {
    const earlier: string[] = [];
    const later: string[] = [];
    const build = (now: () => number, into: string[]): TuiOrchestratorRun =>
      createProdTuiOrchestrator({
        sessionId: 'orch-9',
        out: () => {},
        now,
        createDeps: async () => ({}) as OrchestrateCommandDeps,
        runCommand: async (options) => {
          into.push(options.session as string);
          return 0;
        },
      });
    await build(() => 1_700_000_000_000, earlier).run('one');
    await build(() => 1_700_000_060_000, later).run('one again');
    expect(later[0]).not.toBe(earlier[0]);
  });

  it('attaches the TUI merge seat to the run and never leaves the stdio readline as the merge decider (issue #327)', async () => {
    const asked: string[] = [];
    let attached: unknown;
    const mergeSeat = async (input: { agentId: string; branch: string }) => {
      asked.push(`${input.agentId}@${input.branch}`);
      return { verdict: 'approve' } as const;
    };
    const drive = createProdTuiOrchestrator({
      sessionId: 'orch-9',
      out: () => {},
      mergeSeat,
      createDeps: async (options) => {
        attached = options.mergeApproval;
        return {} as OrchestrateCommandDeps;
      },
      runCommand: async () => 0,
    });
    await drive.run('go');
    expect(attached).toBe(mergeSeat);
  });

  it('tells the run it has no --yes flag, so a merge refusal never names one (issue #327)', async () => {
    let seen: boolean | undefined;
    const drive = createProdTuiOrchestrator({
      sessionId: 'orch-9',
      out: () => {},
      createDeps: async (options) => {
        seen = options.yesHint;
        return {} as OrchestrateCommandDeps;
      },
      runCommand: async () => 0,
    });
    await drive.run('go');
    expect(seen).toBe(false);
  });

  it('with no merge seat wired the TUI run denies a merge closed instead of falling back to the readline (issue #327)', async () => {
    let attached:
      | ((input: { agentId: string; branch: string }) => unknown)
      | undefined;
    const drive = createProdTuiOrchestrator({
      sessionId: 'orch-9',
      out: () => {},
      createDeps: async (options) => {
        attached = options.mergeApproval;
        return {} as OrchestrateCommandDeps;
      },
      runCommand: async () => 0,
    });
    await drive.run('go');
    expect(typeof attached).toBe('function');
    expect(
      await attached?.({ agentId: 'worker-1', branch: 'kubic/s/w' }),
    ).toEqual({ verdict: 'deny' });
  });

  it('hands the TUI\u2019s per-root trust check to every turn\u2019s run deps (issue #228)', async () => {
    const seen: (((path: string) => boolean) | undefined)[] = [];
    const check = (path: string): boolean => path === '/repo';
    const build = (projectTrust?: (path: string) => boolean) =>
      createProdTuiOrchestrator({
        sessionId: 'orch-9',
        out: () => {},
        ...(projectTrust === undefined ? {} : { projectTrust }),
        createDeps: async (options) => {
          seen.push(options.projectTrust);
          return {} as OrchestrateCommandDeps;
        },
        runCommand: async () => 0,
      });
    await build(check).run('one');
    await build().run('two');
    // The very check the TUI holds (per-path, not a cwd boolean) reaches the
    // run; without one the option is left unset.
    expect(seen).toEqual([check, undefined]);
    expect(seen[0]?.('/repo')).toBe(true);
    expect(seen[0]?.('/repo/pkg')).toBe(false);
  });

  it('a deps failure is a failed turn, not an exception into the loop', async () => {
    const drive = createProdTuiOrchestrator({
      sessionId: 'orch-9',
      out: () => {},
      createDeps: async () => {
        throw new Error('not a git repository');
      },
      runCommand: async () => 0,
    });
    expect(await drive.run('anything')).toEqual({
      status: 'failed',
      detail: 'not a git repository',
    });
  });
});

describe('mergeSeatFromAnswer (issue #327)', () => {
  it('renders the merge ask on the TUI approval surface, naming the worker and its branch', async () => {
    const requests: unknown[] = [];
    const seat = mergeSeatFromAnswer(async (request) => {
      requests.push(request);
      return { approved: true, by: 'allow-once' };
    });
    const verdict = await seat({
      agentId: 'worker-1',
      branch: 'kubic/orch-9-o1/worker-1',
    });
    expect(verdict).toEqual({ verdict: 'approve' });
    expect(requests).toEqual([
      {
        key: 'merge:kubic/orch-9-o1/worker-1',
        capability: 'merge',
        toolName: 'merge',
        summary:
          "merge worker 'worker-1' (kubic/orch-9-o1/worker-1) into your working branch",
      },
    ]);
  });

  it('a refusal denies the merge', async () => {
    const seat = mergeSeatFromAnswer(async () => ({
      approved: false,
      reason: 'not now',
    }));
    expect(await seat({ agentId: 'a', branch: 'b' })).toEqual({
      verdict: 'deny',
    });
  });

  it('a seat that answers nothing is not consent', async () => {
    const seat = mergeSeatFromAnswer(async () => undefined);
    expect(await seat({ agentId: 'a', branch: 'b' })).toEqual({
      verdict: 'deny',
    });
  });
});

// Issue #453: `/safety` prints the CURRENT mode's honest limits, verbatim
// from the limits module — here the orchestrator's, never the solo text.
describe('/safety in orchestrator mode (issue #453)', () => {
  it("prints the orchestrator's limits, not the solo notice", async () => {
    const terminal = fakeTerminal(200);
    const admitted: string[] = [];
    const drive = fakeDrive();
    const pending = runTuiCommand(
      { orchestrator: true },
      deps(terminal, {
        bootLane: async (sessionId?: string) => ({
          sessionId: sessionId ?? 's1',
          model: 'faux/test',
          loop: fakeLoop(admitted),
          orchestrator: drive,
        }),
      }),
    );
    await waitFor(() => terminal.started === 1);
    const mark = terminal.writes.length;
    for (const ch of '/safety') terminal.feed(ch);
    terminal.feed('\r');
    await waitFor(() =>
      terminal.writes
        .slice(mark)
        .join('')
        .includes('safety: orchestrator mode'),
    );
    const after = terminal.writes.slice(mark).join('');
    for (const line of buildOrchestratorWorktreeNotice()) {
      expect(after).toContain(line.slice(0, 40));
    }
    expect(after).not.toContain('solo mode has no isolation');
    // A local read: nothing reached the lane or the manager.
    expect(admitted).toEqual([]);
    expect(drive.objectives).toEqual([]);
    terminal.feed('\x03');
    terminal.feed('\x03');
    expect(await pending).toBe(0);
  });
});
