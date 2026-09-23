// Headless `kubic run -p` (issue #28; §78, §17, §19, §80, §84).
// Faux-only: injected runner, zero network. Covers the §78 exit-code
// contract (0/1/2/3/4/5/6), the --json envelope, identical persistence,
// no alt-screen in -p path, and attach-reopens-transcript.
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createNodeFileBridge } from '../../exec/src/file-bridge.js';
import {
  attachSession,
  createSession,
  openSessionStore,
} from '../../worker/src/lane/session-store.js';
import { BACKGROUND_CONTEXT } from '../../worker/src/pi-boundary.js';
import {
  type HeadlessRunResult,
  mapTerminusToExitCode,
  runRunCommand,
} from './run-cli.js';

function tmpRoot(): string {
  return mkdtempSync(join(tmpdir(), 'run-cli-'));
}

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

describe('run -p headless behavior (§17, §80)', () => {
  it('exits 0 with result and no TTY (TERM=dumb CI, stdin /dev/null)', async () => {
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
    const exit = await runRunCommand(['-p', 'headless hello'], {
      out: o.write,
      run: async (prompt: string) => {
        const session = await createSession(store, '/work', BACKGROUND_CONTEXT);
        const id = session.metadata.id;
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
    const sessionId = (o.lines.join('\n').match(/sess-[A-Za-z0-9_-]+/) ??
      o.lines.join('\n').match(/[0-9a-f-]{8,}/))?.[0];
    expect(sessionId).toBeDefined();
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
