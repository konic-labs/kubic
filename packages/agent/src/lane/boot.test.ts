// Root-lane boot on the pi-durable 1.0 harness. The lane opens `Harness`
// over the session handle's `Storage` and runs the session's ROOT conversation;
// the Kubic extension (tools + prompt section) lives in a per-process registry
// that is never stored.
//
// The other halves of land in parallel: owns `SessionHandle`,
// `kubicToolsToPiTools` `policyInterceptorHooks`
// `compactionSettings`. Until they merge, this file mocks those three
// runtime seams (types are erased) and builds pi-durable objects directly,
// exactly as the module contract prescribes.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FakeExecutionEnv } from '../../../exec/src/env.js';
import {
  BACKGROUND_CONTEXT,
  type Context,
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
  MemoryStorage,
  openNodeJsonlStorage,
  type Storage,
  SystemEntry,
} from '../pi-boundary.js';
import { PromptCacheError } from '../prompts.js';
import {
  assemblePrompt,
  bootLane,
  DEFAULT_ROLE,
  type Lane,
  PROMPT_SECTION,
  splitModelId,
} from './boot.js';

vi.mock('./interceptors.js', () => ({
  policyInterceptorHooks: () => [],
}));

vi.mock('../compaction.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../compaction.js')>();
  return {
    ...original,
    compactionSettings: (options: {
      enabled?: boolean;
      configuredReserveTokens?: number;
      keepRecentTokens?: number;
      currentWindow?: () => number | undefined;
    }) => ({
      enabled: options.enabled ?? true,
      keepRecentTokens: options.keepRecentTokens ?? 20_000,
      get reserveTokens() {
        return (
          options.configuredReserveTokens ?? original.DEFAULT_RESERVE_TOKENS
        );
      },
    }),
  };
});

// A faux stand-in adapter: the same 15 registered names, and the
// two tools this file exercises (read sources the Kubic exec env; write
// journals under the harness's own call id) prove the boot threaded the
// Kubic tool context through.
vi.mock('./tools-adapter.js', async () => {
  const { defineTool, Type } = await import('../pi-boundary.js');
  const { OPERATIONS } = await import('../ops/registry.js');
  return {
    kubicToolsToPiTools: (ctx: {
      env: {
        fs: {
          readFile(path: string): string;
          writeFile(path: string, content: string): void;
        };
      };
      sessionId: string;
      agentId: string;
      journal?: {
        append(row: {
          path: string;
          op: string;
          after: string;
          sessionId: string;
          agentId: string;
          toolCallId: string;
          timestamp: number;
        }): unknown;
      };
    }) =>
      Object.keys(OPERATIONS).map((name) =>
        defineTool({
          name,
          description: `${name} (faux)`,
          parameters: Type.Object({
            path: Type.Optional(Type.String()),
            content: Type.Optional(Type.String()),
          }),
          execute: async (args: { path?: string; content?: string }, api) => {
            if (name === 'read' && args.path !== undefined) {
              return {
                content: [
                  {
                    type: 'text' as const,
                    text: ctx.env.fs.readFile(args.path),
                  },
                ],
              };
            }
            if (name === 'write' && args.path !== undefined) {
              ctx.env.fs.writeFile(args.path, args.content ?? '');
              ctx.journal?.append({
                path: args.path,
                op: 'create',
                after: args.content ?? '',
                sessionId: ctx.sessionId,
                agentId: ctx.agentId,
                toolCallId: api.callId,
                timestamp: 1_700_000_000_000,
              });
            }
            return {
              content: [{ type: 'text' as const, text: name }],
            };
          },
        }),
      ),
  };
});

// Model-id splitting: the lane only boots 'provider/id' —
// the table pins what splits and what throws PromptCacheError, so a
// misrouted id fails at parse time, never inside a run.
describe('splitModelId', () => {
  it('splits provider from id on the first slash', () => {
    expect(splitModelId('prov/id')).toEqual({
      provider: 'prov',
      modelId: 'id',
    });
  });

  it.each(['noslash', '/id', 'prov/'])('rejects %s', (id) => {
    expect(() => splitModelId(id)).toThrowError(PromptCacheError);
  });

  it("keeps 'b/c' as the model id for 'a/b/c'", () => {
    expect(splitModelId('a/b/c')).toEqual({
      provider: 'a',
      modelId: 'b/c',
    });
  });
});

const DIRS: string[] = [];
const LANES: Lane[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  for (const lane of LANES.splice(0)) {
    await lane.close(BACKGROUND_CONTEXT).catch(() => undefined);
  }
  for (const dir of DIRS.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

// The handle, built directly (its type does not exist yet): storage,
// metadata and an idempotent release. The boot must treat release as the
// caller's job and only close the harness.
type TestSession = {
  id: string;
  dir: string;
  storage: Storage;
  meta: { cwd: string; createdAt: string };
  adopt(): Storage;
  release(context: Context): Promise<void>;
};
function handle(storage: Storage, id = 'sess-1'): TestSession {
  return {
    id,
    dir: `/tmp/kubic-lane-test/${id}`,
    storage,
    meta: { cwd: '/ws', createdAt: new Date(0).toISOString() },
    // The boot adopts the storage, so the handle must expose it.
    adopt: () => storage,
    release: vi.fn(async () => undefined),
  };
}

function catalog(providerId = 'faux') {
  const faux = fauxProvider({
    provider: providerId,
    models: [
      { id: 'big', contextWindow: 200_000 },
      { id: 'small', contextWindow: 8_192 },
    ],
    // `faux.getModel()` returns the first model, so 'big' is the default.
  });
  const models = createModels();
  models.setProvider(faux.provider);
  const big = faux.getModel('big');
  const small = faux.getModel('small');
  if (big === undefined || small === undefined) throw new Error('faux models');
  return { faux, models, big, small };
}

// A lane with two scripted text answers (one per submitted turn), so a
// test can drive two turns without touching the faux provider.
async function boot(
  extra: Partial<Parameters<typeof bootLane>[0]> = {},
): Promise<Lane> {
  const env = new FakeExecutionEnv({});
  env.fs.writeFile('a.txt', 'lane reads this\n');
  const { faux, models, big } = catalog();
  faux.setResponses([
    fauxAssistantMessage('first answer'),
    fauxAssistantMessage('second answer'),
  ]);
  const session = handle(new MemoryStorage());
  const lane = await bootLane({
    session: session as never,
    models,
    model: big,
    env,
    sessionId: session.id,
    agentId: 'root',
    ...extra,
  });
  LANES.push(lane);
  return lane;
}

function promptTextOf(entry: { model?: unknown }): string {
  const message = (
    entry.model as
      | Array<{ sections?: Record<string, string | null> }>
      | undefined
  )?.[0];
  return message?.sections?.[PROMPT_SECTION] ?? '';
}

// The prompt sections the harness has committed, oldest first.
async function committedPrompts(
  lane: Lane,
  context: Context = BACKGROUND_CONTEXT,
): Promise<string[]> {
  const page = await lane.conversation.entries({}, 200, undefined, context);
  return page.items
    .filter((entry) => SystemEntry.is(entry))
    .map(promptTextOf)
    .reverse();
}

// `pi.system` entries are planned at request preparation, so a turn has to
// run before the assembled prompt is in the transcript.
async function driveOneTurn(lane: Lane, content = 'say hi'): Promise<void> {
  const settled = await (
    await lane.conversation.submit(
      { type: 'input', content },
      BACKGROUND_CONTEXT,
    )
  ).wait(BACKGROUND_CONTEXT);
  // A failed/unanswered turn would make the prompt assertions vacuous.
  expect(settled.status).toBe('done');
}

describe('lane boot on the durable harness', () => {
  it('opens the harness over the session storage and the root conversation', async () => {
    const session = handle(new MemoryStorage());
    const { faux, models, big } = catalog();
    faux.setResponses([fauxAssistantMessage('hi')]);
    const lane = await bootLane({
      session: session as never,
      models,
      model: big,
      env: new FakeExecutionEnv({}),
      sessionId: session.id,
      agentId: 'root',
    });
    LANES.push(lane);
    // The harness and the root conversation are the session's, in-process.
    const root = await lane.harness.root(BACKGROUND_CONTEXT);
    expect(root.id).toBe(lane.conversation.id);
    expect((await lane.harness.inspect(BACKGROUND_CONTEXT)).scheduling).toBe(
      'paused',
    );
    // The per-process registry carries the Kubic extension and its tools.
    expect(
      lane.registry
        .snapshot()
        .installed()
        .map((extension) => extension.name),
    ).toContain('kubic');
    const agent = await lane.conversation.agent(BACKGROUND_CONTEXT);
    const allNames = Object.keys(
      (await import('../ops/registry.js')).OPERATIONS,
    );
    expect(agent.tools.map((tool) => tool.name).sort()).toEqual(
      [...allNames].sort(),
    );
    expect(`${agent.model?.provider}/${agent.model?.modelId}`).toBe('faux/big');
  });

  it('assembles exactly the prompt bytes in one untagged section', async () => {
    const lane = await boot();
    await driveOneTurn(lane);
    const expected = assemblePrompt({
      role: DEFAULT_ROLE,
      cwd: '/fake',
      toolNames: Object.keys((await import('../ops/registry.js')).OPERATIONS),
      metadata: { agent: 'root', lane: 'main', model: 'faux/big' },
    });
    const prompts = await committedPrompts(lane);
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toBe(expected);
    expect(prompts[0]).toMatchSnapshot();
    // `cwd` comes from the Kubic exec env (FakeExecutionEnv's /fake), not
    // the session handle's meta.cwd (/ws) and not a pi-durable env.
    expect(prompts[0]).toContain('cwd: /fake');
  });

  it('sends no new pi.system entry on a second turn (prompt cache prefix)', async () => {
    const lane = await boot();
    await driveOneTurn(lane, 'one');
    const afterFirst = await committedPrompts(lane);
    expect(afterFirst).toHaveLength(1);
    await driveOneTurn(lane, 'two');
    const afterSecond = await committedPrompts(lane);
    expect(afterSecond).toEqual(afterFirst);
  });

  it('keeps an explicit systemPrompt byte-authoritative', async () => {
    const lane = await boot({ systemPrompt: 'custom bytes\nline two' });
    await driveOneTurn(lane);
    expect(await committedPrompts(lane)).toEqual(['custom bytes\nline two']);
  });

  it('runs a Kubic op through the harness for a faux tool call', async () => {
    const env = new FakeExecutionEnv({});
    env.fs.writeFile('a.txt', 'lane reads this\n');
    const { faux, models, big } = catalog();
    faux.setResponses([
      fauxAssistantMessage([fauxToolCall('read', { path: 'a.txt' })], {
        stopReason: 'toolUse',
      }),
      fauxAssistantMessage('read it'),
    ]);
    const session = handle(new MemoryStorage());
    const lane = await bootLane({
      session: session as never,
      models,
      model: big,
      env,
      sessionId: session.id,
      agentId: 'root',
    });
    LANES.push(lane);
    const settled = await (
      await lane.conversation.submit(
        { type: 'input', content: 'read the file' },
        BACKGROUND_CONTEXT,
      )
    ).wait(BACKGROUND_CONTEXT);
    expect(settled.status).toBe('done');
    const page = await lane.conversation.entries(
      {},
      200,
      undefined,
      BACKGROUND_CONTEXT,
    );
    expect(JSON.stringify(page.items)).toContain('lane reads this');
  });

  it('passes the session journal and ids into the Kubic tool context', async () => {
    const rows: Array<{ path: string; toolCallId: string }> = [];
    const { faux, models, big } = catalog();
    faux.setResponses([
      fauxAssistantMessage(
        [fauxToolCall('write', { path: 'n.txt', content: 'hi\n' })],
        { stopReason: 'toolUse' },
      ),
      fauxAssistantMessage('wrote it'),
    ]);
    const session = handle(new MemoryStorage());
    const lane = await bootLane({
      session: session as never,
      models,
      model: big,
      env: new FakeExecutionEnv({}),
      sessionId: session.id,
      agentId: 'root',
      journal: {
        append(row: { path: string; toolCallId: string }) {
          rows.push({ path: row.path, toolCallId: row.toolCallId });
          return row;
        },
      } as never,
    });
    LANES.push(lane);
    await (
      await lane.conversation.submit(
        { type: 'input', content: 'write the file' },
        BACKGROUND_CONTEXT,
      )
    ).wait(BACKGROUND_CONTEXT);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.path).toBe('n.txt');
    // The harness's own call id reaches the journal — not a synthetic one.
    expect(rows[0]?.toolCallId).toMatch(/./);
  });

  it('closes the harness and leaves the session release to the caller', async () => {
    const session = handle(new MemoryStorage());
    const { faux, models, big } = catalog();
    faux.setResponses([fauxAssistantMessage('hi')]);
    const lane = await bootLane({
      session: session as never,
      models,
      model: big,
      env: new FakeExecutionEnv({}),
      sessionId: session.id,
      agentId: 'root',
    });
    await lane.close(BACKGROUND_CONTEXT);
    await expect(lane.harness.inspect(BACKGROUND_CONTEXT)).rejects.toThrow();
    expect(session.release).not.toHaveBeenCalled();
  });

  it('persists configure({ thinkingLevel }) across close and reopen', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'kubic-lane-thinking-'));
    DIRS.push(dir);
    const env = new FakeExecutionEnv({});
    const { faux, models, big } = catalog();
    faux.setResponses([fauxAssistantMessage('hi'), fauxAssistantMessage('hi')]);
    const first = await bootLane({
      session: handle(
        await openNodeJsonlStorage(dir, BACKGROUND_CONTEXT),
        'think',
      ) as never,
      models,
      model: big,
      env,
      sessionId: 'think',
      agentId: 'root',
    });
    await first.conversation.configure(
      { thinkingLevel: 'high' },
      BACKGROUND_CONTEXT,
    );
    await first.close(BACKGROUND_CONTEXT);

    // Supersedes store-verbatim: the lane resolves the
    // stored level against the effective model at boot, so a level the
    // model does not support is clamped with a named notice — never kept
    // silently, never dropped silently.
    const notices: string[] = [];
    const second = await bootLane({
      session: handle(
        await openNodeJsonlStorage(dir, BACKGROUND_CONTEXT),
        'think',
      ) as never,
      models,
      model: big,
      env,
      sessionId: 'think',
      agentId: 'root',
      onThinkingNotice: (line) => notices.push(line),
    });
    LANES.push(second);
    const agent = await second.conversation.agent(BACKGROUND_CONTEXT);
    expect(agent.thinkingLevel).toBe('off');
    expect(notices).toEqual([
      expect.stringMatching(/thinking 'high'.*clamped to 'off'/),
    ]);
  });
});
