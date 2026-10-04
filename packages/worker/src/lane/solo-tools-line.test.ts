// Issue #143 (§40.3, §12.1): the model must be told the truth about its own
// tool set. The prompt's `tools:` line and the conversation's offered set
// are one intersection — base tools, narrowed by the permission classes when
// declared and by the role allowlist when declared — in every combination,
// including the classes-only one the pre-fix code advertised in full.
// Ported to the durable harness in #394.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SOLO_DEFAULTS } from '../../../agents/src/policy.js';
import { FakeExecutionEnv } from '../../../exec/src/env.js';
import {
  BACKGROUND_CONTEXT,
  type Context,
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  MemoryStorage,
  openNodeJsonlStorage,
  type Storage,
  SystemEntry,
} from '../pi-boundary.js';
import { bootSoloLane, SOLO_PROMPT_SECTION, type SoloLane } from './solo.js';

vi.mock('./interceptors.js', () => ({
  policyInterceptorHooks: () => [],
}));

vi.mock('../compaction.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../compaction.js')>();
  return {
    ...original,
    soloCompactionSettings: (options: {
      configuredReserveTokens?: number;
      currentWindow?: () => number | undefined;
    }) => ({
      enabled: true,
      keepRecentTokens: 20_000,
      get reserveTokens() {
        return (
          options.configuredReserveTokens ?? original.DEFAULT_RESERVE_TOKENS
        );
      },
    }),
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
const DIRS: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  for (const solo of SOLOS.splice(0)) {
    await solo.close(BACKGROUND_CONTEXT).catch(() => undefined);
  }
  for (const dir of DIRS.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
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
    dir: `/tmp/kubic-solo-tools-line/${id}`,
    storage: new MemoryStorage(),
    meta: { cwd: '/ws', createdAt: new Date(0).toISOString() },
    release: vi.fn(async () => undefined),
  };
}

const READ_ONLY_CLASSES = {
  ...SOLO_DEFAULTS,
  filesystem: 'read' as const,
  shell: false as const,
  git: false as const,
};

function toolsLine(prompt: string): string[] {
  const line = /^tools: (.*)$/m.exec(prompt)?.[1] ?? '';
  return line
    .split(',')
    .map((name) => name.trim())
    .filter((name) => name !== '')
    .sort();
}

// Boots a solo lane and returns what the model is told (`tools:` line of the
// committed prompt section) next to what the conversation actually offers.
async function boot(extra: {
  policy?: Parameters<typeof bootSoloLane>[0]['policy'];
  toolAllowlist?: string[];
}): Promise<{ advertised: string[]; offered: string[] }> {
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  faux.setResponses([fauxAssistantMessage('hi')]);
  const solo = await bootSoloLane({
    session: handle() as never,
    models,
    model: faux.getModel(),
    env: new FakeExecutionEnv({}),
    sessionId: 'sess-1',
    agentId: 'root',
    ...extra,
  });
  SOLOS.push(solo);
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
  const prompt = message?.sections?.[SOLO_PROMPT_SECTION] ?? '';
  const offered = (await solo.conversation.agent(BACKGROUND_CONTEXT)).tools
    .map((tool) => tool.name)
    .sort();
  return { advertised: toolsLine(prompt), offered };
}

describe('the prompt tools line is the same intersection the conversation offers (issue #143)', () => {
  it('neither classes nor allowlist: every base tool is advertised and offered', async () => {
    const all = Object.keys(
      (await import('../ops/registry.js')).OPERATIONS,
    ).sort();
    const { advertised, offered } = await boot({});
    expect(advertised).toEqual(all);
    expect(offered).toEqual(all);
  });

  it('classes only: a read-only session never advertises write, edit, bash or git', async () => {
    const { advertised, offered } = await boot({
      policy: { classes: READ_ONLY_CLASSES },
    });
    expect(advertised).toEqual(['find', 'grep', 'ls', 'read']);
    expect(offered).toEqual(['find', 'grep', 'ls', 'read']);
  });

  it('allowlist only: the role set is advertised and offered, nothing more', async () => {
    const { advertised, offered } = await boot({
      toolAllowlist: ['read', 'write', 'grep'],
    });
    expect(advertised).toEqual(['grep', 'read', 'write']);
    expect(offered).toEqual(['grep', 'read', 'write']);
  });

  it('classes and allowlist: the narrower of the two, so a role never widens the classes', async () => {
    const { advertised, offered } = await boot({
      policy: { classes: READ_ONLY_CLASSES },
      toolAllowlist: ['read', 'write', 'grep', 'bash'],
    });
    expect(advertised).toEqual(['grep', 'read']);
    expect(offered).toEqual(['grep', 'read']);
  });

  it('a role naming a tool this build does not carry advertises only what is offered', async () => {
    const { advertised, offered } = await boot({
      toolAllowlist: ['read', 'no_such_tool'],
    });
    expect(advertised).toEqual(['read']);
    expect(offered).toEqual(['read']);
  });

  it('enterprise gate: a denied tool leaves both the tools line and the offered set', async () => {
    const { advertised, offered } = await boot({
      policy: { toolAllowed: (tool) => tool !== 'bash' },
    });
    const all = Object.keys((await import('../ops/registry.js')).OPERATIONS)
      .filter((name) => name !== 'bash')
      .sort();
    expect(advertised).toEqual(all);
    expect(offered).toEqual(all);
  });

  it('a reopened session without narrowing offers exactly the prompt tools line (review #394 med 1)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'kubic-solo-tools-reopen-'));
    DIRS.push(dir);
    const all = Object.keys(
      (await import('../ops/registry.js')).OPERATIONS,
    ).sort();

    // One boot on the same sessions dir; drives a turn and reports the
    // prompt's tools: line next to the conversation's offered set.
    async function bootOn(extra: {
      toolAllowlist?: string[];
    }): Promise<{ advertised: string[]; offered: string[] }> {
      const faux = fauxProvider();
      const models = createModels();
      models.setProvider(faux.provider);
      faux.setResponses([fauxAssistantMessage('hi')]);
      const sessionId = 'reopen';
      const solo = await bootSoloLane({
        session: {
          id: sessionId,
          dir,
          storage: await openNodeJsonlStorage(dir, BACKGROUND_CONTEXT),
          meta: { cwd: '/ws', createdAt: new Date(0).toISOString() },
          release: async () => undefined,
        } as never,
        models,
        model: faux.getModel(),
        env: new FakeExecutionEnv({}),
        sessionId,
        agentId: 'root',
        ...extra,
      });
      SOLOS.push(solo);
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
      return {
        advertised: toolsLine(message?.sections?.[SOLO_PROMPT_SECTION] ?? ''),
        offered: (await solo.conversation.agent(BACKGROUND_CONTEXT)).tools
          .map((tool) => tool.name)
          .sort(),
      };
    }

    const narrowed = await bootOn({ toolAllowlist: ['read', 'grep'] });
    expect(narrowed).toEqual({
      advertised: ['grep', 'read'],
      offered: ['grep', 'read'],
    });
    await SOLOS.at(-1)?.close(BACKGROUND_CONTEXT);

    // The narrowing was durably stored; this boot has none, so it must clear
    // the stored filter instead of keeping a set the prompt no longer names.
    const cleared = await bootOn({});
    expect(cleared.advertised).toEqual(all);
    expect(cleared.offered).toEqual(all);
    await SOLOS.at(-1)?.close(BACKGROUND_CONTEXT);
  });
});
