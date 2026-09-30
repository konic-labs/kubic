// The interactive merge-approval seat is BOUNDED by the run's approval
// policy snapshot (issue #130, §41.2 "nothing waits silently"; §45.2 merge
// path). Every other ask in the system denies on its bound — worker asks at
// DEFAULT_WORKER_APPROVAL_BOUND_MS, the manager's router at
// ORCHESTRATE_APPROVAL_BOUND_MS, the TUI overlay and the headless seat at
// maxPendingMs. Before this issue the interactive merge gate was the one ask
// with no timeout at all: a user who walked away left sessions, worktrees and
// the terminal held open with no denial and no exit.
//
// The seat's bound is the same `approvalPolicy.maxPendingMs` snapshot issue
// #106 threaded for the conflict resolver — never a second policy — and the
// elapse denial names the bound and the candidate, interpolating the shared
// TIMEOUT_REASON_MARKER (issue #129), so its wording cannot drift from the
// worker-ask convention.
//
// The elapse is a TIMEOUT, never a refusal: the seat settles a verdict (not a
// bare boolean), the merge loop branches on it, and the run's envelope
// reports `approval_timeout` in `status`, `error.kind` and `error.code` —
// exit 4, the same exit as a refusal, so the LABEL is what tells a consumer
// "operator said no" from "nobody answered in time" (issue #129's rule,
// applied to this seat). A plain `true`/`false` seam keeps its shipped
// meaning: `true` approves, `false` is an explicit deny.
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  type AskLine,
  boundedAskUser,
  mergeApprovalTimeoutReason,
  orchestrateDepsWithDefaults,
} from '../../../apps/kubic/src/orchestrate-run.js';
import {
  type MergeApprovalVerdict,
  type OrchestrateCommandDeps,
  runOrchestrateCommand,
} from './orchestrate-cli.js';
import { TIMEOUT_REASON_MARKER } from './orchestrator/approvals/timeout-reason.js';
import type { MergedHunk } from './orchestrator/merge/attribution.js';
import type { ApprovalSnapshot } from './orchestrator/merge/conflicts.js';

// Every scratch dir is removed after each test (worktrees live under the repo
// root, so removing it disposes them too) — nothing accumulates in tmpdir.
const scratchDirs: string[] = [];

function scratchDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'kubic-130-'));
  scratchDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of scratchDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function policy(maxPendingMs: number): ApprovalSnapshot {
  return { route: 'ask-user', autoApprove: [], maxPendingMs };
}

// A stdin that reports as a terminal but never answers: readline over it
// waits for a line that never comes — exactly the walked-away user this bound
// exists for. `process.stdin` is a configurable accessor, so stubbing it is
// hermetic; no test here needs a real terminal.
function stubStdin(isTTY: boolean): {
  stdin: PassThrough;
  restore: () => void;
} {
  const stdin = new PassThrough();
  Object.defineProperty(stdin, 'isTTY', { value: isTTY, configurable: true });
  const original = Object.getOwnPropertyDescriptor(process, 'stdin');
  Object.defineProperty(process, 'stdin', { value: stdin, configurable: true });
  return {
    stdin,
    restore: () => {
      if (original !== undefined) {
        Object.defineProperty(process, 'stdin', original);
      }
    },
  };
}

// What the seat wrote to stderr (the readline prompt channel): the dead
// prompt line's cleanup newline and the named elapse denial.
function captureStderr(): { text: () => string; restore: () => void } {
  const chunks: string[] = [];
  const original = process.stderr.write;
  process.stderr.write = ((chunk: unknown) => {
    chunks.push(String(chunk));
    return true;
  }) as typeof process.stderr.write;
  return {
    text: () => chunks.join(''),
    restore: () => {
      process.stderr.write = original;
    },
  };
}

// The envelope a `--json` run emitted last (the same accessor shape the
// orchestrate-cli suites use).
function lastEnvelope(lines: string[]): {
  status: string;
  error?: { kind: string; message: string; code: string };
} {
  return JSON.parse(lines[lines.length - 1] as string) as {
    status: string;
    error?: { kind: string; message: string; code: string };
  };
}

describe('the interactive merge seat is bounded by the run snapshot (issue #130)', () => {
  const restores: Array<() => void> = [];
  afterEach(() => {
    while (restores.length > 0) restores.pop()?.();
  });

  it('denies closed on the bound instead of waiting forever for a walked-away user', async () => {
    const tty = stubStdin(true);
    restores.push(tty.restore);
    restores.push(captureStderr().restore);
    const deps = await orchestrateDepsWithDefaults({
      out: () => undefined,
      err: () => undefined,
      cwd: scratchDir(),
      approvalPolicy: policy(25),
    });
    expect(deps.requestApproval).toBeDefined();
    // The racing timeout is the pin: today the ask never settles (this race
    // resolves 'unbounded'); under the bound it settles the TIMEOUT verdict in
    // ~25ms — carrying the bound that elapsed, so the run can name it.
    const settled = await Promise.race([
      Promise.resolve(
        deps.requestApproval?.({ agentId: 'alpha', branch: 'kubic/alpha' }),
      ),
      new Promise<'unbounded'>((resolve) => {
        setTimeout(() => resolve('unbounded'), 1_000);
      }),
    ]);
    expect(settled).toEqual({ verdict: 'timeout', maxPendingMs: 25 });
    // The readline interface was closed: its stdin listener is released, so
    // nothing keeps the process from settling after the bound elapsed.
    expect(tty.stdin.listenerCount('end')).toBe(0);
  });

  it('names the bound and the candidate in the elapse denial', async () => {
    restores.push(stubStdin(true).restore);
    const stderr = captureStderr();
    restores.push(stderr.restore);
    const deps = await orchestrateDepsWithDefaults({
      out: () => undefined,
      err: () => undefined,
      cwd: scratchDir(),
      approvalPolicy: policy(25),
    });
    const settled = await Promise.race([
      Promise.resolve(
        deps.requestApproval?.({ agentId: 'alpha', branch: 'kubic/alpha' }),
      ),
      new Promise<'unbounded'>((resolve) => {
        setTimeout(() => resolve('unbounded'), 1_000);
      }),
    ]);
    expect(settled).toEqual({ verdict: 'timeout', maxPendingMs: 25 });
    const written = stderr.text();
    expect(written).toContain(TIMEOUT_REASON_MARKER);
    expect(written).toContain('25ms');
    expect(written).toContain('alpha');
  });

  it('uses an embedder-supplied merge seat verbatim and never opens the stdio readline (issue #327)', async () => {
    // A terminal-owning embedder (the TUI) with a TTY stdin AND a snapshot:
    // exactly the conditions under which the readline would otherwise run.
    const tty = stubStdin(true);
    restores.push(tty.restore);
    const stderr = captureStderr();
    restores.push(stderr.restore);
    const seat = async () => ({ verdict: 'approve' }) as const;
    const deps = await orchestrateDepsWithDefaults({
      out: () => undefined,
      err: () => undefined,
      cwd: scratchDir(),
      approvalPolicy: policy(25),
      mergeApproval: seat,
    });
    expect(deps.requestApproval).toBe(seat);
    expect(
      await deps.requestApproval?.({ agentId: 'alpha', branch: 'kubic/alpha' }),
    ).toEqual({ verdict: 'approve' });
    // No prompt was written and no stdin listener was taken.
    expect(stderr.text()).toBe('');
    expect(tty.stdin.listenerCount('end')).toBe(0);
    expect(tty.stdin.listenerCount('data')).toBe(0);
  });

  it('carries the surface\u2019s no-flag hint onto the run deps only when it is false', async () => {
    restores.push(stubStdin(false).restore);
    const base = {
      out: () => undefined,
      err: () => undefined,
      cwd: scratchDir(),
    };
    expect((await orchestrateDepsWithDefaults(base)).yesHint).toBeUndefined();
    expect(
      (await orchestrateDepsWithDefaults({ ...base, yesHint: false })).yesHint,
    ).toBe(false);
    expect(
      (await orchestrateDepsWithDefaults({ ...base, yesHint: true })).yesHint,
    ).toBeUndefined();
  });

  it('the embedder seat applies without a TTY or a snapshot too', async () => {
    restores.push(stubStdin(false).restore);
    const seat = async () => ({ verdict: 'deny' }) as const;
    const deps = await orchestrateDepsWithDefaults({
      out: () => undefined,
      err: () => undefined,
      cwd: scratchDir(),
      mergeApproval: seat,
    });
    expect(deps.requestApproval).toBe(seat);
  });

  it('keeps the seat undefined without a TTY — the shipped deny-closed path', async () => {
    restores.push(stubStdin(false).restore);
    const deps = await orchestrateDepsWithDefaults({
      out: () => undefined,
      err: () => undefined,
      cwd: scratchDir(),
      approvalPolicy: policy(25),
    });
    expect(deps.requestApproval).toBeUndefined();
  });

  it('keeps the seat undefined when the run holds no approvalPolicy snapshot', async () => {
    restores.push(stubStdin(true).restore);
    const deps = await orchestrateDepsWithDefaults({
      out: () => undefined,
      err: () => undefined,
      cwd: scratchDir(),
    });
    expect(deps.requestApproval).toBeUndefined();
  });

  it('settles the whole run as a TIMEOUT when a merge approval elapses — status, kind, code and message', async () => {
    restores.push(stubStdin(true).restore);
    const stderr = captureStderr();
    restores.push(stderr.restore);
    const deps = await orchestrateDepsWithDefaults({
      out: () => undefined,
      err: () => undefined,
      cwd: scratchDir(),
      approvalPolicy: policy(25),
    });
    // The factory's own seat drives the real CLI merge flow (its worker legs
    // faked — a run that reaches the merge gate, then gets no answer).
    const world = mergeWorld(deps.requestApproval);
    const code = await runOrchestrateCommand(
      {
        prompt: 'do the work',
        agents: ['alpha'],
        session: 'sess-130',
        json: true,
      },
      world.deps,
    );
    // The elapse denied the merge; the run settled on the shipped exit 4 —
    // but the envelope names the TIMEOUT, never a refusal nobody made. All
    // three labels agree: a consumer reading status, kind or code learns the
    // same true thing (issue #129's rule, applied to this seat).
    expect(code).toBe(4);
    expect(world.calls.merge).toEqual([]);
    // stdout is exactly the envelope; the prose failure line is stderr's.
    expect(world.lines).toHaveLength(1);
    expect(world.errs).toEqual([
      expect.stringMatching(
        /^error: approval timed out .*code=approval_timeout$/,
      ),
    ]);
    const envelope = lastEnvelope(world.lines);
    expect(envelope.status).toBe('approval_timeout');
    expect(envelope.error?.kind).toBe('approval_timeout');
    expect(envelope.error?.code).toBe('approval_timeout');
    expect(envelope.error?.message).toBe(
      "approval timed out after 25ms for worker 'alpha': nobody answered the merge gate — rerun with --yes to auto-approve merges",
    );
    // The seat still names the elapse on its own channel, with the shared
    // marker and the candidate.
    expect(stderr.text()).toContain(mergeApprovalTimeoutReason(25, 'alpha'));
  });

  it('carries the timeout verdict through the deps seam — the bound travels with it', async () => {
    // An embedder's own seat may settle the timeout verdict directly; the
    // run must label it exactly as the real seat's elapse is labelled, and
    // name the bound the verdict carries.
    const world = mergeWorld(
      (): MergeApprovalVerdict => ({ verdict: 'timeout', maxPendingMs: 40 }),
    );
    const code = await runOrchestrateCommand(
      {
        prompt: 'do the work',
        agents: ['alpha'],
        session: 'sess-130',
        json: true,
      },
      world.deps,
    );
    expect(code).toBe(4);
    expect(world.calls.merge).toEqual([]);
    const envelope = lastEnvelope(world.lines);
    expect(envelope.status).toBe('approval_timeout');
    expect(envelope.error?.kind).toBe('approval_timeout');
    expect(envelope.error?.code).toBe('approval_timeout');
    expect(envelope.error?.message).toBe(
      "approval timed out after 40ms for worker 'alpha': nobody answered the merge gate — rerun with --yes to auto-approve merges",
    );
  });

  it('keeps the refusal label and the shipped message when the decider says no', async () => {
    // The control: a plain `false` from an existing seam still means an
    // explicit deny — approval_denied, the same message as before, exit 4.
    // The timeout label above must never leak onto a decided no.
    const world = mergeWorld(() => false);
    const code = await runOrchestrateCommand(
      {
        prompt: 'do the work',
        agents: ['alpha'],
        session: 'sess-130',
        json: true,
      },
      world.deps,
    );
    expect(code).toBe(4);
    expect(world.calls.merge).toEqual([]);
    const envelope = lastEnvelope(world.lines);
    expect(envelope.status).toBe('approval_denied');
    expect(envelope.error?.kind).toBe('approval_denied');
    expect(envelope.error?.code).toBe('approval_denied');
    expect(envelope.error?.message).toBe(
      "approval denied for worker 'alpha': the decider is the user — rerun with --yes to auto-approve merges",
    );
  });
});

// A readline double: records the question, hands back the pending answer
// callback, and can fire the close (EOF) event. No stream, no terminal, no
// real stdin — the whole contract is exercised on this seam.
interface AskDouble {
  line: AskLine;
  asked: string[];
  closeCount: () => number;
  answer: (value: string) => void;
  eof: () => void;
}

function askDouble(): AskDouble {
  const asked: string[] = [];
  const closeHandlers: Array<() => void> = [];
  let closes = 0;
  let pending: ((answer: string) => void) | undefined;
  return {
    line: {
      question: (question, answer) => {
        asked.push(question);
        pending = answer;
      },
      close: () => {
        closes += 1;
      },
      onClose: (handler) => {
        closeHandlers.push(handler);
      },
    },
    asked,
    closeCount: () => closes,
    answer: (value) => {
      pending?.(value);
    },
    eof: () => {
      for (const handler of closeHandlers) handler();
    },
  };
}

describe('boundedAskUser — the bounded ask contract (issue #130)', () => {
  it('waits the full bound, then denies closed — never settles early, never hangs', async () => {
    vi.useFakeTimers();
    try {
      const double = askDouble();
      const notices: string[] = [];
      let resolved: MergeApprovalVerdict | undefined;
      const pending = boundedAskUser(
        "approve merge of 'alpha' (kubic/alpha)? [y/N] ",
        {
          maxPendingMs: 25,
          candidate: 'alpha',
          open: () => double.line,
          notice: (text) => notices.push(text),
        },
      );
      void pending.then((value) => {
        resolved = value;
      });
      expect(double.asked).toEqual([
        "approve merge of 'alpha' (kubic/alpha)? [y/N] ",
      ]);
      await vi.advanceTimersByTimeAsync(24);
      expect(resolved).toBeUndefined(); // inside the bound: still waiting
      await vi.advanceTimersByTimeAsync(1);
      // At the bound: the TIMEOUT verdict settles — not a refusal, and the
      // bound that elapsed travels with it so the run can name it.
      expect(await pending).toEqual({ verdict: 'timeout', maxPendingMs: 25 });
      expect(double.closeCount()).toBe(1); // the interface is released
      expect(notices).toContain('\n'); // the dead prompt line is cleaned
      expect(notices.join('')).toContain(
        mergeApprovalTimeoutReason(25, 'alpha'),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it('approves only an explicit yes; every other answer denies', async () => {
    vi.useFakeTimers();
    try {
      const cases: Array<[string, 'approve' | 'deny']> = [
        ['y', 'approve'],
        ['yes', 'approve'],
        ['Y', 'approve'],
        ['YES', 'approve'],
        [' y ', 'approve'],
        ['Yes', 'approve'],
        ['n', 'deny'],
        ['no', 'deny'],
        ['', 'deny'],
        ['yep', 'deny'],
        [' maybe', 'deny'],
        ['YES!', 'deny'],
        ['yesno', 'deny'],
        ['yesss', 'deny'],
      ];
      for (const [answer, expected] of cases) {
        const double = askDouble();
        const notices: string[] = [];
        const pending = boundedAskUser('q? ', {
          maxPendingMs: 1_000,
          candidate: 'alpha',
          open: () => double.line,
          notice: (text) => notices.push(text),
        });
        double.answer(answer);
        const settled = await pending;
        expect(settled.verdict, `answer ${JSON.stringify(answer)}`).toBe(
          expected,
        );
        expect(double.closeCount()).toBe(1);
        // An answered ask never emits the elapse denial.
        expect(notices).toEqual([]);
      }
    } finally {
      vi.useRealTimers();
    }
  });

  it('denies an EOF (interface closed with no answer) — a closed stdin is not consent', async () => {
    const double = askDouble();
    const notices: string[] = [];
    const cleared: unknown[] = [];
    const pending = boundedAskUser('q? ', {
      maxPendingMs: 60_000,
      candidate: 'beta',
      open: () => double.line,
      notice: (text) => notices.push(text),
      setTimer: (_callback, ms) => {
        expect(ms).toBe(60_000);
        return 7 as unknown as ReturnType<typeof setTimeout>;
      },
      clearTimer: (timer) => {
        cleared.push(timer);
      },
    });
    double.eof();
    expect(await pending).toEqual({ verdict: 'deny' });
    // The bound is released, not left to fire after the interface closed.
    expect(cleared).toEqual([7]);
    // The dead prompt line is cleaned on this path too — a real pty showed
    // the next output glued to the open prompt otherwise.
    expect(notices).toEqual(['\n']);
  });

  it('clears the bound when an answer arrives — the elapse cannot fire later', async () => {
    const double = askDouble();
    const bounds: number[] = [];
    const cleared: unknown[] = [];
    const pending = boundedAskUser('q? ', {
      maxPendingMs: 42,
      candidate: 'gamma',
      open: () => double.line,
      notice: () => undefined,
      setTimer: (_callback, ms) => {
        bounds.push(ms);
        return bounds.length as unknown as ReturnType<typeof setTimeout>;
      },
      clearTimer: (timer) => {
        cleared.push(timer);
      },
    });
    expect(bounds).toEqual([42]); // the run's bound, exactly
    double.answer('yes');
    expect(await pending).toEqual({ verdict: 'approve' });
    expect(cleared).toEqual([1]);
  });

  it('settles exactly once — a late answer cannot flip a settled deny', async () => {
    vi.useFakeTimers();
    try {
      const double = askDouble();
      let resolutions = 0;
      const pending = boundedAskUser('q? ', {
        maxPendingMs: 10,
        candidate: 'delta',
        open: () => double.line,
        notice: () => undefined,
      });
      void pending.then(() => {
        resolutions += 1;
      });
      await vi.advanceTimersByTimeAsync(10);
      expect(await pending).toEqual({ verdict: 'timeout', maxPendingMs: 10 });
      double.answer('y'); // the user walks back and types yes, too late
      await vi.advanceTimersByTimeAsync(10);
      await Promise.resolve();
      expect(resolutions).toBe(1);
      expect(double.closeCount()).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('names the bound and the candidate, matching the worker-ask convention', () => {
    const reason = mergeApprovalTimeoutReason(30_000, 'worker-2');
    expect(reason).toContain(TIMEOUT_REASON_MARKER);
    expect(reason).toContain('after 30000ms');
    expect(reason).toContain("merge of 'worker-2'");
    // The exact shipped wording, so a drift is a red test, not a code review.
    expect(reason).toBe(
      `approval ${TIMEOUT_REASON_MARKER} after 30000ms — denied (merge of 'worker-2')`,
    );
  });

  it('interpolates the shared marker — the wording cannot drift from the worker-ask literal', () => {
    const source = readFileSync(
      join(
        import.meta.dirname,
        '..',
        '..',
        '..',
        'apps',
        'kubic',
        'src',
        'orchestrate-run.ts',
      ),
      'utf8',
    );
    expect(source).toContain('TIMEOUT_REASON_MARKER');
    // The marker is never copied as a literal (issue #129's single source).
    expect(source).not.toMatch(/['"`]timed out/);
  });
});

// The CLI's merge flow with faked worker legs (the same fixture shape the
// orchestrate-cli suites use), so the factory's real seat drives the real
// merge gate without spawning a child or a provider.
function mergeWorld(
  requestApproval: OrchestrateCommandDeps['requestApproval'],
): {
  deps: OrchestrateCommandDeps;
  lines: string[];
  errs: string[];
  calls: { run: string[]; merge: string[]; reap: string[] };
} {
  const lines: string[] = [];
  const errs: string[] = [];
  const calls = {
    run: [] as string[],
    merge: [] as string[],
    reap: [] as string[],
  };
  const deps: OrchestrateCommandDeps = {
    out: (line: string) => {
      lines.push(line);
    },
    err: (line: string) => {
      errs.push(line);
    },
    debug: () => undefined,
    now: () => 1_700_000_000_000,
    isGitRepo: () => true,
    ensureWorktree: (agentId: string) => ({
      path: `/repo/.kubic/wt/${agentId}`,
      branch: `kubic/${agentId}`,
    }),
    createWorkerSession: (input) => ({ sessionId: input.workerSessionId }),
    runWorker: (agentId: string): MergedHunk[] => {
      calls.run.push(agentId);
      return [
        { path: `${agentId}-0.txt`, hunk: `@@ -0,0 +1 @@ +${agentId}-0` },
      ];
    },
    mergeBranch: (agentId: string) => {
      calls.merge.push(agentId);
    },
    reapWorker: (agentId: string) => {
      calls.reap.push(agentId);
    },
    requestApproval,
    loadState: () => undefined,
    saveState: () => undefined,
  };
  return { deps, lines, errs, calls };
}
