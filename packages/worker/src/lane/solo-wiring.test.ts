// Solo lane boot wiring on the durable harness (issues #82, #99, #143;
// ported in #394): the registry install order (= hook order), the prompt
// sections (role prompt, appended context blocks), the LaneRegistry
// binding, and the HarnessSettings the boot hands over.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FakeExecutionEnv } from '../../../exec/src/env.js';
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
import {
  assembleSoloPrompt,
  bootSoloLane,
  SOLO_PROMPT_SECTION,
  type SoloLane,
} from './solo.js';

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
    soloCompactionSettings: (options: {
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

const SOLOS: SoloLane[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  captured.interceptorCalls = 0;
  captured.interceptorOptions = undefined;
  captured.compactionOptions = [];
  for (const solo of SOLOS.splice(0)) {
    await solo.close(BACKGROUND_CONTEXT).catch(() => undefined);
  }
});

type TestSession = {
  id: string;
  dir: string;
  storage: Storage;
  meta: { cwd: string; createdAt: string };
  release(context: Context): Promise<void>;
};
function handle(id = 'sess-1'): TestSession {
  return {
    id,
    dir: `/tmp/kubic-solo-wiring/${id}`,
    storage: new MemoryStorage(),
    meta: { cwd: '/ws', createdAt: new Date(0).toISOString() },
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
  extra: Parameters<typeof bootSoloLane>[0] extends infer _
    ? Record<string, unknown>
    : never,
): Promise<SoloLane> {
  const { faux, models } = catalog();
  faux.setResponses([fauxAssistantMessage('hi'), fauxAssistantMessage('hi')]);
  const solo = await bootSoloLane({
    session: handle() as never,
    models,
    model: faux.getModel('big'),
    env: new FakeExecutionEnv({}),
    sessionId: 'sess-1',
    agentId: 'root',
    ...extra,
  } as Parameters<typeof bootSoloLane>[0]);
  SOLOS.push(solo);
  return solo;
}

async function committedPrompt(solo: SoloLane): Promise<string> {
  const settled = await (
    await solo.conversation.submit(
      { type: 'input', content: 'hi' },
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
  const system = page.items.find((entry) => SystemEntry.is(entry));
  const message = (
    system?.model as unknown as Array<{
      sections?: Record<string, string | null>;
    }>
  )?.[0];
  return message?.sections?.[SOLO_PROMPT_SECTION] ?? '';
}

describe('solo boot installs the extension stack in hook order (issues #208, #98)', () => {
  it('budget → policy → spans → kubic, and nothing else', async () => {
    const budget = hook(ToolTask, { beforeTool: () => undefined });
    const span = hook(ToolTask, { beforeTool: () => undefined });
    const solo = await boot({
      policy: {
        interceptors: { workspace: '/ws', readRoots: ['/skills-a'] },
        beforePolicyHooks: () => [budget],
        spanHooks: () => [span],
      },
      skillReadRoots: ['/skills-b'],
    });
    expect(
      solo.registry
        .snapshot()
        .installed()
        .map((extension) => extension.name),
    ).toEqual(['kubic.budget', 'kubic.policy', 'kubic.spans', 'kubic']);
    expect(
      solo.registry.snapshot().extension('kubic.budget')?.hooks,
    ).toHaveLength(1);
    expect(
      solo.registry.snapshot().extension('kubic.policy')?.hooks,
    ).toHaveLength(1);
    expect(
      solo.registry.snapshot().extension('kubic.spans')?.hooks,
    ).toHaveLength(1);
    // The skill read roots extend the interceptor options, never replace them.
    expect(captured.interceptorOptions?.workspace).toBe('/ws');
    expect(captured.interceptorOptions?.readRoots).toEqual([
      '/skills-a',
      '/skills-b',
    ]);
    // The Kubic extension carries tools and the prompt section.
    const kubic = solo.registry.snapshot().extension('kubic');
    expect(kubic?.tools).toHaveLength(15);
    expect(kubic?.sections?.map((section) => section.key)).toEqual([
      SOLO_PROMPT_SECTION,
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
    const solo = await boot({});
    expect(
      solo.registry
        .snapshot()
        .installed()
        .map((extension) => extension.name),
    ).toEqual(['kubic']);
  });
});

describe('solo boot prompt sections (issues #82, #99)', () => {
  it('a role prompt replaces the SOLO_ROLE seed, prefix rules intact', async () => {
    const solo = await boot({ rolePrompt: 'ROLE TEXT' });
    const prompt = await committedPrompt(solo);
    expect(prompt).toBe(
      assembleSoloPrompt({
        role: 'ROLE TEXT',
        cwd: '/fake',
        toolNames: Object.keys((await import('../ops/registry.js')).OPERATIONS),
        metadata: { agent: 'root', lane: 'main', model: 'faux/big' },
      }),
    );
    expect(prompt.startsWith('ROLE TEXT\ncwd: /fake\n')).toBe(true);
  });

  it('appends context blocks as a suffix, never rewriting the prefix', async () => {
    const solo = await boot({ promptSections: ['## Skills', 'skill-a'] });
    const prompt = await committedPrompt(solo);
    expect(prompt).toBe(
      assembleSoloPrompt({
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
    // The #33 rule: everything the no-sections boot sends is a prefix of it.
    const prefix = prompt.slice(0, prompt.indexOf('\n## Skills'));
    expect(prefix).toContain('meta: agent=root,lane=main,model=faux/big');
  });
});

describe('solo boot binds the lane registry (issue #82, rule 5)', () => {
  it('spawns the binding on boot and reuses it on continuation', async () => {
    const { LaneRegistry } = await import('../prompts.js');
    const registry = new LaneRegistry();
    const first = await boot({ registry });
    expect(first.binding).toMatchObject({
      sessionId: 'sess-1',
      lane: 'main',
      modelId: 'faux/big',
    });
    expect(registry.continuation('sess-1', 'main').modelId).toBe('faux/big');
    const second = await boot({ registry });
    expect(second.binding?.modelId).toBe('faux/big');
  });
});

describe('solo boot hands HarnessSettings compaction to #399 (issues #82, #399)', () => {
  it('passes the configured reserve and a live current-window getter', async () => {
    const { faux, models, big } = catalog();
    faux.setResponses([fauxAssistantMessage('hi')]);
    const solo = await bootSoloLane({
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
    SOLOS.push(solo);
    expect(captured.compactionOptions).toHaveLength(1);
    const options = captured.compactionOptions[0];
    expect(options?.enabled).toBe(false);
    expect(options?.configuredReserveTokens).toBe(4_096);
    expect(options?.keepRecentTokens).toBe(1_111);
    expect(options?.currentWindow()).toBe(200_000);
  });

  it('the current-window getter follows an escalation (issue #82 rule 6)', async () => {
    const { createLadder } = await import('../model-select.js');
    const { faux, models, big } = catalog();
    faux.setResponses([fauxAssistantMessage('hi')]);
    const solo = await bootSoloLane({
      session: handle() as never,
      models,
      model: big,
      env: new FakeExecutionEnv({}),
      sessionId: 'sess-1',
      agentId: 'root',
      taskId: 'task-1',
    });
    SOLOS.push(solo);
    expect(captured.compactionOptions[0]?.currentWindow()).toBe(200_000);
    const { escalateSoloModel } = await import('./solo.js');
    await escalateSoloModel(
      solo,
      createLadder(['faux/big', 'faux/small'], { maxEscalations: 1 }),
      'faux/small',
      'cheaper',
      BACKGROUND_CONTEXT,
    );
    expect(captured.compactionOptions[0]?.currentWindow()).toBe(8_192);
  });
});
