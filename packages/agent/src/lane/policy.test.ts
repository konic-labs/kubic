// Allowlisting on the lane, ported to the durable
// harness. The class-derived allowlist is now a
// `conversation.configure({ tools })` against the registry's registrations.

import { FakeExecutionEnv } from '@kubic/exec/test-support/fake-env';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_PERMISSIONS } from '../permissions.js';
import {
  AgentDoc,
  BACKGROUND_CONTEXT,
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  MemoryStorage,
} from '../pi-boundary.js';
import type { TestSession } from '../test-support/session-handle.js';
import { bootLane, type Lane } from './boot.js';
import { applyToolPolicy } from './policy.js';

vi.mock('./interceptors/index.js', () => ({
  policyInterceptorHooks: () => [],
}));

vi.mock('../compaction.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../compaction.js')>();
  return {
    ...original,
    compactionSettings: (options: {
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
            output: [{ type: 'text' as const, text: name }],
          }),
        }),
      ),
  };
});

const LANES: Lane[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  for (const lane of LANES.splice(0)) {
    await lane.close(BACKGROUND_CONTEXT).catch(() => undefined);
  }
});
function handle(id = 'sess-1'): TestSession {
  const storage = new MemoryStorage();
  return {
    id,
    dir: `/tmp/kubic-lane-policy/${id}`,
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
  const lane = await bootLane({
    session: handle() as never,
    models,
    model: faux.getModel(),
    env: new FakeExecutionEnv({}),
    sessionId: 'sess-1',
    agentId: 'root',
  });
  LANES.push(lane);
  return lane;
}

async function offered(lane: Lane): Promise<string[]> {
  return (await lane.conversation.agent(BACKGROUND_CONTEXT)).tools.map(
    (tool) => tool.name,
  );
}

describe('tool policy allowlisting', () => {
  it('allowlists all eighteen tools active under defaults', async () => {
    const lane = await booted();
    const allowed = await applyToolPolicy(
      lane.registry,
      lane.conversation,
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
    expect([...(await offered(lane))].sort()).toEqual(allowed.sort());
    // ... and the durable agent document stores the same names.
    const stored = await lane.harness.snapshot(
      AgentDoc,
      lane.conversation.id,
      BACKGROUND_CONTEXT,
    );
    expect([...((stored?.tools as string[] | undefined) ?? [])].sort()).toEqual(
      allowed.sort(),
    );
  });

  it('allowlist removes tools outside the classes', async () => {
    const lane = await booted();
    await applyToolPolicy(
      lane.registry,
      lane.conversation,
      { ...DEFAULT_PERMISSIONS, filesystem: 'none', shell: false, git: false },
      BACKGROUND_CONTEXT,
    );
    expect(await offered(lane)).toEqual([]);
  });

  it('derives the allowlist the conversation actually offers', async () => {
    const lane = await booted();
    const classes = {
      ...DEFAULT_PERMISSIONS,
      filesystem: 'read' as const,
      shell: false as const,
      git: false as const,
    };
    const allowed = await applyToolPolicy(
      lane.registry,
      lane.conversation,
      classes,
      BACKGROUND_CONTEXT,
    );
    expect(allowed.sort()).toEqual(['find', 'grep', 'ls', 'read'].sort());
    expect([...(await offered(lane))].sort()).toEqual(allowed.sort());
  });

  it('refuses classes that demand a tool the registry does not carry', async () => {
    const lane = await booted();
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
        lane.conversation,
        DEFAULT_PERMISSIONS,
        BACKGROUND_CONTEXT,
      ),
    ).rejects.toThrow(/not registered/);
  });
});
