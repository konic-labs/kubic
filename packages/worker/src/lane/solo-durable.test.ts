// The solo boot against the REAL #393 tools and #399 compaction (review #394
// low 4 / coordinator item 4). Only `./interceptors.js` is mocked: #397's
// `policyInterceptorHooks` is not merged yet, so solo.ts cannot load without
// the mock; the tool adapter, the compaction policy and the harness are real.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FakeExecutionEnv } from '../../../exec/src/env.js';
import {
  DEFAULT_RESERVE_TOKENS,
  effectiveReserveTokens,
} from '../compaction.js';
import { OPERATIONS } from '../ops/registry.js';
import {
  BACKGROUND_CONTEXT,
  type Context,
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
  MemoryStorage,
  type Storage,
  SystemEntry,
} from '../pi-boundary.js';
import { bootSoloLane, SOLO_PROMPT_SECTION, type SoloLane } from './solo.js';

vi.mock('./interceptors.js', () => ({
  policyInterceptorHooks: () => [],
}));

// The REAL soloCompactionSettings, captured so the test can read the live
// reserve getter exactly as the harness does.
const compaction = vi.hoisted(() => ({
  captured: [] as Array<{
    reserveTokens: number;
    enabled: boolean;
    keepRecentTokens: number;
    backgroundTokens: number;
  }>,
}));

vi.mock('../compaction.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../compaction.js')>();
  return {
    ...original,
    soloCompactionSettings: (
      options: Parameters<typeof original.soloCompactionSettings>[0],
    ) => {
      const settings = original.soloCompactionSettings(options);
      compaction.captured.push(settings as never);
      return settings;
    },
  };
});

const SOLOS: SoloLane[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  compaction.captured = [];
  for (const solo of SOLOS.splice(0)) {
    await solo.close(BACKGROUND_CONTEXT).catch(() => undefined);
  }
});

type TestSession = {
  id: string;
  dir: string;
  storage: Storage;
  meta: { cwd: string; createdAt: string };
  adopt(): Storage;
  release(context: Context): Promise<void>;
};
function handle(id = 'sess-1'): TestSession {
  const storage = new MemoryStorage();
  return {
    id,
    dir: `/tmp/kubic-solo-durable/${id}`,
    storage,
    meta: { cwd: '/ws', createdAt: new Date(0).toISOString() },
    // #395/D8.1: the boot adopts the storage, so the handle must expose it.
    adopt: () => storage,
    release: vi.fn(async () => undefined),
  };
}

function catalog() {
  const faux = fauxProvider({
    models: [
      { id: 'big', contextWindow: 200_000 },
      { id: 'small', contextWindow: 8_192 },
    ],
  });
  const models = createModels();
  models.setProvider(faux.provider);
  const big = faux.getModel('big');
  const small = faux.getModel('small');
  if (big === undefined || small === undefined) throw new Error('faux models');
  return { faux, models, big, small };
}

async function boot(
  extra: Partial<Parameters<typeof bootSoloLane>[0]> = {},
  env = new FakeExecutionEnv({}),
): Promise<SoloLane> {
  const { faux, models, big } = catalog();
  faux.setResponses([
    fauxAssistantMessage('first'),
    fauxAssistantMessage('second'),
  ]);
  const session = handle();
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

describe('the boot against the real Kubic tools and compaction policy', () => {
  it('offers the real 15 tools and runs a real Kubic op', async () => {
    const env = new FakeExecutionEnv({});
    env.fs.writeFile('a.txt', 'real adapter reads this\n');
    const { faux, models, big } = catalog();
    faux.setResponses([
      fauxAssistantMessage([fauxToolCall('read', { path: 'a.txt' })], {
        stopReason: 'toolUse',
      }),
      fauxAssistantMessage('read it'),
    ]);
    const session = handle();
    const solo = await bootSoloLane({
      session: session as never,
      models,
      model: big,
      env,
      sessionId: session.id,
      agentId: 'root',
    });
    SOLOS.push(solo);
    const agent = await solo.conversation.agent(BACKGROUND_CONTEXT);
    expect(agent.tools.map((tool) => tool.name).sort()).toEqual(
      Object.keys(OPERATIONS).sort(),
    );
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
    expect(JSON.stringify(page.items)).toContain('real adapter reads this');
    // The prompt's tools: line names exactly the offered set (§40.3).
    const system = page.items.find((entry) => SystemEntry.is(entry));
    const message = (
      system?.model as unknown as Array<{
        sections?: Record<string, string | null>;
      }>
    )?.[0];
    const line = /^tools: (.*)$/m.exec(
      message?.sections?.[SOLO_PROMPT_SECTION] ?? '',
    )?.[1];
    expect(line?.split(',').sort()).toEqual(
      agent.tools.map((tool) => tool.name).sort(),
    );
  });

  it('clamps the live reserve to every configure({ model }), not just boot', async () => {
    const solo = await boot();
    expect(compaction.captured).toHaveLength(1);
    const settings = compaction.captured[0];
    expect(settings?.enabled).toBe(true);
    expect(settings?.keepRecentTokens).toBe(20_000);
    // Kubic owns the trigger: no speculative background compaction.
    expect(settings?.backgroundTokens).toBe(0);
    // Boot model: 200k window, reserve unchanged.
    expect(settings?.reserveTokens).toBe(
      effectiveReserveTokens(200_000, DEFAULT_RESERVE_TOKENS),
    );
    // The TUI/headless switch path is a plain configure.
    await solo.conversation.configure(
      { model: { provider: 'faux', modelId: 'small' } },
      BACKGROUND_CONTEXT,
    );
    expect(settings?.reserveTokens).toBe(
      effectiveReserveTokens(8_192, DEFAULT_RESERVE_TOKENS),
    );
    // ... and back, so the getter is live in both directions.
    await solo.conversation.configure(
      { model: { provider: 'faux', modelId: 'big' } },
      BACKGROUND_CONTEXT,
    );
    expect(settings?.reserveTokens).toBe(
      effectiveReserveTokens(200_000, DEFAULT_RESERVE_TOKENS),
    );
  });

  it('drives a turn on the switched small-window model', async () => {
    const solo = await boot();
    await solo.conversation.configure(
      { model: { provider: 'faux', modelId: 'small' } },
      BACKGROUND_CONTEXT,
    );
    const settled = await (
      await solo.conversation.submit(
        { type: 'input', content: 'small turn' },
        BACKGROUND_CONTEXT,
      )
    ).wait(BACKGROUND_CONTEXT);
    expect(settled.status).toBe('done');
    expect((await solo.conversation.agent(BACKGROUND_CONTEXT)).model).toEqual({
      provider: 'faux',
      modelId: 'small',
    });
  });
});
