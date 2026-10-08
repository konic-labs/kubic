// Headless `kubic run -p`.
// Faux-only: injected runner, zero network. Covers the exit-code
// contract (0/1/2/3/4/5/6), the --json envelope, identical persistence,
// no alt-screen in -p path, and attach-reopens-transcript.
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  attachSession,
  createSession,
  openSessionStore,
} from '../../agent/src/lane/session-store.js';
import {
  BACKGROUND_CONTEXT,
  createModels,
  createRegistry,
  Harness,
  UserEntry,
} from '../../agent/src/pi-boundary.js';
import { createLineLogger } from '../../core/src/cli/logger.js';
import { createNodeFileBridge } from '../../exec/src/file-bridge.js';
import {
  failureForTerminus,
  type HeadlessRunResult,
  mapCaughtErrorToTerminus,
  mapLaneOutcomeToFailure,
  mapTerminusToExitCode,
  runRunCommand,
} from './run-cli.js';

const made: string[] = [];

function tmpRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), 'run-cli-'));
  made.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of made.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

function out(): { lines: string[]; write: (line: string) => void } {
  const lines: string[] = [];
  return { lines, write: (line: string) => lines.push(line) };
}

function completedResult(
  overrides: Partial<HeadlessRunResult> = {},
): HeadlessRunResult {
  return {
    terminus: 'completed',
    summary: 'did the thing',
    sessionId: 'sess-1',
    journalRef: 'journal:42',
    usageRef: 'usage:42',
    trajectoryRef: 'trajectory:42',
    ...overrides,
  };
}

function stubRun(
  result: HeadlessRunResult,
  seen: { prompt?: string; sessionId?: string } = {},
): (
  prompt: string,
  options: { sessionId?: string },
) => Promise<HeadlessRunResult> {
  return async (prompt: string, options: { sessionId?: string }) => {
    seen.prompt = prompt;
    seen.sessionId = options.sessionId;
    return result;
  };
}

describe('run -p exit-code contract', () => {
  it('maps every termini class to its exit code (0-6)', () => {
    expect(mapTerminusToExitCode('completed')).toBe(0);
    expect(mapTerminusToExitCode('failed')).toBe(1);
    expect(mapTerminusToExitCode('usage')).toBe(2);
    expect(mapTerminusToExitCode('turn_limit')).toBe(3);
    expect(mapTerminusToExitCode('approval_denied')).toBe(4);
    expect(mapTerminusToExitCode('approval_timed_out')).toBe(4);
    expect(mapTerminusToExitCode('workspace_unavailable')).toBe(5);
    expect(mapTerminusToExitCode('provider_probe_failed')).toBe(6);
  });

  it('a mid-run provider error is a task failure, not the probe code', () => {
    // 's 6 is the pre-run probe (no provider / unknown model). A
    // provider error during the run is a failed task whose failure code is
    // provider_transient/provider_auth.
    expect(mapTerminusToExitCode('provider_transient')).toBe(1);
    expect(mapTerminusToExitCode('provider_auth')).toBe(1);
  });

  it('a timeout is a task failure, never a turn limit', () => {
    // There is no timeout exit code; the --json status is the honest half,
    // and a wall-clock bound must not claim the turn-limit code.
    expect(mapTerminusToExitCode('timeout')).toBe(1);
  });

  it('a cancelled run keeps the POSIX 128+signo convention', () => {
    // The same convention `kubic tui` pins for a signalled quit.
    expect(mapTerminusToExitCode('cancelled', 'SIGHUP')).toBe(129);
    expect(mapTerminusToExitCode('cancelled', 'SIGINT')).toBe(130);
    expect(mapTerminusToExitCode('cancelled', 'SIGTERM')).toBe(143);
    // No signal known (a caller-built result): SIGINT's code, never 1.
    expect(mapTerminusToExitCode('cancelled')).toBe(130);
  });

  it('returns each code end-to-end through runRunCommand', async () => {
    const cases: Array<{
      terminus: HeadlessRunResult['terminus'];
      code: number;
      signal?: string;
    }> = [
      { terminus: 'completed', code: 0 },
      { terminus: 'failed', code: 1 },
      { terminus: 'timeout', code: 1 },
      { terminus: 'cancelled', code: 130, signal: 'SIGINT' },
      { terminus: 'cancelled', code: 143, signal: 'SIGTERM' },
      { terminus: 'turn_limit', code: 3 },
      { terminus: 'approval_denied', code: 4 },
      { terminus: 'approval_timed_out', code: 4 },
      { terminus: 'workspace_unavailable', code: 5 },
      { terminus: 'provider_probe_failed', code: 6 },
      { terminus: 'provider_transient', code: 1 },
      { terminus: 'provider_auth', code: 1 },
    ];
    for (const { terminus, code, signal } of cases) {
      const o = out();
      const exit = (
        await runRunCommand(
          { prompt: 'hello' },
          {
            out: o.write,
            run: stubRun(
              completedResult({
                terminus,
                summary: terminus,
                ...(signal === undefined ? {} : { signal }),
                error:
                  terminus === 'completed'
                    ? undefined
                    : { kind: terminus, message: terminus },
              }),
            ),
          },
        )
      ).exitCode;
      expect(exit, `${terminus} ${signal ?? ''}`).toBe(code);
    }
  });

  it('pins both approval labels to exit 4 while the status keeps them distinct', async () => {
    for (const status of ['approval_denied', 'approval_timed_out'] as const) {
      const o = out();
      const exit = (
        await runRunCommand(
          { prompt: 'hello', json: true },
          {
            out: o.write,
            run: stubRun(
              completedResult({
                terminus: status,
                summary: `${status} summary`,
                error: { kind: status, message: `${status} summary` },
              }),
            ),
          },
        )
      ).exitCode;
      expect(exit).toBe(4);
      expect(o.lines.length).toBe(1);
      const envelope = JSON.parse(o.lines[0] as string) as Record<
        string,
        unknown
      >;
      expect(envelope.status).toBe(status);
      expect(envelope.exitCode).toBe(4);
      expect(envelope.ok).toBe(false);
    }
  });

  it('exits 2 on an empty prompt without running', async () => {
    const o = out();
    const exit = (
      await runRunCommand(
        { prompt: '  ' },
        {
          out: o.write,
          run: stubRun(completedResult()),
        },
      )
    ).exitCode;
    expect(exit).toBe(2);
    expect(o.lines.join('\n')).toMatch(/-p needs a value/);
  });
});

describe('run -p --session validation', () => {
  it('rejects a --session id outside [A-Za-z0-9_-] with exit 2 without calling run', async () => {
    const o = out();
    let called = false;
    const exit = (
      await runRunCommand(
        { prompt: 'hello', session: '../evil' },
        {
          out: o.write,
          run: async () => {
            called = true;
            return completedResult();
          },
        },
      )
    ).exitCode;
    expect(exit).toBe(2);
    expect(called).toBe(false);
    expect(o.lines.join('\n')).toMatch(/session/i);
  });
});

// The terminus the failure classification names for a lane outcome.
const terminusOf = (
  status: Parameters<typeof mapLaneOutcomeToFailure>[0],
  error?: Parameters<typeof mapLaneOutcomeToFailure>[1],
) => mapLaneOutcomeToFailure(status, error).terminus;

describe('lane outcome terminus', () => {
  it('maps a completed lane to completed', () => {
    expect(terminusOf('completed')).toBe('completed');
  });

  it('maps lane failure to failed', () => {
    expect(
      terminusOf('failed', {
        code: 'tool_failed',
        message: 'exit 1',
      }),
    ).toBe('failed');
    expect(terminusOf('aborted')).toBe('failed');
  });

  it('keeps classified approval/workspace/provider errors as 4/5/6-bound termini', () => {
    expect(
      terminusOf('failed', {
        code: 'approval_denied',
        message: 'denied by user',
      }),
    ).toBe('approval_denied');
    expect(
      terminusOf('failed', {
        code: 'workspace_failed',
        message: 'worktree missing',
      }),
    ).toBe('workspace_unavailable');
    expect(
      terminusOf('failed', {
        code: 'provider_transient',
        message: 'api unavailable',
      }),
    ).toBe('provider_transient');
    expect(
      terminusOf('failed', {
        code: 'provider_auth',
        message: 'invalid api key',
      }),
    ).toBe('provider_auth');
  });
});

describe('mapLaneOutcomeToFailure', () => {
  it('carries the failure code beside the terminus', () => {
    const tool = mapLaneOutcomeToFailure('failed', {
      code: 'tool_failed',
      message: 'exit 1',
    });
    expect(tool.terminus).toBe('failed');
    expect(tool.failure?.code).toBe('tool_failed');
    expect(tool.failure?.strategy).toBe('retry_same');
  });

  it('refines a generic model_error detail into its own domain', () => {
    // The durable reason names the generation task, not the failure's
    // domain: a rate limit is provider_transient, a tool fault tool_failed.
    const rate = mapLaneOutcomeToFailure('failed', {
      code: 'model_error',
      message: 'api rate limit exceeded (429)',
    });
    expect(rate.terminus).toBe('provider_transient');
    expect(rate.failure?.code).toBe('provider_transient');

    const tool = mapLaneOutcomeToFailure('failed', {
      code: 'model_error',
      message: "tool 'read' failed: ENOENT",
    });
    expect(tool.terminus).toBe('failed');
    expect(tool.failure?.code).toBe('tool_failed');

    const model = mapLaneOutcomeToFailure('failed', {
      code: 'model_error',
      message: 'the model produced nothing',
    });
    expect(model.terminus).toBe('failed');
    expect(model.failure?.code).toBe('model_failed');
  });

  it('decides the approval terminus by the timeout marker, not by wording', () => {
    // An elapsed wait whose reason also says "denied" is still a timeout;
    // a refusal worded "refused" is still a refusal. The marker rule is the
    // one all three readers share.
    const elapsed = mapLaneOutcomeToFailure('failed', {
      code: 'approval_denied',
      message: "approval denied for worker 'x': timed out after 25ms",
    });
    expect(elapsed.terminus).toBe('approval_timed_out');
    expect(elapsed.failure?.code).toBe('approval_timed_out');
    const refused = mapLaneOutcomeToFailure('failed', {
      code: 'approval_denied',
      message: 'approval refused: no approval surface',
    });
    expect(refused.terminus).toBe('approval_denied');
    expect(refused.failure?.code).toBe('approval_denied');
  });
});

describe('failureForTerminus', () => {
  it('gives every fixed-code terminus its failure classification', () => {
    expect(failureForTerminus('turn_limit')).toMatchObject({
      code: 'run_limit',
      strategy: 'abandon',
    });
    expect(failureForTerminus('approval_denied')).toMatchObject({
      code: 'approval_denied',
      strategy: 'abandon',
    });
    expect(failureForTerminus('approval_timed_out')).toMatchObject({
      code: 'approval_timed_out',
      strategy: 'escalate',
    });
    expect(failureForTerminus('workspace_unavailable')).toMatchObject({
      code: 'workspace_failed',
      strategy: 'escalate',
    });
    expect(failureForTerminus('provider_transient')).toMatchObject({
      code: 'provider_transient',
      strategy: 'retry_same',
    });
    expect(failureForTerminus('provider_auth')).toMatchObject({
      code: 'provider_auth',
      strategy: 'abandon',
    });
  });

  it('classifies the pre-run probe as a non-retryable setup failure', () => {
    // The probe covers "no provider configured" and "the stored model is no
    // longer registered": both are setup failures, never provider_transient
    // — a retry chooser must not be told to retry.
    const probe = failureForTerminus('provider_probe_failed');
    expect(probe).toMatchObject({ code: 'provider_auth', strategy: 'abandon' });
    expect(probe?.remedy).toMatch(/register|pin/i);
  });

  it('carries no failure code for termini that have none', () => {
    for (const terminus of [
      'completed',
      'failed',
      'usage',
      'timeout',
      'cancelled',
    ] as const) {
      expect(failureForTerminus(terminus), terminus).toBeUndefined();
    }
  });
});

describe('run -p failure mapping', () => {
  it('maps a workspace-flavored run rejection to exit 5', async () => {
    const o = out();
    const exit = (
      await runRunCommand(
        { prompt: 'hello' },
        {
          out: o.write,
          run: async () => {
            throw Object.assign(new Error('unknown session: sess-nope'), {
              name: 'SessionAttachError',
            });
          },
        },
      )
    ).exitCode;
    expect(exit).toBe(5);
    expect(o.lines.join('\n')).toMatch(/unknown session/);
  });

  it('emits the mapped failure as a jq-able --json envelope', async () => {
    const o = out();
    const exit = (
      await runRunCommand(
        { prompt: 'hello', json: true },
        {
          out: o.write,
          run: async () => {
            throw Object.assign(new Error('unknown session: sess-nope'), {
              name: 'SessionAttachError',
            });
          },
        },
      )
    ).exitCode;
    expect(exit).toBe(5);
    expect(o.lines.length).toBe(1);
    const envelope = JSON.parse(o.lines[0] as string) as Record<
      string,
      unknown
    >;
    expect(envelope.exitCode).toBe(5);
    expect(envelope.ok).toBe(false);
    expect(envelope.status).toBe('workspace_unavailable');
  });

  it('maps a generic run rejection to exit 1', async () => {
    const o = out();
    const exit = (
      await runRunCommand(
        { prompt: 'hello' },
        {
          out: o.write,
          run: async () => {
            throw new Error('lane exploded');
          },
        },
      )
    ).exitCode;
    expect(exit).toBe(1);
    expect(o.lines.join('\n')).toMatch(/lane exploded/);
  });

  it('maps a persist rejection instead of throwing past the CLI', async () => {
    const o = out();
    const exit = (
      await runRunCommand(
        { prompt: 'hello' },
        {
          out: o.write,
          run: stubRun(completedResult()),
          persist: async () => {
            throw new Error('persist hook blew up');
          },
        },
      )
    ).exitCode;
    expect(exit).toBe(1);
    expect(o.lines.join('\n')).toMatch(/persist hook blew up/);
  });
});

describe('mapCaughtErrorToTerminus', () => {
  it('maps ENOENT-flavored failures to workspace_unavailable', () => {
    expect(mapCaughtErrorToTerminus(new Error('ENOENT: no such file'))).toBe(
      'workspace_unavailable',
    );
  });

  it('maps generic failures to failed', () => {
    expect(mapCaughtErrorToTerminus(new Error('boom'))).toBe('failed');
  });

  it('reads the code field and non-Error throws for workspace signals', () => {
    expect(mapCaughtErrorToTerminus({ code: 'EACCES' })).toBe(
      'workspace_unavailable',
    );
    expect(mapCaughtErrorToTerminus('ENOENT: disk gone')).toBe(
      'workspace_unavailable',
    );
    expect(mapCaughtErrorToTerminus(new Error('worktree lock busy'))).toBe(
      'workspace_unavailable',
    );
    expect(mapCaughtErrorToTerminus('plain string boom')).toBe('failed');
  });

  it('ignores workspace keywords that only appear inside a filesystem path', () => {
    // A checkout under e.g. .claude/worktrees/ or ~/workspace/ must not turn
    // an unrelated failure that quotes a path into workspace_unavailable.
    expect(
      mapCaughtErrorToTerminus(
        new Error(
          'skill load failed: bundle missing at /home/dev/.claude/worktrees/wf-1/packages/skills/dist',
        ),
      ),
    ).toBe('failed');
    expect(
      mapCaughtErrorToTerminus(
        new Error("boom in 'C:\\Users\\dev\\workspace\\kubic\\x.ts'"),
      ),
    ).toBe('failed');
    // The code outside the path still classifies.
    expect(
      mapCaughtErrorToTerminus(
        new Error("ENOENT: no such file or directory, open '/tmp/worktree/x'"),
      ),
    ).toBe('workspace_unavailable');
    expect(
      mapCaughtErrorToTerminus(new Error('boom at C:\\workspace\\x.ts')),
    ).toBe('failed');
    // ENOENT itself is a workspace-class signal, even under a blanked path.
    expect(
      mapCaughtErrorToTerminus(new Error('ENOENT: /home/u/workspace/a')),
    ).toBe('workspace_unavailable');
  });

  it('ignores workspace keywords in paths with spaces or relative paths', () => {
    expect(
      mapCaughtErrorToTerminus(
        new Error(
          'skill load failed: bundle missing at /Users/dev/My workspace/kubic/packages/skills/dist',
        ),
      ),
    ).toBe('failed');
    expect(
      mapCaughtErrorToTerminus(
        new Error("boom reading '/Users/dev/my worktree' contents"),
      ),
    ).toBe('failed');
    expect(
      mapCaughtErrorToTerminus(new Error('bad input worktrees/wf-1/x')),
    ).toBe('failed');
    expect(
      mapCaughtErrorToTerminus(
        new Error('boom in C:\\Users\\My workspace\\kubic\\x.ts'),
      ),
    ).toBe('failed');
    // A keyword outside any path still classifies.
    expect(
      mapCaughtErrorToTerminus(
        new Error('worktree add failed for /Users/dev/My project/x'),
      ),
    ).toBe('workspace_unavailable');
  });

  it('never classifies by a word inside a path the message quotes', () => {
    // A checkout under `…/.claude/worktrees/…` or `~/workspace/…` must not
    // turn an unrelated failure (a missing skill bundle) into exit 5.
    const refused = new Error(
      'skill load failed: review missing at /Users/me/repo/.claude/worktrees/wf-1/packages/skills/bundles',
    );
    refused.name = 'SkillLoadError';
    expect(mapCaughtErrorToTerminus(refused)).toBe('failed');
    expect(
      mapCaughtErrorToTerminus(
        new Error("boom reading '/home/me/workspace/app/config.json'"),
      ),
    ).toBe('failed');
    // A real signal in the same message still counts.
    expect(
      mapCaughtErrorToTerminus(
        new Error("ENOENT: no such file, open '/home/me/workspace/x'"),
      ),
    ).toBe('workspace_unavailable');
  });
  // A path is data, not a signal: a repo under ~/workspace or an agent
  // worktree must not turn an unrelated failure into exit 5.
  it('ignores workspace/worktree words that only appear inside a path', () => {
    expect(
      mapCaughtErrorToTerminus(
        new Error(
          'skill load failed: review missing at /home/u/workspace/repo/.claude/worktrees/wf-1/ext',
        ),
      ),
    ).toBe('failed');
    expect(
      mapCaughtErrorToTerminus(
        new Error("ENOENT: no such file, open '/home/u/workspace/x'"),
      ),
    ).toBe('workspace_unavailable');
    expect(
      mapCaughtErrorToTerminus(new Error('workspace root is not a directory')),
    ).toBe('workspace_unavailable');
  });
  it('ignores workspace words that only appear inside a path', () => {
    // A cwd under `.claude/worktrees/` (or any dir named workspace) must
    // not turn an unrelated failure into exit 5.
    expect(
      mapCaughtErrorToTerminus(
        new Error(
          'skill load failed: /repo/.claude/worktrees/wf-1/skills/review missing',
        ),
      ),
    ).toBe('failed');
    expect(
      mapCaughtErrorToTerminus(new Error('boom in C:\\workspace\\kubic\\a.ts')),
    ).toBe('failed');
    // The errno or the word outside a path still counts.
    expect(
      mapCaughtErrorToTerminus(
        new Error("ENOENT: no such file, open '/home/u/worktrees/x'"),
      ),
    ).toBe('workspace_unavailable');
    expect(
      mapCaughtErrorToTerminus(new Error('git worktree add failed at /tmp/a')),
    ).toBe('workspace_unavailable');
  });
});

describe('run -p headless behavior', () => {
  it('exits 0 and prints the result through the injected sink alone (no terminal)', async () => {
    const o = out();
    const seen: { prompt?: string } = {};
    const exit = (
      await runRunCommand(
        { prompt: 'fix the bug' },
        {
          out: o.write,
          run: stubRun(completedResult({ summary: 'fixed' }), seen),
        },
      )
    ).exitCode;
    expect(exit).toBe(0);
    expect(seen.prompt).toBe('fix the bug');
    expect(o.lines.join('\n')).toMatch(/fixed/);
  });

  it('emits a jq-able --json envelope with session/result/journal-usage pointers', async () => {
    const o = out();
    const exit = (
      await runRunCommand(
        { prompt: 'hello', json: true },
        {
          out: o.write,
          run: stubRun(
            completedResult({
              sessionId: 'sess-json',
              summary: 'json ok',
              journalRef: 'journal:sess-json',
              usageRef: 'usage:sess-json',
              trajectoryRef: 'trajectory:sess-json',
            }),
          ),
        },
      )
    ).exitCode;
    expect(exit).toBe(0);
    expect(o.lines.length).toBe(1);
    const envelope = JSON.parse(o.lines[0] as string) as Record<
      string,
      unknown
    >;
    expect(envelope.sessionId).toBe('sess-json');
    expect(envelope.exitCode).toBe(0);
    const result = envelope.result as Record<string, unknown>;
    expect(typeof result.summary).toBe('string');
    expect((envelope.journal as Record<string, unknown>).ref).toBe(
      'journal:sess-json',
    );
    expect((envelope.usage as Record<string, unknown>).ref).toBe(
      'usage:sess-json',
    );
    expect((envelope.trajectory as Record<string, unknown>).ref).toBe(
      'trajectory:sess-json',
    );
  });

  it('persists session+journal+usage+trajectory identically for text and --json', async () => {
    const persisted: HeadlessRunResult[] = [];
    const mkResult = (): HeadlessRunResult =>
      completedResult({ sessionId: 'sess-persist', summary: 'same' });
    const o1 = out();
    await runRunCommand(
      { prompt: 'hello' },
      {
        out: o1.write,
        run: stubRun(mkResult()),
        persist: async (r) => {
          persisted.push(structuredClone(r));
        },
      },
    );
    const o2 = out();
    await runRunCommand(
      { prompt: 'hello', json: true },
      {
        out: o2.write,
        run: stubRun(mkResult()),
        persist: async (r) => {
          persisted.push(structuredClone(r));
        },
      },
    );
    expect(persisted.length).toBe(2);
    expect(persisted[0]).toEqual(persisted[1]);
    expect(persisted[0]?.sessionId).toBe('sess-persist');
  });

  it('never mounts TuiAltScreen in the -p path', async () => {
    const source = readFileSync(
      new URL('./run-cli.ts', import.meta.url),
      'utf8',
    );
    expect(source).not.toMatch(/TuiAltScreen/);
    expect(source).not.toMatch(/bootScreen/);
    expect(source).not.toMatch(/packages\/tui/);
    expect(source).not.toMatch(/@kubic\/tui/);
    let mounted = false;
    const o = out();
    const exit = (
      await runRunCommand(
        { prompt: 'hello' },
        {
          out: o.write,
          run: stubRun(completedResult()),
          onScreenMount: () => {
            mounted = true;
          },
        },
      )
    ).exitCode;
    expect(exit).toBe(0);
    expect(mounted).toBe(false);
  });

  it('attach reopens the finished -p transcript', async () => {
    const root = tmpRoot();
    const store = openSessionStore(root, createNodeFileBridge(root));
    const o = out();
    let createdId: string | undefined;
    const exit = (
      await runRunCommand(
        { prompt: 'headless hello' },
        {
          out: o.write,
          run: async (prompt: string) => {
            const session = await createSession(
              store,
              { cwd: '/work' },
              BACKGROUND_CONTEXT,
            );
            const id = session.id;
            createdId = id;
            const harness = await Harness.open(
              session.adopt(),
              { models: createModels(), registry: createRegistry() },
              BACKGROUND_CONTEXT,
            );
            try {
              const conversation = await harness.root(BACKGROUND_CONTEXT);
              await conversation.commit(async (tx) => {
                await tx.appendEntry(UserEntry, conversation.id, {
                  model: [
                    {
                      role: 'user',
                      content: prompt,
                      timestamp: Date.now(),
                    },
                  ],
                });
              }, BACKGROUND_CONTEXT);
            } finally {
              await harness.close(BACKGROUND_CONTEXT);
              await session.release(BACKGROUND_CONTEXT);
            }
            return completedResult({
              summary: 'ok',
              sessionId: id,
              journalRef: `journal:${id}`,
              usageRef: `usage:${id}`,
              trajectoryRef: `trajectory:${id}`,
            });
          },
        },
      )
    ).exitCode;
    expect(exit).toBe(0);
    // The id an operator reads off the `session:` line is the id the run
    // created — and it is the handle attach reopens.
    const sessionLine = o.lines.find((line) => line.startsWith('session: '));
    const sessionId = sessionLine?.slice('session: '.length);
    expect(createdId).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(sessionId).toBe(createdId);
    const reopened = await attachSession(
      store,
      sessionId as string,
      BACKGROUND_CONTEXT,
    );
    const attached = await Harness.open(
      reopened.adopt(),
      { models: createModels(), registry: createRegistry() },
      BACKGROUND_CONTEXT,
    );
    try {
      const conversation = await attached.root(BACKGROUND_CONTEXT);
      const page = await conversation.entries(
        {},
        200,
        undefined,
        BACKGROUND_CONTEXT,
      );
      expect(JSON.stringify(page.items)).toMatch(/headless hello/);
    } finally {
      await attached.close(BACKGROUND_CONTEXT);
      await reopened.release(BACKGROUND_CONTEXT);
    }
  });
});

describe('run -p argument handling (mutation hardening)', () => {
  it('accepts the --prompt long form like -p', async () => {
    const o = out();
    const seen: { prompt?: string; sessionId?: string } = {};
    const exit = (
      await runRunCommand(
        { prompt: 'hi there' },
        {
          out: o.write,
          run: stubRun(completedResult(), seen),
        },
      )
    ).exitCode;
    expect(exit).toBe(0);
    expect(seen.prompt).toBe('hi there');
  });

  it('passes --debug through to the runner without gating the run', async () => {
    const o = out();
    const seen: { debug?: boolean } = {};
    const exit = (
      await runRunCommand(
        { prompt: 'hi', debug: true },
        {
          out: o.write,
          run: async (_prompt, options) => {
            seen.debug = (options as { debug?: boolean }).debug;
            return completedResult();
          },
        },
      )
    ).exitCode;
    expect(exit).toBe(0);
    expect(seen.debug).toBe(true);
    // The text block is unchanged: --debug adds stderr, never stdout lines.
    expect(o.lines).toEqual([
      'result: did the thing',
      'session: sess-1',
      'journal: journal:42',
      'usage: usage:42',
      'trajectory: trajectory:42',
    ]);
  });

  it('leaves debug unset when --debug is absent', async () => {
    const o = out();
    const seen: { debug?: boolean } = {};
    const exit = (
      await runRunCommand(
        { prompt: 'hi' },
        {
          out: o.write,
          run: async (_prompt, options) => {
            seen.debug = (options as { debug?: boolean }).debug;
            return completedResult();
          },
        },
      )
    ).exitCode;
    expect(exit).toBe(0);
    expect(seen.debug).toBeUndefined();
  });

  it('passes a valid --session id through to the runner', async () => {
    const o = out();
    const seen: { prompt?: string; sessionId?: string } = {};
    const exit = (
      await runRunCommand(
        { prompt: 'hi', session: 'sess-ok' },
        {
          out: o.write,
          run: stubRun(completedResult(), seen),
        },
      )
    ).exitCode;
    expect(exit).toBe(0);
    expect(seen.sessionId).toBe('sess-ok');
  });

  it('prints the full text result block line-for-line', async () => {
    const o = out();
    const exit = (
      await runRunCommand(
        { prompt: 'hello' },
        {
          out: o.write,
          run: stubRun(completedResult()),
        },
      )
    ).exitCode;
    expect(exit).toBe(0);
    expect(o.lines).toEqual([
      'result: did the thing',
      'session: sess-1',
      'journal: journal:42',
      'usage: usage:42',
      'trajectory: trajectory:42',
    ]);
  });

  it('marks the success envelope ok:true with no error key', async () => {
    const o = out();
    const exit = (
      await runRunCommand(
        { prompt: 'hello', json: true },
        {
          out: o.write,
          run: stubRun(completedResult()),
        },
      )
    ).exitCode;
    expect(exit).toBe(0);
    expect(o.lines.length).toBe(1);
    const envelope = JSON.parse(o.lines[0] as string) as Record<
      string,
      unknown
    >;
    expect(envelope.ok).toBe(true);
    expect(envelope.exitCode).toBe(0);
    expect('error' in envelope).toBe(false);
  });

  it('passes the lane error object through the failure envelope', async () => {
    const o = out();
    const exit = (
      await runRunCommand(
        { prompt: 'hello', json: true },
        {
          out: o.write,
          run: stubRun(
            completedResult({
              terminus: 'failed',
              summary: 'm',
              error: { kind: 'failed', message: 'm' },
            }),
          ),
        },
      )
    ).exitCode;
    expect(exit).toBe(1);
    const envelope = JSON.parse(o.lines[0] as string) as Record<
      string,
      unknown
    >;
    expect(envelope.ok).toBe(false);
    expect(envelope.error).toEqual({ kind: 'failed', message: 'm' });
  });

  it('carries the failure (code/remedy/strategy) in the failure envelope', async () => {
    const o = out();
    const exit = (
      await runRunCommand(
        { prompt: 'hello', json: true },
        {
          out: o.write,
          run: stubRun(
            completedResult({
              terminus: 'failed',
              summary: 'tool_failed: exit 1',
              failure: {
                code: 'tool_failed',
                remedy: 'inspect stderr',
                strategy: 'retry_same',
              },
              error: { kind: 'failed', message: 'exit 1' },
            }),
          ),
        },
      )
    ).exitCode;
    expect(exit).toBe(1);
    const envelope = JSON.parse(o.lines[0] as string) as Record<
      string,
      unknown
    >;
    expect(envelope.failure).toEqual({
      code: 'tool_failed',
      remedy: 'inspect stderr',
      strategy: 'retry_same',
    });
  });

  it('synthesizes the failure for a terminus whose failure code is implied', async () => {
    const o = out();
    const exit = (
      await runRunCommand(
        { prompt: 'hello', json: true },
        {
          out: o.write,
          run: stubRun(
            completedResult({
              terminus: 'turn_limit',
              summary: 'turn limit reached after 3 turns',
              error: { kind: 'turn_limit', message: 'turn limit' },
            }),
          ),
        },
      )
    ).exitCode;
    expect(exit).toBe(3);
    const envelope = JSON.parse(o.lines[0] as string) as {
      failure?: { code: string; strategy: string };
    };
    expect(envelope.failure?.code).toBe('run_limit');
    expect(envelope.failure?.strategy).toBe('abandon');
  });

  it('classifies the pre-run probe envelope as provider_auth/abandon', async () => {
    const o = out();
    const message =
      "session model 'faux/small' is unavailable: provider 'faux' is not registered (pin a model to switch this session)";
    const exit = (
      await runRunCommand(
        { prompt: 'hello', json: true },
        {
          out: o.write,
          run: stubRun(
            completedResult({
              terminus: 'provider_probe_failed',
              summary: message,
              error: { kind: 'provider_probe_failed', message },
            }),
          ),
        },
      )
    ).exitCode;
    expect(exit).toBe(6);
    const envelope = JSON.parse(o.lines[0] as string) as {
      failure?: { code: string; strategy: string };
    };
    // Exit 6 tells a consumer the provider is unavailable; the half must
    // not contradict it with a retryable transient code.
    expect(envelope.failure?.code).toBe('provider_auth');
    expect(envelope.failure?.strategy).toBe('abandon');
  });

  it('maps a non-Error run rejection to unassigned refs in text', async () => {
    const o = out();
    const e = out();
    const exit = (
      await runRunCommand(
        { prompt: 'hello' },
        {
          out: o.write,
          // A separate stderr channel: the `error:` diagnostic must not
          // land in the stdout report.
          logger: createLineLogger(e.write),
          run: async () => {
            throw 'kaput';
          },
        },
      )
    ).exitCode;
    expect(exit).toBe(1);
    expect(e.lines).toEqual(['error: kaput']);
    expect(o.lines).toEqual([
      'result: kaput',
      'session: unassigned',
      'journal: journal:unassigned',
      'usage: usage:unassigned',
      'trajectory: trajectory:unassigned',
    ]);
  });
});

// The interactive-terminal rendering of `kubic run`.
describe('run progress sink', () => {
  function sink() {
    const calls: string[] = [];
    let progressSeen: unknown;
    return {
      calls,
      progressSeen: () => progressSeen,
      factory: () => ({
        begin: () => calls.push('begin'),
        toolStart: () => calls.push('toolStart'),
        toolEnd: () => calls.push('toolEnd'),
        settle: () => calls.push('settle'),
        receipt: (_: HeadlessRunResult, code: number) =>
          calls.push(`receipt:${code}`),
      }),
      run: async (_prompt: string, options: { progress?: unknown }) => {
        progressSeen = options.progress;
        return completedResult();
      },
    };
  }

  it('hands the sink to the runner and prints only the answer on stdout', async () => {
    const s = sink();
    const o = out();
    const code = (
      await runRunCommand(
        { prompt: 'do it' },
        { out: o.write, run: s.run, progress: s.factory },
      )
    ).exitCode;
    expect(code).toBe(0);
    expect(s.progressSeen()).toBeDefined();
    expect(o.lines).toEqual(['', 'did the thing', '']);
    expect(s.calls).toEqual(['settle', 'receipt:0']);
  });

  it('never uses the sink under --json', async () => {
    const s = sink();
    const o = out();
    await runRunCommand(
      { prompt: 'do it', json: true },
      { out: o.write, run: s.run, progress: s.factory },
    );
    expect(s.progressSeen()).toBeUndefined();
    expect(s.calls).toEqual([]);
    expect(JSON.parse(o.lines[0] ?? '{}').ok).toBe(true);
  });

  it('keeps the plain lines without a sink', async () => {
    const o = out();
    await runRunCommand(
      { prompt: 'do it' },
      { out: o.write, run: stubRun(completedResult()) },
    );
    expect(o.lines).toEqual([
      'result: did the thing',
      'session: sess-1',
      'journal: journal:42',
      'usage: usage:42',
      'trajectory: trajectory:42',
    ]);
  });
});
