// Headless `kubic run -p` (issue #28; §78, §17, §19, §80, §84).
// Faux-only: injected runner, zero network. Covers the §78 exit-code
// contract (0/1/2/3/4/5/6), the --json envelope, identical persistence,
// no alt-screen in -p path, and attach-reopens-transcript.
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createNodeFileBridge } from '../../exec/src/file-bridge.js';
import {
  attachSession,
  createSession,
  openSessionStore,
} from '../../worker/src/lane/session-store.js';
import { BACKGROUND_CONTEXT } from '../../worker/src/pi-boundary.js';
import {
  type HeadlessRunResult,
  mapCaughtErrorToTerminus,
  mapLaneOutcomeToTerminus,
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

describe('run -p exit-code contract (§78)', () => {
  it('maps every termini class to its §78 code (0-6)', () => {
    expect(mapTerminusToExitCode('completed')).toBe(0);
    expect(mapTerminusToExitCode('failed')).toBe(1);
    expect(mapTerminusToExitCode('usage')).toBe(2);
    expect(mapTerminusToExitCode('budget_exhausted')).toBe(3);
    expect(mapTerminusToExitCode('approval_denied')).toBe(4);
    expect(mapTerminusToExitCode('approval_timed_out')).toBe(4);
    expect(mapTerminusToExitCode('workspace_unavailable')).toBe(5);
    expect(mapTerminusToExitCode('provider_probe_failed')).toBe(6);
  });

  it('returns each code end-to-end through runRunCommand', async () => {
    const cases: Array<{
      terminus: HeadlessRunResult['terminus'];
      code: number;
    }> = [
      { terminus: 'completed', code: 0 },
      { terminus: 'failed', code: 1 },
      { terminus: 'budget_exhausted', code: 3 },
      { terminus: 'approval_denied', code: 4 },
      { terminus: 'approval_timed_out', code: 4 },
      { terminus: 'workspace_unavailable', code: 5 },
      { terminus: 'provider_probe_failed', code: 6 },
    ];
    for (const { terminus, code } of cases) {
      const o = out();
      const exit = await runRunCommand(['-p', 'hello'], {
        out: o.write,
        run: stubRun(
          completedResult({
            terminus,
            summary: terminus,
            error:
              terminus === 'completed'
                ? undefined
                : { kind: terminus, message: terminus },
          }),
        ),
      });
      expect(exit).toBe(code);
    }
  });

  it('pins both approval labels to exit 4 while the status keeps them distinct (issue #129)', async () => {
    for (const status of ['approval_denied', 'approval_timed_out'] as const) {
      const o = out();
      const exit = await runRunCommand(['-p', 'hello', '--json'], {
        out: o.write,
        run: stubRun(
          completedResult({
            terminus: status,
            summary: `${status} summary`,
            error: { kind: status, message: `${status} summary` },
          }),
        ),
      });
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

  it('exits 2 on usage errors (missing -p value)', async () => {
    const o = out();
    const exit = await runRunCommand([], {
      out: o.write,
      run: stubRun(completedResult()),
    });
    expect(exit).toBe(2);
    expect(o.lines.join('\n')).toMatch(/usage/i);
  });
});

describe('run -p --session validation (issue #28, E4)', () => {
  it('rejects a --session id outside [A-Za-z0-9_-] with exit 2 without calling run', async () => {
    const o = out();
    let called = false;
    const exit = await runRunCommand(['-p', 'hello', '--session', '../evil'], {
      out: o.write,
      run: async () => {
        called = true;
        return completedResult();
      },
    });
    expect(exit).toBe(2);
    expect(called).toBe(false);
    expect(o.lines.join('\n')).toMatch(/session/i);
  });
});

describe('mapLaneOutcomeToTerminus (issue #28, E1)', () => {
  it('maps a completed lane to completed', () => {
    expect(mapLaneOutcomeToTerminus('completed')).toBe('completed');
  });

  it('maps lane failure to failed', () => {
    expect(
      mapLaneOutcomeToTerminus('failed', {
        code: 'tool_failed',
        message: 'exit 1',
      }),
    ).toBe('failed');
    expect(mapLaneOutcomeToTerminus('aborted')).toBe('failed');
    expect(mapLaneOutcomeToTerminus('declined')).toBe('failed');
  });

  it('keeps classified budget/approval/workspace/provider errors as 3/4/5/6-bound termini', () => {
    expect(
      mapLaneOutcomeToTerminus('failed', {
        code: 'budget_exhausted',
        message: 'token budget spent',
      }),
    ).toBe('budget_exhausted');
    expect(
      mapLaneOutcomeToTerminus('failed', {
        code: 'approval_denied',
        message: 'denied by user',
      }),
    ).toBe('approval_denied');
    expect(
      mapLaneOutcomeToTerminus('failed', {
        code: 'workspace_failed',
        message: 'worktree missing',
      }),
    ).toBe('workspace_unavailable');
    expect(
      mapLaneOutcomeToTerminus('failed', {
        code: 'provider_transient',
        message: 'api unavailable',
      }),
    ).toBe('provider_probe_failed');
  });
});

describe('run -p failure mapping (issue #28, E2)', () => {
  it('maps a workspace-flavored run rejection to exit 5', async () => {
    const o = out();
    const exit = await runRunCommand(['-p', 'hello'], {
      out: o.write,
      run: async () => {
        throw Object.assign(new Error('unknown session: sess-nope'), {
          name: 'SessionAttachError',
        });
      },
    });
    expect(exit).toBe(5);
    expect(o.lines.join('\n')).toMatch(/unknown session/);
  });

  it('emits the mapped failure as a jq-able --json envelope', async () => {
    const o = out();
    const exit = await runRunCommand(['-p', 'hello', '--json'], {
      out: o.write,
      run: async () => {
        throw Object.assign(new Error('unknown session: sess-nope'), {
          name: 'SessionAttachError',
        });
      },
    });
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
    const exit = await runRunCommand(['-p', 'hello'], {
      out: o.write,
      run: async () => {
        throw new Error('lane exploded');
      },
    });
    expect(exit).toBe(1);
    expect(o.lines.join('\n')).toMatch(/lane exploded/);
  });

  it('maps a persist rejection instead of throwing past the CLI', async () => {
    const o = out();
    const exit = await runRunCommand(['-p', 'hello'], {
      out: o.write,
      run: stubRun(completedResult()),
      persist: async () => {
        throw new Error('persist hook blew up');
      },
    });
    expect(exit).toBe(1);
    expect(o.lines.join('\n')).toMatch(/persist hook blew up/);
  });
});

describe('mapCaughtErrorToTerminus (issue #28, E2)', () => {
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
});

describe('run -p headless behavior (§17, §80)', () => {
  it('exits 0 and prints the result through the injected sink alone (no terminal)', async () => {
    const o = out();
    const seen: { prompt?: string } = {};
    const exit = await runRunCommand(['-p', 'fix the bug'], {
      out: o.write,
      run: stubRun(completedResult({ summary: 'fixed' }), seen),
    });
    expect(exit).toBe(0);
    expect(seen.prompt).toBe('fix the bug');
    expect(o.lines.join('\n')).toMatch(/fixed/);
  });

  it('emits a jq-able --json envelope with session/result/journal-usage pointers', async () => {
    const o = out();
    const exit = await runRunCommand(['-p', 'hello', '--json'], {
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
    });
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
    await runRunCommand(['-p', 'hello'], {
      out: o1.write,
      run: stubRun(mkResult()),
      persist: async (r) => {
        persisted.push(structuredClone(r));
      },
    });
    const o2 = out();
    await runRunCommand(['-p', 'hello', '--json'], {
      out: o2.write,
      run: stubRun(mkResult()),
      persist: async (r) => {
        persisted.push(structuredClone(r));
      },
    });
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
    const exit = await runRunCommand(['-p', 'hello'], {
      out: o.write,
      run: stubRun(completedResult()),
      onScreenMount: () => {
        mounted = true;
      },
    });
    expect(exit).toBe(0);
    expect(mounted).toBe(false);
  });

  it('attach reopens the finished -p transcript', async () => {
    const root = tmpRoot();
    const store = openSessionStore(root, createNodeFileBridge(root));
    const o = out();
    let createdId: string | undefined;
    const exit = await runRunCommand(['-p', 'headless hello'], {
      out: o.write,
      run: async (prompt: string) => {
        const session = await createSession(store, '/work', BACKGROUND_CONTEXT);
        const id = session.metadata.id;
        createdId = id;
        await session.mutate(async (mutator) => {
          await mutator.commit(
            [
              {
                kind: 'entry',
                entry: {
                  id: 'e-headless',
                  parentId: null,
                  type: 'message',
                  message: {
                    role: 'user',
                    content: [{ type: 'text', text: prompt }],
                    timestamp: Date.now(),
                  },
                },
              },
            ],
            BACKGROUND_CONTEXT,
          );
        }, BACKGROUND_CONTEXT);
        await session.close(BACKGROUND_CONTEXT);
        return completedResult({
          summary: 'ok',
          sessionId: id,
          journalRef: `journal:${id}`,
          usageRef: `usage:${id}`,
          trajectoryRef: `trajectory:${id}`,
        });
      },
    });
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
    try {
      const entries = await reopened.findEntries(undefined, BACKGROUND_CONTEXT);
      const text = JSON.stringify(entries);
      expect(text).toMatch(/headless hello/);
    } finally {
      await reopened.close(BACKGROUND_CONTEXT);
    }
  });
});

describe('run -p argument handling (issue #68; mutation hardening)', () => {
  it('accepts the --prompt long form like -p', async () => {
    const o = out();
    const seen: { prompt?: string; sessionId?: string } = {};
    const exit = await runRunCommand(['--prompt', 'hi there'], {
      out: o.write,
      run: stubRun(completedResult(), seen),
    });
    expect(exit).toBe(0);
    expect(seen.prompt).toBe('hi there');
  });

  it('rejects a flag-like -p value instead of running it', async () => {
    const o = out();
    let called = false;
    const exit = await runRunCommand(['-p', '--json'], {
      out: o.write,
      run: async () => {
        called = true;
        return completedResult();
      },
    });
    expect(exit).toBe(2);
    expect(called).toBe(false);
    expect(o.lines.join('\n')).toMatch(/-p needs a value/);
  });

  it('rejects --session without a value or with a flag-like value', async () => {
    for (const args of [
      ['-p', 'hi', '--session'],
      ['-p', 'hi', '--session', '--json'],
    ]) {
      const o = out();
      let called = false;
      const exit = await runRunCommand(args, {
        out: o.write,
        run: async () => {
          called = true;
          return completedResult();
        },
      });
      expect(exit).toBe(2);
      expect(called).toBe(false);
      expect(o.lines.join('\n')).toMatch(/--session needs a value/);
    }
  });

  it('rejects an unknown flag as a usage error', async () => {
    const o = out();
    const exit = await runRunCommand(['-p', 'hi', '--bogus'], {
      out: o.write,
      run: stubRun(completedResult()),
    });
    expect(exit).toBe(2);
    expect(o.lines.join('\n')).toMatch(/unknown flag --bogus/);
  });

  it('points a positional prompt at -p instead of a bare "unknown flag" (exit 2, no lane)', async () => {
    const o = out();
    let called = false;
    const exit = await runRunCommand(['fix tests'], {
      out: o.write,
      run: async () => {
        called = true;
        return completedResult();
      },
    });
    expect(exit).toBe(2);
    expect(called).toBe(false);
    const text = o.lines.join('\n');
    expect(text).toMatch(/unexpected argument "fix tests"/);
    expect(text).toContain("kubic run -p 'fix tests'");
  });

  it('single-quotes the suggested prompt so $ and backticks never expand when pasted', async () => {
    const o = out();
    const exit = await runRunCommand(["echo $HOME `id` it's"], {
      out: o.write,
      run: async () => completedResult(),
    });
    expect(exit).toBe(2);
    expect(o.lines.join('\n')).toContain(
      "kubic run -p 'echo $HOME `id` it'\\''s'",
    );
  });

  it('passes --debug through to the runner without gating the run (issue #98)', async () => {
    const o = out();
    const seen: { debug?: boolean } = {};
    const exit = await runRunCommand(['-p', 'hi', '--debug'], {
      out: o.write,
      run: async (_prompt, options) => {
        seen.debug = (options as { debug?: boolean }).debug;
        return completedResult();
      },
    });
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
    const exit = await runRunCommand(['-p', 'hi'], {
      out: o.write,
      run: async (_prompt, options) => {
        seen.debug = (options as { debug?: boolean }).debug;
        return completedResult();
      },
    });
    expect(exit).toBe(0);
    expect(seen.debug).toBeUndefined();
  });

  it('passes a valid --session id through to the runner', async () => {
    const o = out();
    const seen: { prompt?: string; sessionId?: string } = {};
    const exit = await runRunCommand(['-p', 'hi', '--session', 'sess-ok'], {
      out: o.write,
      run: stubRun(completedResult(), seen),
    });
    expect(exit).toBe(0);
    expect(seen.sessionId).toBe('sess-ok');
  });

  it('prints the full text result block line-for-line', async () => {
    const o = out();
    const exit = await runRunCommand(['-p', 'hello'], {
      out: o.write,
      run: stubRun(completedResult()),
    });
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
    const exit = await runRunCommand(['-p', 'hello', '--json'], {
      out: o.write,
      run: stubRun(completedResult()),
    });
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
    const exit = await runRunCommand(['-p', 'hello', '--json'], {
      out: o.write,
      run: stubRun(
        completedResult({
          terminus: 'failed',
          summary: 'm',
          error: { kind: 'failed', message: 'm' },
        }),
      ),
    });
    expect(exit).toBe(1);
    const envelope = JSON.parse(o.lines[0] as string) as Record<
      string,
      unknown
    >;
    expect(envelope.ok).toBe(false);
    expect(envelope.error).toEqual({ kind: 'failed', message: 'm' });
  });

  it('maps a non-Error run rejection to unassigned refs in text', async () => {
    const o = out();
    const exit = await runRunCommand(['-p', 'hello'], {
      out: o.write,
      run: async () => {
        throw 'kaput';
      },
    });
    expect(exit).toBe(1);
    expect(o.lines).toEqual([
      'error: kaput',
      'result: kaput',
      'session: unassigned',
      'journal: journal:unassigned',
      'usage: usage:unassigned',
      'trajectory: trajectory:unassigned',
    ]);
  });
});
