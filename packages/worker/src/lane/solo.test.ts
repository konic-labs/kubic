// Solo root-lane boot on the pi-durable 1.0 harness (issue #394; §5.1,
// §20.7). The lane opens `Harness` over the session handle's `Storage` and
// runs the session's ROOT conversation; the Kubic extension (tools +
// prompt section) lives in a per-process registry that is never stored.
//
// The other halves of EPIC K land in parallel: #392 owns `SessionHandle`,
// #393 `kubicToolsToPiTools`, #397 `policyInterceptorHooks`, #399
// `soloCompactionSettings`. Until they merge, this file mocks those three
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
  assembleSoloPrompt,
  bootSoloLane,
  SOLO_PROMPT_SECTION,
  SOLO_ROLE,
  type SoloLane,
  splitSoloModelId,
} from './solo.js';

vi.mock('./interceptors.js', () => ({
  policyInterceptorHooks: () => [],
}));

vi.mock('../compaction.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../compaction.js')>();
  return {
    ...original,
    soloCompactionSettings: (options: {
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

// A faux stand-in for #393's adapter: the same 15 registered names, and the
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

// Model-id splitting (issue #218): the lane only boots 'provider/id' —
// the table pins what splits and what throws PromptCacheError, so a
// misrouted id fails at parse time, never inside a run.
describe('splitSoloModelId', () => {
  it('splits provider from id on the first slash', () => {
    expect(splitSoloModelId('prov/id')).toEqual({
      provider: 'prov',
      modelId: 'id',
    });
  });

  it.each(['noslash', '/id', 'prov/'])('rejects %s', (id) => {
    expect(() => splitSoloModelId(id)).toThrowError(PromptCacheError);
  });

  it("keeps 'b/c' as the model id for 'a/b/c'", () => {
    expect(splitSoloModelId('a/b/c')).toEqual({
      provider: 'a',
      modelId: 'b/c',
    });
  });
});

const DIRS: string[] = [];
const SOLOS: SoloLane[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  for (const solo of SOLOS.splice(0)) {
    await solo.close(BACKGROUND_CONTEXT).catch(() => undefined);
  }
  for (const dir of DIRS.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

// The #392 handle, built directly (its type does not exist yet): storage,
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
    dir: `/tmp/kubic-solo-test/${id}`,
    storage,
    meta: { cwd: '/ws', createdAt: new Date(0).toISOString() },
    // #395/D8.1: the boot adopts the storage, so the handle must expose it.
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
  extra: Partial<Parameters<typeof bootSoloLane>[0]> = {},
): Promise<SoloLane> {
  const env = new FakeExecutionEnv({});
  env.fs.writeFile('a.txt', 'lane reads this\n');
  const { faux, models, big } = catalog();
  faux.setResponses([
    fauxAssistantMessage('first answer'),
    fauxAssistantMessage('second answer'),
  ]);
  const session = handle(new MemoryStorage());
  const solo = await bootSoloLane({
    session: session as never,
    models,
    model: big,
    env,
    sessionId: session.id,
    agentId: 'root',
    ...extra,
  });
  SOLOS.push(solo);
  return solo;
}

function promptTextOf(entry: { model?: unknown }): string {
  const message = (
    entry.model as
      | Array<{ sections?: Record<string, string | null> }>
      | undefined
  )?.[0];
  return message?.sections?.[SOLO_PROMPT_SECTION] ?? '';
}

// The prompt sections the harness has committed, oldest first.
async function committedPrompts(
  solo: SoloLane,
  context: Context = BACKGROUND_CONTEXT,
): Promise<string[]> {
  const page = await solo.conversation.entries({}, 200, undefined, context);
  return page.items
    .filter((entry) => SystemEntry.is(entry))
    .map(promptTextOf)
    .reverse();
}

// `pi.system` entries are planned at request preparation, so a turn has to
// run before the assembled prompt is in the transcript.
async function driveOneTurn(solo: SoloLane, content = 'say hi'): Promise<void> {
  const settled = await (
    await solo.conversation.submit(
      { type: 'input', content },
      BACKGROUND_CONTEXT,
    )
  ).wait(BACKGROUND_CONTEXT);
  // A failed/unanswered turn would make the prompt assertions vacuous.
  expect(settled.status).toBe('done');
}

describe('solo boot on the durable harness (issue #394)', () => {
  it('opens the harness over the session storage and the root conversation', async () => {
    const session = handle(new MemoryStorage());
    const { faux, models, big } = catalog();
    faux.setResponses([fauxAssistantMessage('hi')]);
    const solo = await bootSoloLane({
      session: session as never,
      models,
      model: big,
      env: new FakeExecutionEnv({}),
      sessionId: session.id,
      agentId: 'root',
    });
    SOLOS.push(solo);
    // The harness and the root conversation are the session's, in-process.
    const root = await solo.harness.root(BACKGROUND_CONTEXT);
    expect(root.id).toBe(solo.conversation.id);
    expect((await solo.harness.inspect(BACKGROUND_CONTEXT)).scheduling).toBe(
      'paused',
    );
    // The per-process registry carries the Kubic extension and its tools.
    expect(
      solo.registry
        .snapshot()
        .installed()
        .map((extension) => extension.name),
    ).toContain('kubic');
    const agent = await solo.conversation.agent(BACKGROUND_CONTEXT);
    const allNames = Object.keys(
      (await import('../ops/registry.js')).OPERATIONS,
    );
    expect(agent.tools.map((tool) => tool.name).sort()).toEqual(
      [...allNames].sort(),
    );
    expect(`${agent.model?.provider}/${agent.model?.modelId}`).toBe('faux/big');
  });

  it('assembles exactly the pre-1.0 prompt bytes in one untagged section', async () => {
    const solo = await boot();
    await driveOneTurn(solo);
    const expected = assembleSoloPrompt({
      role: SOLO_ROLE,
      cwd: '/fake',
      toolNames: Object.keys((await import('../ops/registry.js')).OPERATIONS),
      metadata: { agent: 'root', lane: 'main', model: 'faux/big' },
    });
    const prompts = await committedPrompts(solo);
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toBe(expected);
    expect(prompts[0]).toMatchSnapshot();
    // `cwd` comes from the Kubic exec env (FakeExecutionEnv's /fake), not
    // the session handle's meta.cwd (/ws) and not a pi-durable env.
    expect(prompts[0]).toContain('cwd: /fake');
  });

  it('sends no new pi.system entry on a second turn (prompt cache prefix #33/#82)', async () => {
    const solo = await boot();
    await driveOneTurn(solo, 'one');
    const afterFirst = await committedPrompts(solo);
    expect(afterFirst).toHaveLength(1);
    await driveOneTurn(solo, 'two');
    const afterSecond = await committedPrompts(solo);
    expect(afterSecond).toEqual(afterFirst);
  });

  it('keeps an explicit systemPrompt byte-authoritative', async () => {
    const solo = await boot({ systemPrompt: 'custom bytes\nline two' });
    await driveOneTurn(solo);
    expect(await committedPrompts(solo)).toEqual(['custom bytes\nline two']);
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
    const solo = await bootSoloLane({
      session: session as never,
      models,
      model: big,
      env,
      sessionId: session.id,
      agentId: 'root',
    });
    SOLOS.push(solo);
    const settled = await (
      await solo.conversation.submit(
        { type: 'input', content: 'read the file' },
        BACKGROUND_CONTEXT,
      )
    ).wait(BACKGROUND_CONTEXT);
    expect(settled.status).toBe('done');
    const page = await solo.conversation.entries(
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
    const solo = await bootSoloLane({
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
    SOLOS.push(solo);
    await (
      await solo.conversation.submit(
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
    const solo = await bootSoloLane({
      session: session as never,
      models,
      model: big,
      env: new FakeExecutionEnv({}),
      sessionId: session.id,
      agentId: 'root',
    });
    await solo.close(BACKGROUND_CONTEXT);
    await expect(solo.harness.inspect(BACKGROUND_CONTEXT)).rejects.toThrow();
    expect(session.release).not.toHaveBeenCalled();
  });

  it('persists configure({ thinkingLevel }) across close and reopen (#225)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'kubic-solo-thinking-'));
    DIRS.push(dir);
    const env = new FakeExecutionEnv({});
    const { faux, models, big } = catalog();
    faux.setResponses([fauxAssistantMessage('hi'), fauxAssistantMessage('hi')]);
    const first = await bootSoloLane({
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

    // Issue #225 (§38.3) supersedes store-verbatim: the lane resolves the
    // stored level against the effective model at boot, so a level the
    // model does not support is clamped with a named notice — never kept
    // silently, never dropped silently.
    const notices: string[] = [];
    const second = await bootSoloLane({
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
    SOLOS.push(second);
    const agent = await second.conversation.agent(BACKGROUND_CONTEXT);
    expect(agent.thinkingLevel).toBe('off');
    expect(notices).toEqual([
      expect.stringMatching(/thinking 'high'.*clamped to 'off'/),
    ]);
  });
});
