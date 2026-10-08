// Allowlisting on the solo lane, ported to the durable
// harness. The class-derived allowlist is now a
// `conversation.configure({ tools })` against the registry's registrations.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FakeExecutionEnv } from '../../../exec/src/env.js';
import {
  AgentDoc,
  BACKGROUND_CONTEXT,
  type Context,
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  MemoryStorage,
  type Storage,
} from '../pi-boundary.js';
import { DEFAULT_PERMISSIONS } from '../policy.js';
import { applyToolPolicy } from './policy.js';
import { bootLane, type Lane } from './solo.js';

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

const SOLOS: Lane[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
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
    dir: `/tmp/kubic-solo-policy/${id}`,
    storage,
    meta: { cwd: '/ws', createdAt: new Date(0).toISOString() },
    // The boot adopts the storage, so the handle must expose it.
    adopt: () => storage,
    release: vi.fn(async () => undefined),
  };
}

async function booted(): Promise<Lane> {
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  faux.setResponses([fauxAssistantMessage('hi')]);
  const solo = await bootLane({
    session: handle() as never,
    models,
    model: faux.getModel(),
    env: new FakeExecutionEnv({}),
    sessionId: 'sess-1',
    agentId: 'root',
  });
  SOLOS.push(solo);
  return solo;
}

async function offered(solo: Lane): Promise<string[]> {
  return (await solo.conversation.agent(BACKGROUND_CONTEXT)).tools.map(
    (tool) => tool.name,
  );
}

describe('tool policy allowlisting', () => {
  it('allowlists all eighteen tools active under solo defaults', async () => {
    const solo = await booted();
    const allowed = await applyToolPolicy(
      solo.registry,
      solo.conversation,
      DEFAULT_PERMISSIONS,
      BACKGROUND_CONTEXT,
    );
    expect(allowed.sort()).toEqual(
      [
        'bash',
        'edit',
        'find',
        'git_branch',
        'git_checkpoint',
        'git_commit',
        'git_conflict_status',
        'git_diff',
        'git_log',
        'git_merge',
        'git_show',
        'git_stage',
        'git_status',
        'git_worktree_list',
        'grep',
        'ls',
        'read',
        'write',
      ].sort(),
    );
    // The conversation offers exactly the allowlist the policy reported.
    expect([...(await offered(solo))].sort()).toEqual(allowed.sort());
    // ... and the durable agent document stores the same names.
    const stored = await solo.harness.snapshot(
      AgentDoc,
      solo.conversation.id,
      BACKGROUND_CONTEXT,
    );
    expect([...((stored?.tools as string[] | undefined) ?? [])].sort()).toEqual(
      allowed.sort(),
    );
  });

  it('allowlist removes tools outside the classes', async () => {
    const solo = await booted();
    await applyToolPolicy(
      solo.registry,
      solo.conversation,
      { ...DEFAULT_PERMISSIONS, filesystem: 'none', shell: false, git: false },
      BACKGROUND_CONTEXT,
    );
    expect(await offered(solo)).toEqual([]);
  });

  it('derives the allowlist the conversation actually offers', async () => {
    const solo = await booted();
    const classes = {
      ...DEFAULT_PERMISSIONS,
      filesystem: 'read' as const,
      shell: false as const,
      git: false as const,
    };
    const allowed = await applyToolPolicy(
      solo.registry,
      solo.conversation,
      classes,
      BACKGROUND_CONTEXT,
    );
    expect(allowed.sort()).toEqual(['find', 'grep', 'ls', 'read'].sort());
    expect([...(await offered(solo))].sort()).toEqual(allowed.sort());
  });

  it('refuses classes that demand a tool the registry does not carry', async () => {
    const solo = await booted();
    // The mock registry carries the full set; a policy that demands git
    // tools on a registry without them is the refused half. Drop the git
    // registrations by constructing a registry with only read tools.
    const onlyRead = {
      snapshot: () => ({
        tools: () => [{ extension: { name: 'kubic' }, tool: { name: 'read' } }],
      }),
    };
    await expect(
      applyToolPolicy(
        onlyRead as never,
        solo.conversation,
        DEFAULT_PERMISSIONS,
        BACKGROUND_CONTEXT,
      ),
    ).rejects.toThrow(/not registered/);
  });
});
