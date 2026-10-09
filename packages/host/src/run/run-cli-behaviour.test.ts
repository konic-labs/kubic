// Headless `kubic run -p`.
// Faux-only: injected runner, zero network. Covers the exit-code
// contract (0/1/2/3/4/5/6), the --json envelope, identical persistence,
// no alt-screen in -p path, and attach-reopens-transcript.
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  attachSession,
  createSession,
  openSessionStore,
} from '@kubic/agent/lane/session-store';
import {
  BACKGROUND_CONTEXT,
  createModels,
  createRegistry,
  Harness,
  UserEntry,
} from '@kubic/agent/pi-boundary';
import { createLineLogger } from '@kubic/core/cli/logger';
import { createNodeFileBridge } from '@kubic/exec/file-bridge';
import { afterEach, describe, expect, it } from 'vitest';
import { type HeadlessRunResult, runRunCommand } from './run-cli.js';

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

describe('run -p argument handling', () => {
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
