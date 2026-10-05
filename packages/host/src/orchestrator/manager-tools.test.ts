// `spawn_agent` / `wait_for_agent` / `collect_result` (issue #414,
// step 2/6 of the #204 split): a faux manager drives the real adapters,
// backed by fake prod seams and a REAL ParallelScheduler. RED first.
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SessionHandle } from '../../../worker/src/lane/session-store.js';
import {
  BACKGROUND_CONTEXT,
  type Context,
  createModels,
  type EntryRecord,
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
  MemoryStorage,
  ToolResultEntry,
} from '../../../worker/src/pi-boundary.js';
import type { AgentResult } from '../../../worker/src/result.js';
import { buildAgentResult } from '../../../worker/src/result.js';
import { bootManagerLane, type ManagerLaneHandle } from './manager-lane.js';
import {
  type ManagerToolsDeps,
  managerCallsFromLane,
  managerToolsWithStubs,
  type WorkerSpawnRequest,
} from './manager-tools.js';
import { ParallelScheduler } from './parallel/scheduler.js';

interface FakeRoles {
  [role: string]: {
    promptText: string;
    tools: string[];
    modelRef?: string;
    thinking?: string;
  };
}

const ROLES: FakeRoles = {
  implementer: {
    promptText: 'IMPLEMENTER-TEXT',
    tools: ['read', 'write', 'edit', 'bash'],
    thinking: 'high',
  },
  tester: {
    promptText: 'TESTER-TEXT',
    tools: ['read', 'bash'],
    modelRef: 'acme/tester',
    thinking: 'low',
  },
};

function completedResult(
  summary: string,
  filesChanged: string[],
  extra?: Record<string, unknown>,
): AgentResult {
  return {
    ...buildAgentResult({
      status: 'completed',
      summary,
      filesChanged,
      provenance: {
        workerId: 'w',
        sessionId: 's',
        pid: null,
        generation: 0,
        worktree: '/wt',
        model: 'faux/m',
      },
      metrics: { wallMs: 1, latencyMs: 1 },
    }),
    ...extra,
  } as AgentResult;
}

interface Rig {
  deps: ManagerToolsDeps;
  prepared: string[];
  launched: WorkerSpawnRequest[];
  gates: Map<string, (result: AgentResult) => void>;
  settle(agentId: string, result?: AgentResult): void;
  lanes: ManagerLaneHandle[];
}

function rig(options?: {
  maxConcurrency?: number;
  spawnCap?: number;
  waitTimeoutMs?: number;
}): Rig {
  const scheduler = new ParallelScheduler(
    options?.maxConcurrency === undefined
      ? undefined
      : { maxConcurrency: options.maxConcurrency },
  );
  const prepared: string[] = [];
  const launched: WorkerSpawnRequest[] = [];
  const gates = new Map<string, (result: AgentResult) => void>();
  let minted = 0;
  const spawned: string[] = [];
  const deps: ManagerToolsDeps = {
    sessionId: 'run-414',
    runMode: 'autonomous',
    scheduler,
    spawnCap: options?.spawnCap ?? 8,
    waitTimeoutMs: options?.waitTimeoutMs ?? 5000,
    validRoles: Object.keys(ROLES),
    resolveRole: (role) => ROLES[role],
    spawnedIds: () => [...spawned],
    noteSpawned: (agentId) => {
      spawned.push(agentId);
    },
    mintAgentId: () => {
      minted += 1;
      return `worker-${minted}`;
    },
    prepareWorker: async (agentId) => {
      prepared.push(agentId);
      return { agentId, worktreePath: `/wt/${agentId}` };
    },
    launchWorker: (request) =>
      new Promise<AgentResult>((resolve) => {
        launched.push(request);
        gates.set(request.agentId, resolve);
      }),
  };
  return {
    deps,
    prepared,
    launched,
    gates,
    settle: (agentId, result) =>
      gates.get(agentId)?.(
        result ?? completedResult(`done ${agentId}`, [`${agentId}.txt`]),
      ),
    lanes: [],
  };
}

function memoryHandle(id: string): SessionHandle {
  const storage = new MemoryStorage();
  let adopted = false;
  return {
    id,
    dir: `/memory-sessions/${id}`,
    storage,
    meta: { cwd: '/repo', createdAt: new Date(0).toISOString() },
    adopt: () => {
      adopted = true;
      return storage;
    },
    release: async (context: Context): Promise<void> => {
      if (!adopted) await storage.close(context);
    },
  };
}

async function bootLane(
  test: Rig,
  responses: Parameters<ReturnType<typeof fauxProvider>['setResponses']>[0],
  tools = managerToolsWithStubs(test.deps),
): Promise<ManagerLaneHandle> {
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  const model = faux.getModel();
  if (model === undefined) throw new Error('faux has no default model');
  faux.setResponses([...responses]);
  const lane = await bootManagerLane({
    session: memoryHandle(`mgr-${test.lanes.length}`),
    models,
    model,
    sessionId: `mgr-${test.lanes.length}`,
    cwd: '/repo',
    tools,
  });
  test.lanes.push(lane);
  return lane;
}

async function runTurn(
  lane: ManagerLaneHandle,
  content: string,
): Promise<void> {
  const submission = await lane.conversation.submit(
    { type: 'input', content },
    BACKGROUND_CONTEXT,
  );
  const settled = await submission.wait(BACKGROUND_CONTEXT);
  expect(settled.status).toBe('done');
}

async function laneEntries(lane: ManagerLaneHandle): Promise<EntryRecord[]> {
  const page = await lane.conversation.entries(
    {},
    1000,
    undefined,
    BACKGROUND_CONTEXT,
  );
  return [...page.items].reverse();
}

describe('manager spawn/wait/collect adapters (issue #414)', () => {
  const tests: Rig[] = [];
  afterEach(async () => {
    for (const test of tests.splice(0)) {
      // Settle anything still pending so no launch promise leaks.
      for (const resolve of test.gates.values()) {
        resolve(completedResult('cleanup', []));
      }
      for (const lane of test.lanes.splice(0)) {
        await lane.close(BACKGROUND_CONTEXT);
      }
    }
  });
  function useRig(options?: Parameters<typeof rig>[0]): Rig {
    const test = rig(options);
    tests.push(test);
    return test;
  }

  it('a faux manager emitting two spawn_agent calls spawns exactly those workers with those roles/prompts', async () => {
    const test = useRig();
    const lane = await bootLane(test, [
      fauxAssistantMessage(
        [
          fauxToolCall('spawn_agent', {
            role: 'implementer',
            task: 'build the thing',
          }),
          fauxToolCall('spawn_agent', { role: 'tester', task: 'prove it' }),
        ],
        { stopReason: 'toolUse' },
      ),
      fauxAssistantMessage('spawned both'),
    ]);
    await runTurn(lane, 'go');
    // Concurrent under the scheduler's cap: both launches are in flight
    // before either settles — never forced sequential.
    expect(test.prepared).toEqual(['worker-1', 'worker-2']);
    expect(test.launched.map((entry) => entry.agentId)).toEqual([
      'worker-1',
      'worker-2',
    ]);
    const [first, second] = test.launched;
    expect(first?.role).toBe('implementer');
    expect(first?.prompt).toBe('IMPLEMENTER-TEXT\n\nbuild the thing');
    expect(first?.tools).toEqual(['read', 'write', 'edit', 'bash']);
    expect(second?.role).toBe('tester');
    expect(second?.prompt).toBe('TESTER-TEXT\n\nprove it');
    expect(second?.tools).toEqual(['read', 'bash']);
    // The lane's real call record replaces the literal-name recording.
    expect(managerCallsFromLane(await laneEntries(lane))).toEqual([
      'spawn_agent',
      'spawn_agent',
    ]);
  });

  it('the lane toolset is the allowlist in order: three adapters, ten stubs', async () => {
    const test = useRig();
    const lane = await bootLane(test, [fauxAssistantMessage('ok')]);
    const names = lane.registry
      .snapshot()
      .tools()
      .map(({ tool }) => tool.name);
    expect(names).toEqual([
      'spawn_agent',
      'send_to_agent',
      'wait_for_agent',
      'cancel_agent',
      'inspect_agent',
      'collect_result',
      'workspace_diff',
      'workspace_apply',
      'workspace_merge',
      'ask_user',
      'git_status',
      'git_diff',
      'git_log',
    ]);
    const tools = new Map(
      lane.registry
        .snapshot()
        .tools()
        .map(({ tool }) => [tool.name, tool]),
    );
    const call = (name: string, args: Record<string, unknown>) =>
      tools.get(name)?.execute(
        args,
        {
          callId: 'call-1',
          taskId: 'task-1',
          conversationId: lane.conversation.id,
          output: () => undefined,
          diagnostic: () => undefined,
          details: async () => undefined,
          memo: async () => undefined,
          commit: async () => undefined,
          env: undefined,
        } as never,
        BACKGROUND_CONTEXT,
      );
    // Adapters answer with their own codes, never "not wired yet".
    await expect(
      call('spawn_agent', { role: 'teleporter', task: 'x' }),
    ).rejects.toThrow(/unknown_role/);
    await expect(call('cancel_agent', {})).rejects.toThrow(/not wired yet/);
  });

  it('an unknown role is refused with a named reason, spawning nothing', async () => {
    const test = useRig();
    const lane = await bootLane(test, [fauxAssistantMessage('ok')]);
    const tool = lane.registry
      .snapshot()
      .tools()
      .find(({ tool: candidate }) => candidate.name === 'spawn_agent')?.tool;
    if (tool === undefined) throw new Error('spawn_agent not registered');
    await expect(
      tool.execute(
        { role: 'teleporter', task: 'beam it' },
        {
          callId: 'call-1',
          taskId: 'task-1',
          conversationId: lane.conversation.id,
          output: () => undefined,
          diagnostic: () => undefined,
          details: async () => undefined,
          memo: async () => undefined,
          commit: async () => undefined,
          env: undefined,
        } as never,
        BACKGROUND_CONTEXT,
      ),
    ).rejects.toThrow(/unknown_role.*teleporter.*implementer, tester/);
    expect(test.prepared).toEqual([]);
    expect(test.launched).toEqual([]);
  });

  it('collect_result carries exactly summary/filesChanged/status — no transcript keys', async () => {
    const test = useRig();
    const lane = await bootLane(test, [
      fauxAssistantMessage(
        [fauxToolCall('spawn_agent', { role: 'tester', task: 'prove it' })],
        { stopReason: 'toolUse' },
      ),
      fauxAssistantMessage(
        [
          fauxToolCall('wait_for_agent', { agentId: 'worker-1' }),
          fauxToolCall('collect_result', { agentId: 'worker-1' }),
        ],
        { stopReason: 'toolUse' },
      ),
      fauxAssistantMessage('collected'),
    ]);
    const first = await lane.conversation.submit(
      { type: 'input', content: 'go' },
      BACKGROUND_CONTEXT,
    );
    // The spawn tool runs first; settle the worker mid-turn so the queued
    // wait/collect calls observe the settlement (no sleeps — waitFor polls).
    await vi.waitFor(() => expect(test.prepared).toEqual(['worker-1']));
    test.settle(
      'worker-1',
      completedResult('proved it', ['a.txt', 'b.txt'], {
        findings: ['deep finding'],
        provenance: {
          workerId: 'w',
          sessionId: 's',
          pid: 1,
          generation: 0,
          worktree: '/wt',
          model: 'faux/m',
        },
      }),
    );
    await first.wait(BACKGROUND_CONTEXT);
    const results: Array<{ name: string; text: string }> = [];
    for (const entry of await laneEntries(lane)) {
      if (!ToolResultEntry.is(entry)) continue;
      const message = (
        entry.model as unknown as
          | Array<{
              role?: string;
              toolName?: string;
              content?: Array<{ text?: string }>;
            }>
          | undefined
      )?.[0];
      if (message?.role !== 'toolResult') continue;
      results.push({
        name: message.toolName ?? '(none)',
        text: (message.content ?? []).map((part) => part.text ?? '').join(''),
      });
    }
    const collected = results.find((entry) => entry.name === 'collect_result');
    expect(collected).toBeDefined();
    const payload = JSON.parse(collected?.text ?? '{}') as Record<
      string,
      unknown
    >;
    expect(payload).toEqual({
      summary: 'proved it',
      filesChanged: ['a.txt', 'b.txt'],
      status: 'completed',
    });
    const raw = JSON.stringify(payload);
    for (const key of [
      'transcript',
      'messages',
      'entries',
      'provenance',
      'findings',
    ]) {
      expect(raw).not.toContain(key);
    }
  });

  it('a spawn past the concurrency cap waits for a slot; a spawn past --agents is refused', async () => {
    const test = useRig({ maxConcurrency: 1, spawnCap: 2 });
    const lane = await bootLane(test, [
      fauxAssistantMessage(
        [
          fauxToolCall('spawn_agent', { role: 'implementer', task: 'one' }),
          fauxToolCall('spawn_agent', { role: 'implementer', task: 'two' }),
          fauxToolCall('spawn_agent', { role: 'implementer', task: 'three' }),
        ],
        { stopReason: 'toolUse' },
      ),
      fauxAssistantMessage('done'),
    ]);
    const turn = runTurn(lane, 'go');
    // The first admits and launches; the second prepares but stays queued
    // behind the concurrency cap (preparation precedes admission, as on the
    // template path); the third exceeds --agents and refuses outright
    // (sequential rounds: call order decides, claims count).
    await vi.waitFor(() =>
      expect(test.launched.map((entry) => entry.agentId)).toEqual(['worker-1']),
    );
    expect(test.prepared).toEqual(['worker-1', 'worker-2']);
    // Settling the first admits the queued second — the cap is respected,
    // never bypassed and never sequential-by-force.
    test.settle('worker-1');
    await turn;
    expect(test.prepared).toEqual(['worker-1', 'worker-2']);
    expect(test.launched.map((entry) => entry.agentId)).toEqual([
      'worker-1',
      'worker-2',
    ]);
    const refused = await laneEntries(lane).then((entries) =>
      entries
        .filter((entry) => ToolResultEntry.is(entry))
        .map(
          (entry) =>
            (
              entry.model as unknown as
                | Array<{
                    role?: string;
                    toolName?: string;
                    isError?: boolean;
                    content?: Array<{ text?: string }>;
                  }>
                | undefined
            )?.[0],
        )
        .filter(
          (message) =>
            message?.role === 'toolResult' &&
            message.toolName === 'spawn_agent' &&
            message.isError === true,
        )
        .map((message) =>
          (message?.content ?? []).map((part) => part.text ?? '').join(''),
        ),
    );
    expect(refused.join('\n')).toMatch(/spawn_cap_exceeded/);
  });

  it('a spawn that never finds a slot refuses on the queue bound', async () => {
    const test = useRig({ maxConcurrency: 1, waitTimeoutMs: 60 });
    const lane = await bootLane(test, [
      fauxAssistantMessage(
        [
          fauxToolCall('spawn_agent', { role: 'implementer', task: 'one' }),
          fauxToolCall('spawn_agent', { role: 'implementer', task: 'two' }),
        ],
        { stopReason: 'toolUse' },
      ),
      fauxAssistantMessage('done'),
    ]);
    // worker-1 never settles: the queued second spawn hits the bound.
    await runTurn(lane, 'go');
    expect(test.launched.map((entry) => entry.agentId)).toEqual(['worker-1']);
    const texts: string[] = [];
    for (const entry of await laneEntries(lane)) {
      if (!ToolResultEntry.is(entry)) continue;
      const message = (
        entry.model as unknown as
          | Array<{
              role?: string;
              toolName?: string;
              isError?: boolean;
              content?: Array<{ text?: string }>;
            }>
          | undefined
      )?.[0];
      if (message?.role !== 'toolResult' || message.isError !== true) continue;
      texts.push(
        (message.content ?? []).map((part) => part.text ?? '').join(''),
      );
    }
    expect(texts.join('\n')).toMatch(/spawn_queue_timeout/);
  });

  it('wait/collect on unknown or unsettled workers refuse by name', async () => {
    const test = useRig();
    const lane = await bootLane(test, [
      fauxAssistantMessage(
        [fauxToolCall('spawn_agent', { role: 'tester', task: 'prove it' })],
        { stopReason: 'toolUse' },
      ),
      fauxAssistantMessage('spawned'),
    ]);
    await runTurn(lane, 'go');
    const tools = new Map(
      lane.registry
        .snapshot()
        .tools()
        .map(({ tool }) => [tool.name, tool]),
    );
    const call = (name: string, args: Record<string, unknown>) =>
      tools.get(name)?.execute(
        args,
        {
          callId: 'call-1',
          taskId: 'task-1',
          conversationId: lane.conversation.id,
          output: () => undefined,
          diagnostic: () => undefined,
          details: async () => undefined,
          memo: async () => undefined,
          commit: async () => undefined,
          env: undefined,
        } as never,
        BACKGROUND_CONTEXT,
      );
    await expect(call('wait_for_agent', { agentId: 'nobody' })).rejects.toThrow(
      /unknown_agent.*nobody/,
    );
    await expect(call('collect_result', { agentId: 'nobody' })).rejects.toThrow(
      /unknown_agent.*nobody/,
    );
    // worker-1 spawned but never settled: collect refuses without waiting.
    await expect(
      call('collect_result', { agentId: 'worker-1' }),
    ).rejects.toThrow(/collect_before_settle.*worker-1/);
  });

  it('a malformed model pin or budget is refused; valid ones ride the spawn', async () => {
    const test = useRig();
    const lane = await bootLane(test, [
      fauxAssistantMessage(
        [
          fauxToolCall('spawn_agent', {
            role: 'tester',
            task: 'pinned',
            model: 'acme/pinned',
            budget: { maxToolCalls: 5 },
          }),
        ],
        { stopReason: 'toolUse' },
      ),
      fauxAssistantMessage('spawned'),
    ]);
    await runTurn(lane, 'go');
    // The spawn override outranks the role's own pin (issue #202).
    expect(test.launched[0]?.modelRef).toBe('acme/pinned');
    expect(test.launched[0]?.budget).toEqual({ maxToolCalls: 5 });
    const tools = new Map(
      lane.registry
        .snapshot()
        .tools()
        .map(({ tool }) => [tool.name, tool]),
    );
    const call = (name: string, args: Record<string, unknown>) =>
      tools.get(name)?.execute(
        args,
        {
          callId: 'call-1',
          taskId: 'task-1',
          conversationId: lane.conversation.id,
          output: () => undefined,
          diagnostic: () => undefined,
          details: async () => undefined,
          memo: async () => undefined,
          commit: async () => undefined,
          env: undefined,
        } as never,
        BACKGROUND_CONTEXT,
      );
    await expect(
      call('spawn_agent', { role: 'tester', task: 'x', model: 'acme' }),
    ).rejects.toThrow(/invalid_model.*provider\/id/);
    await expect(
      call('spawn_agent', {
        role: 'tester',
        task: 'x',
        budget: { maxTokens: -1 },
      }),
    ).rejects.toThrow(/invalid_budget/);
    await expect(
      call('spawn_agent', {
        role: 'tester',
        task: 'x',
        budget: { maxSmooches: 3 },
      }),
    ).rejects.toThrow(/invalid_budget/);
    expect(test.launched).toHaveLength(1);
  });
});
