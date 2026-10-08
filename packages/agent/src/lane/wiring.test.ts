// Lane boot wiring on the durable harness: the registry install order (=
// hook order), the prompt sections (role prompt, appended context blocks), and
// the HarnessSettings the boot hands over.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FakeExecutionEnv } from '../../../exec/src/env.js';
import type { EscalationLadder } from '../model-select.js';
import {
  BACKGROUND_CONTEXT,
  type Context,
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  hook,
  MemoryStorage,
  type Storage,
  SystemEntry,
  ToolTask,
} from '../pi-boundary.js';
import { assemblePrompt, bootLane, type Lane, PROMPT_SECTION } from './boot.js';

const captured = vi.hoisted(() => ({
  interceptorCalls: 0,
  interceptorOptions: undefined as
    | {
        workspace?: string;
        readRoots?: readonly string[];
      }
    | undefined,
  compactionOptions: [] as Array<{
    enabled?: boolean;
    configuredReserveTokens?: number;
    keepRecentTokens?: number;
    currentWindow: () => number | undefined;
  }>,
}));

vi.mock('./interceptors.js', () => ({
  policyInterceptorHooks: (options: {
    workspace?: string;
    readRoots?: readonly string[];
  }) => {
    captured.interceptorCalls += 1;
    captured.interceptorOptions = options;
    return [{ task: 'ToolTask', handlers: {} }];
  },
}));

vi.mock('../compaction.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../compaction.js')>();
  return {
    ...original,
    compactionSettings: (options: {
      enabled?: boolean;
      configuredReserveTokens?: number;
      keepRecentTokens?: number;
      currentWindow: () => number | undefined;
    }) => {
      captured.compactionOptions.push(options);
      return {
        enabled: options.enabled ?? true,
        keepRecentTokens: options.keepRecentTokens ?? 20_000,
        get reserveTokens() {
          return options.configuredReserveTokens ?? 16_384;
        },
      };
    },
  };
});

vi.mock('./tools-adapter.js', async () => {
  const { defineTool, Type } = await import('../pi-boundary.js');
  const { OPERATIONS } = await import('../ops/registry.js');
  return {
    kubicToolsToPiTools: () =>
      Object.keys(OPERATIONS).map((name) =>
        defineTool({
          name,
          description: `${name} (faux)`,
          parameters: Type.Object({}),
          execute: async () => ({
            content: [{ type: 'text' as const, text: name }],
          }),
        }),
      ),
  };
});

const LANES: Lane[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  captured.interceptorCalls = 0;
  captured.interceptorOptions = undefined;
  captured.compactionOptions = [];
  for (const lane of LANES.splice(0)) {
    await lane.close(BACKGROUND_CONTEXT).catch(() => undefined);
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
    dir: `/tmp/kubic-lane-wiring/${id}`,
    storage,
    meta: { cwd: '/ws', createdAt: new Date(0).toISOString() },
    // The boot adopts the storage, so the handle must expose it.
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
  extra: Parameters<typeof bootLane>[0] extends infer _
    ? Record<string, unknown>
    : never,
): Promise<Lane> {
  const { faux, models } = catalog();
  faux.setResponses([fauxAssistantMessage('hi'), fauxAssistantMessage('hi')]);
  const lane = await bootLane({
    session: handle() as never,
    models,
    model: faux.getModel('big'),
    env: new FakeExecutionEnv({}),
    sessionId: 'sess-1',
    agentId: 'root',
    ...extra,
  } as Parameters<typeof bootLane>[0]);
  LANES.push(lane);
  return lane;
}

async function committedPrompt(lane: Lane): Promise<string> {
  const settled = await (
    await lane.conversation.submit(
      { type: 'input', content: 'hi' },
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
  const system = page.items.find((entry) => SystemEntry.is(entry));
  const message = (
    system?.model as unknown as Array<{
      sections?: Record<string, string | null>;
    }>
  )?.[0];
  return message?.sections?.[PROMPT_SECTION] ?? '';
}

describe('lane boot installs the extension stack in hook order', () => {
  it('policy → spans → kubic, and nothing else', async () => {
    const span = hook(ToolTask, { beforeTool: () => undefined });
    const lane = await boot({
      policy: {
        interceptors: { workspace: '/ws', readRoots: ['/skills-a'] },
        spanHooks: () => [span],
      },
      skillReadRoots: ['/skills-b'],
    });
    expect(
      lane.registry
        .snapshot()
        .installed()
        .map((extension) => extension.name),
    ).toEqual(['kubic.policy', 'kubic.spans', 'kubic']);
    expect(
      lane.registry.snapshot().extension('kubic.policy')?.hooks,
    ).toHaveLength(1);
    expect(
      lane.registry.snapshot().extension('kubic.spans')?.hooks,
    ).toHaveLength(1);
    // The skill read roots extend the interceptor options, never replace them.
    expect(captured.interceptorOptions?.workspace).toBe('/ws');
    expect(captured.interceptorOptions?.readRoots).toEqual([
      '/skills-a',
      '/skills-b',
    ]);
    // The Kubic extension carries tools and the prompt section.
    const kubic = lane.registry.snapshot().extension('kubic');
    expect(kubic?.tools).toHaveLength(18);
    expect(kubic?.sections?.map((section) => section.key)).toEqual([
      PROMPT_SECTION,
    ]);
    // The handlers are built per boot from the current options, never
    // captured once at module load: two boots, two fresh registrations.
    expect(captured.interceptorCalls).toBe(1);
    await boot({
      policy: { interceptors: { workspace: '/ws' } },
    });
    expect(captured.interceptorCalls).toBe(2);
  });

  it('installs only the Kubic extension when no policy hooks are given', async () => {
    const lane = await boot({});
    expect(
      lane.registry
        .snapshot()
        .installed()
        .map((extension) => extension.name),
    ).toEqual(['kubic']);
  });
});

describe('lane boot prompt sections', () => {
  it('a role prompt replaces the DEFAULT_ROLE_PROMPT seed, prefix rules intact', async () => {
    const lane = await boot({ rolePrompt: 'ROLE TEXT' });
    const prompt = await committedPrompt(lane);
    expect(prompt).toBe(
      assemblePrompt({
        role: 'ROLE TEXT',
        cwd: '/fake',
        toolNames: Object.keys((await import('../ops/registry.js')).OPERATIONS),
        metadata: { agent: 'root', lane: 'main', model: 'faux/big' },
      }),
    );
    expect(prompt.startsWith('ROLE TEXT\ncwd: /fake\n')).toBe(true);
  });

  it('appends context blocks as a suffix, never rewriting the prefix', async () => {
    const lane = await boot({ promptSections: ['## Skills', 'skill-a'] });
    const prompt = await committedPrompt(lane);
    expect(prompt).toBe(
      assemblePrompt({
        role: [
          'You are a coding agent working in a terminal.',
          'Use the read, write, edit, grep, find, ls, and bash tools to inspect and change files.',
          'Keep answers short and technical.',
        ].join('\n'),
        cwd: '/fake',
        toolNames: Object.keys((await import('../ops/registry.js')).OPERATIONS),
        metadata: { agent: 'root', lane: 'main', model: 'faux/big' },
        extraSections: ['## Skills', 'skill-a'],
      }),
    );
    // The rule: everything the no-sections boot sends is a prefix of it.
    const prefix = prompt.slice(0, prompt.indexOf('\n## Skills'));
    expect(prefix).toContain('meta: agent=root,lane=main,model=faux/big');
  });
});

describe('lane boot hands HarnessSettings compaction to', () => {
  it('passes the configured reserve and a live current-window getter', async () => {
    const { faux, models, big } = catalog();
    faux.setResponses([fauxAssistantMessage('hi')]);
    const lane = await bootLane({
      session: handle() as never,
      models,
      model: big,
      env: new FakeExecutionEnv({}),
      sessionId: 'sess-1',
      agentId: 'root',
      compaction: {
        enabled: false,
        reserveTokens: 4_096,
        keepRecentTokens: 1_111,
      },
    });
    LANES.push(lane);
    expect(captured.compactionOptions).toHaveLength(1);
    const options = captured.compactionOptions[0];
    expect(options?.enabled).toBe(false);
    expect(options?.configuredReserveTokens).toBe(4_096);
    expect(options?.keepRecentTokens).toBe(1_111);
    expect(options?.currentWindow()).toBe(200_000);
  });

  it('the current-window getter follows an escalation', async () => {
    const { faux, models, big } = catalog();
    faux.setResponses([fauxAssistantMessage('hi')]);
    const lane = await bootLane({
      session: handle() as never,
      models,
      model: big,
      env: new FakeExecutionEnv({}),
      sessionId: 'sess-1',
      agentId: 'root',
      taskId: 'task-1',
    });
    LANES.push(lane);
    expect(captured.compactionOptions[0]?.currentWindow()).toBe(200_000);
    const { escalateLaneModel } = await import('./boot.js');
    await escalateLaneModel(
      lane,
      {
        steps: ['faux/big', 'faux/small'],
        maxEscalations: 1,
        record: [],
      } satisfies EscalationLadder,
      'faux/small',
      'cheaper',
      BACKGROUND_CONTEXT,
    );
    expect(captured.compactionOptions[0]?.currentWindow()).toBe(8_192);
  });
});
