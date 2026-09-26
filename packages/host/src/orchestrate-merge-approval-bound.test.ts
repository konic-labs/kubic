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
import { mkdtempSync, readFileSync } from 'node:fs';
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
  type OrchestrateCommandDeps,
  runOrchestrateCommand,
} from './orchestrate-cli.js';
import { TIMEOUT_REASON_MARKER } from './orchestrator/approvals/timeout-reason.js';
import type { MergedHunk } from './orchestrator/merge/attribution.js';
import type { ApprovalSnapshot } from './orchestrator/merge/conflicts.js';

function scratchDir(): string {
  return mkdtempSync(join(tmpdir(), 'kubic-130-'));
}

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
      cwd: scratchDir(),
      approvalPolicy: policy(25),
    });
    expect(deps.requestApproval).toBeDefined();
    // The racing timeout is the pin: today the ask never settles (this race
    // resolves 'unbounded'); under the bound it resolves deny in ~25ms.
    const settled = await Promise.race([
      Promise.resolve(
        deps.requestApproval?.({ agentId: 'alpha', branch: 'kubic/alpha' }),
      ),
      new Promise<'unbounded'>((resolve) => {
        setTimeout(() => resolve('unbounded'), 1_000);
      }),
    ]);
    expect(settled).toBe(false);
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
    expect(settled).toBe(false);
    const written = stderr.text();
    expect(written).toContain('timed out');
    expect(written).toContain('25ms');
    expect(written).toContain('alpha');
  });

  it('keeps the seat undefined without a TTY — the shipped deny-closed path', async () => {
    restores.push(stubStdin(false).restore);
    const deps = await orchestrateDepsWithDefaults({
      out: () => undefined,
      cwd: scratchDir(),
      approvalPolicy: policy(25),
    });
    expect(deps.requestApproval).toBeUndefined();
  });

  it('keeps the seat undefined when the run holds no approvalPolicy snapshot', async () => {
    restores.push(stubStdin(true).restore);
    const deps = await orchestrateDepsWithDefaults({
      out: () => undefined,
      cwd: scratchDir(),
    });
    expect(deps.requestApproval).toBeUndefined();
  });

  it('settles the whole run with the refusal named when a merge approval elapses', async () => {
    restores.push(stubStdin(true).restore);
    const stderr = captureStderr();
    restores.push(stderr.restore);
    const deps = await orchestrateDepsWithDefaults({
      out: () => undefined,
      cwd: scratchDir(),
      approvalPolicy: policy(25),
    });
    // The factory's own seat drives the real CLI merge flow (its worker legs
    // faked — a run that reaches the merge gate, then gets no answer).
    const world = mergeWorld(deps.requestApproval);
    const code = await runOrchestrateCommand(
      ['-p', 'do the work', '--agents', 'alpha', '--session', 'sess-130'],
      world.deps,
    );
    // The elapse denied the merge; the run settled on the shipped exit 4 with
    // the refusal naming the candidate — never a queue waiting on a question
    // nobody will answer.
    expect(code).toBe(4);
    expect(world.calls.merge).toEqual([]);
    expect(world.lines.join('\n')).toMatch(/code=approval_denied/);
    expect(world.lines.join('\n')).toContain(
      "approval denied for worker 'alpha'",
    );
    expect(stderr.text()).toContain(mergeApprovalTimeoutReason(25, 'alpha'));
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
      let resolved: boolean | undefined;
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
      expect(await pending).toBe(false); // at the bound: denied closed
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
      const cases: Array<[string, boolean]> = [
        ['y', true],
        ['yes', true],
        ['Y', true],
        ['YES', true],
        [' y ', true],
        ['Yes', true],
        ['n', false],
        ['no', false],
        ['', false],
        ['yep', false],
        [' maybe', false],
        ['YES!', false],
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
        expect(await pending, `answer ${JSON.stringify(answer)}`).toBe(
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
    expect(await pending).toBe(false);
    // The bound is released, not left to fire after the interface closed.
    expect(cleared).toEqual([7]);
    expect(notices).toEqual([]);
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
    expect(await pending).toBe(true);
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
      expect(await pending).toBe(false);
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
  calls: { run: string[]; merge: string[]; reap: string[] };
} {
  const lines: string[] = [];
  const calls = {
    run: [] as string[],
    merge: [] as string[],
    reap: [] as string[],
  };
  const deps: OrchestrateCommandDeps = {
    out: (line: string) => {
      lines.push(line);
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
  return { deps, lines, calls };
}
