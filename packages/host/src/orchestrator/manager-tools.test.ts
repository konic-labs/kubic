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
import {
  QUESTION_UNANSWERED_CODE,
  type WorkerQuestionOutcome,
} from './approvals/worker-questions.js';
import { bootManagerLane, type ManagerLaneHandle } from './manager-lane.js';
import {
  buildManagerTools,
  type ManagerToolsDeps,
  managerCallsFromLane,
  managerToolsWithStubs,
  type WorkerSpawnRequest,
} from './manager-tools.js';
import { createMergeQueue, type MergeQueue } from './merge/queue.js';
import type { BudgetGate, UsageTally } from './parallel/limits.js';
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
  cancelled: string[];
  followUps: Array<{ agentId: string; prompt: string }>;
  followUpGates: Map<string, (result: AgentResult) => void>;
  settleFollowUp(agentId: string, result?: AgentResult): void;
  queue: MergeQueue;
  landed: string[];
  asked: string[];
  seatScript: WorkerQuestionOutcome[];
  askedGit: Array<{ tool: string; args: unknown }>;
  gitText: { value: string };
}

function rig(options?: {
  maxConcurrency?: number;
  spawnCap?: number;
  waitTimeoutMs?: number;
  mintAgentId?: () => string;
  rowExtra?: Record<string, unknown>;
  budgetGate?: BudgetGate;
  initialUsage?: UsageTally;
}): Rig {
  const scheduler = new ParallelScheduler(
    options?.maxConcurrency === undefined && options?.budgetGate === undefined
      ? undefined
      : {
          ...(options?.maxConcurrency === undefined
            ? {}
            : { maxConcurrency: options.maxConcurrency }),
          ...(options?.budgetGate === undefined
            ? {}
            : { budgetGate: options.budgetGate }),
        },
    options?.initialUsage === undefined
      ? undefined
      : { usage: options.initialUsage },
  );
  const prepared: string[] = [];
  const launched: WorkerSpawnRequest[] = [];
  const gates = new Map<string, (result: AgentResult) => void>();
  const settledResults = new Map<string, AgentResult>();
  const cancelled: string[] = [];
  const followUps: Array<{ agentId: string; prompt: string }> = [];
  const followUpGates = new Map<string, (result: AgentResult) => void>();
  const queue = createMergeQueue();
  const landed: string[] = [];
  const asked: string[] = [];
  const seatScript: WorkerQuestionOutcome[] = [];
  const askedGit: Array<{ tool: string; args: unknown }> = [];
  const gitText = { value: '' };
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
    mintAgentId:
      options?.mintAgentId ??
      (() => {
        minted += 1;
        return `worker-${minted}`;
      }),
    prepareWorker: async (agentId) => {
      prepared.push(agentId);
      return { agentId, worktreePath: `/wt/${agentId}` };
    },
    launchWorker: (request) =>
      new Promise<AgentResult>((resolve) => {
        launched.push(request);
        gates.set(request.agentId, resolve);
      }),
    inspectWorker: (agentId) => {
      const launch = launched.find((entry) => entry.agentId === agentId);
      if (launch === undefined) return undefined;
      const result = settledResults.get(agentId);
      return {
        agentId,
        branch: `kubic/run-414/${agentId}`,
        role: launch.role,
        status: result?.status ?? 'running',
        summary: result?.summary ?? '',
        // A richer-than-contract prod row: the adapter must strip these
        // before they cross the §14.1 boundary (issue #415 review).
        ...(options?.rowExtra ?? {}),
      };
    },
    cancelWorker: async (agentId) => {
      cancelled.push(agentId);
    },
    runFollowUp: (agentId, prompt) =>
      new Promise<AgentResult>((resolve) => {
        followUps.push({ agentId, prompt });
        followUpGates.set(agentId, resolve);
      }),
    readWorkerChange: async (agentId) => ({
      agentId,
      filesChanged: [`${agentId}.txt`],
      patch: `--- a/${agentId}.txt\n+++ b/${agentId}.txt\n@@ -0,0 +1 @@\n+done\n`,
    }),
    stageWorker: async (agentId, branch) => {
      queue.enqueue({ agentId, branch });
      return { position: queue.list().length };
    },
    applyStaged: async () => {
      // The real queue: refused once stopped, preserved otherwise.
      const next = queue.dequeue();
      if (next === undefined) return undefined;
      landed.push(next.agentId);
      return { agentId: next.agentId };
    },
    askSeat: async (question) => {
      asked.push(question);
      return (
        seatScript.shift() ?? {
          answered: false,
          code: QUESTION_UNANSWERED_CODE,
          reason: 'no one is presenting manager questions',
        }
      );
    },
    inspectGit: async (tool, args) => {
      askedGit.push({ tool, args });
      return gitText.value;
    },
  };
  const settleInto = (
    store: Map<string, AgentResult>,
    gate: Map<string, (result: AgentResult) => void>,
    agentId: string,
    result?: AgentResult,
  ): void => {
    const resolved =
      result ?? completedResult(`done ${agentId}`, [`${agentId}.txt`]);
    store.set(agentId, resolved);
    gate.get(agentId)?.(resolved);
  };
  return {
    deps,
    prepared,
    launched,
    gates,
    settle: (agentId, result) =>
      settleInto(settledResults, gates, agentId, result),
    lanes: [],
    cancelled,
    followUps,
    followUpGates,
    settleFollowUp: (agentId, result) =>
      settleInto(settledResults, followUpGates, agentId, result),
    queue,
    landed,
    asked,
    seatScript,
    askedGit,
    gitText,
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

const callTool = (
  lane: ManagerLaneHandle,
  name: string,
  args: Record<string, unknown>,
) => {
  const tool = lane.registry
    .snapshot()
    .tools()
    .find(({ tool: candidate }) => candidate.name === name)?.tool;
  if (tool === undefined) throw new Error(`${name} not registered`);
  return tool.execute(
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
};

const toolTexts = async (
  lane: ManagerLaneHandle,
  name: string,
): Promise<string[]> => {
  const out: string[] = [];
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
    if (message?.role !== 'toolResult' || message.toolName !== name) continue;
    out.push((message.content ?? []).map((part) => part.text ?? '').join(''));
  }
  return out;
};

describe('manager spawn/wait/collect adapters (issue #414)', () => {
  const tests: Rig[] = [];
  afterEach(async () => {
    for (const test of tests.splice(0)) {
      // Settle anything still pending so no launch promise leaks.
      for (const resolve of test.gates.values()) {
        resolve(completedResult('cleanup', []));
      }
      for (const resolve of test.followUpGates.values()) {
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

  it('the lane toolset is the allowlist in order: thirteen adapters, no stubs', async () => {
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
    await expect(call('inspect_agent', { agentId: 'nobody' })).rejects.toThrow(
      /unknown_agent/,
    );
    // No stubs remain: every allowlist name resolves to a real adapter —
    // a call answers or refuses with the adapter's own code, never the
    // stub's "not wired yet".
    for (const name of [
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
    ]) {
      const pending = call(name, {});
      if (pending === undefined) throw new Error(`no tool '${name}'`);
      const outcome = await pending.then(
        () => 'resolved',
        (error: unknown) =>
          error instanceof Error ? error.message : String(error),
      );
      expect(outcome).not.toMatch(/not wired yet/);
    }
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

  it('a role document budget rides the spawn; an explicit spawn budget wins; absent means unbounded (issue #198)', async () => {
    const test = useRig();
    const lane = await bootLane(
      test,
      [
        fauxAssistantMessage(
          [
            fauxToolCall('spawn_agent', {
              role: 'capped',
              task: 'doc budget',
            }),
            fauxToolCall('spawn_agent', {
              role: 'capped',
              task: 'explicit wins',
              budget: { maxToolCalls: 50 },
            }),
            fauxToolCall('spawn_agent', {
              role: 'tester',
              task: 'no budget anywhere',
            }),
          ],
          { stopReason: 'toolUse' },
        ),
        fauxAssistantMessage('spawned'),
      ],
      managerToolsWithStubs({
        ...test.deps,
        validRoles: [...test.deps.validRoles, 'capped'],
        resolveRole: (role) =>
          role === 'capped'
            ? {
                promptText: 'CAPPED-TEXT',
                tools: ['read'],
                budget: { maxToolCalls: 5 },
              }
            : test.deps.resolveRole(role),
      }),
    );
    await runTurn(lane, 'go');
    // The document budget applies when the spawn names none…
    expect(test.launched[0]?.budget).toEqual({ maxToolCalls: 5 });
    // …an explicit spawn budget outranks it…
    expect(test.launched[1]?.budget).toEqual({ maxToolCalls: 50 });
    // …and absent everywhere means unbounded.
    expect(test.launched[2]?.budget).toBeUndefined();
  });
});

describe('manager inspect/cancel/send adapters (issue #415)', () => {
  const tests: Rig[] = [];
  afterEach(async () => {
    for (const test of tests.splice(0)) {
      for (const resolve of test.gates.values()) {
        resolve(completedResult('cleanup', []));
      }
      for (const resolve of test.followUpGates.values()) {
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

  it('cancel_agent on a running worker marks it cancelled and the run continues', async () => {
    const test = useRig({ maxConcurrency: 1 });
    const lane = await bootLane(test, [
      fauxAssistantMessage(
        [fauxToolCall('spawn_agent', { role: 'implementer', task: 'one' })],
        { stopReason: 'toolUse' },
      ),
      // Cancel first (frees the cap-1 slot), then spawn the replacement —
      // sequential rounds run them in call order.
      fauxAssistantMessage(
        [
          fauxToolCall('cancel_agent', { agentId: 'worker-1' }),
          fauxToolCall('spawn_agent', { role: 'implementer', task: 'two' }),
        ],
        { stopReason: 'toolUse' },
      ),
      fauxAssistantMessage('continued'),
    ]);
    // One turn consumes all three scripted responses: the spawn, then the
    // cancel+spawn round (sequential: cancel frees the cap-1 slot first),
    // then the closing text.
    await runTurn(lane, 'go');
    // The seam killed exactly the running worker; the replacement spawned.
    expect(test.cancelled).toEqual(['worker-1']);
    expect(test.launched.map((entry) => entry.agentId)).toEqual([
      'worker-1',
      'worker-2',
    ]);
    expect(test.launched[1]?.prompt).toBe('IMPLEMENTER-TEXT\n\ntwo');
    test.settle('worker-2');
    // The cancelled worker collects as cancelled — the run continued past
    // it instead of inheriting a failure.
    const collected = (await callTool(lane, 'collect_result', {
      agentId: 'worker-1',
    })) as { content: Array<{ text: string }> };
    const payload = JSON.parse(collected.content[0]?.text ?? '{}') as Record<
      string,
      unknown
    >;
    expect(payload.status).toBe('cancelled');
    expect(typeof payload.summary).toBe('string');
  });

  it('inspect_agent reports the worker row without transcript content', async () => {
    const test = useRig();
    const lane = await bootLane(test, [
      fauxAssistantMessage(
        [
          fauxToolCall('spawn_agent', { role: 'tester', task: 'prove it' }),
          fauxToolCall('inspect_agent', { agentId: 'worker-1' }),
        ],
        { stopReason: 'toolUse' },
      ),
      fauxAssistantMessage('inspected'),
    ]);
    await runTurn(lane, 'go');
    const inspected = await toolTexts(lane, 'inspect_agent');
    expect(inspected).toHaveLength(1);
    expect(JSON.parse(inspected[0] ?? '{}')).toEqual({
      agentId: 'worker-1',
      branch: 'kubic/run-414/worker-1',
      role: 'tester',
      status: 'running',
      summary: '',
    });
    test.settle('worker-1', completedResult('proved it', ['a.txt']));
    const settled = await callTool(lane, 'inspect_agent', {
      agentId: 'worker-1',
    });
    expect(settled).toMatchObject({
      content: [
        {
          text: JSON.stringify({
            agentId: 'worker-1',
            branch: 'kubic/run-414/worker-1',
            role: 'tester',
            status: 'completed',
            summary: 'proved it',
          }),
        },
      ],
    });
    await expect(
      callTool(lane, 'inspect_agent', { agentId: 'nobody' }),
    ).rejects.toThrow(/unknown_agent.*nobody/);
  });

  it('inspect_agent strips non-contract keys a richer prod row may carry', async () => {
    const test = useRig({
      rowExtra: {
        transcript: ['s3cr3t'],
        prompt: 'role instructions',
        tools: ['bash'],
        findings: ['deep'],
      },
    });
    const lane = await bootLane(test, [
      fauxAssistantMessage(
        [fauxToolCall('spawn_agent', { role: 'tester', task: 'prove it' })],
        { stopReason: 'toolUse' },
      ),
      fauxAssistantMessage('spawned'),
    ]);
    await runTurn(lane, 'go');
    const inspected = (await callTool(lane, 'inspect_agent', {
      agentId: 'worker-1',
    })) as { content: Array<{ text: string }> };
    // Exactly the five contract keys — the seam's extras never cross.
    expect(JSON.parse(inspected.content[0]?.text ?? '{}')).toEqual({
      agentId: 'worker-1',
      branch: 'kubic/run-414/worker-1',
      role: 'tester',
      status: 'running',
      summary: '',
    });
  });

  it('send_to_agent to an unknown or running worker is refused; to a settled worker it relaunches', async () => {
    const test = useRig();
    const lane = await bootLane(test, [
      fauxAssistantMessage(
        [fauxToolCall('spawn_agent', { role: 'tester', task: 'prove it' })],
        { stopReason: 'toolUse' },
      ),
      fauxAssistantMessage('spawned'),
    ]);
    await runTurn(lane, 'go');
    await expect(
      callTool(lane, 'send_to_agent', { agentId: 'nobody', prompt: 'hi' }),
    ).rejects.toThrow(/unknown_agent.*nobody/);
    await expect(
      callTool(lane, 'send_to_agent', {
        agentId: 'worker-1',
        prompt: 'too early',
      }),
    ).rejects.toThrow(/send_before_settle.*worker-1/);
    expect(test.followUps).toEqual([]);
    test.settle('worker-1', completedResult('proved it', ['a.txt']));
    // Flush through the adapter's own bookkeeping: wait returns only once
    // the background settlement is recorded (no sleeps).
    await callTool(lane, 'wait_for_agent', { agentId: 'worker-1' });
    const sent = (await callTool(lane, 'send_to_agent', {
      agentId: 'worker-1',
      prompt: 'now cover the edge case',
    })) as { content: Array<{ text: string }> };
    expect(JSON.parse(sent.content[0]?.text ?? '{}')).toEqual({
      agentId: 'worker-1',
      status: 'running',
    });
    expect(test.followUps).toEqual([
      { agentId: 'worker-1', prompt: 'now cover the edge case' },
    ]);
    // The follow-up is a new settle cycle: wait observes it, collect reads
    // the latest result.
    const waiting = callTool(lane, 'wait_for_agent', {
      agentId: 'worker-1',
    });
    test.settleFollowUp(
      'worker-1',
      completedResult('covered it', ['a.txt', 'edge.txt']),
    );
    const waited = (await waiting) as { content: Array<{ text: string }> };
    expect(JSON.parse(waited.content[0]?.text ?? '{}')).toEqual({
      agentId: 'worker-1',
      status: 'completed',
    });
    const collected = (await callTool(lane, 'collect_result', {
      agentId: 'worker-1',
    })) as { content: Array<{ text: string }> };
    expect(JSON.parse(collected.content[0]?.text ?? '{}')).toEqual({
      summary: 'covered it',
      filesChanged: ['a.txt', 'edge.txt'],
      status: 'completed',
    });
  });

  it('cancel on a settled or unknown worker is refused and stops nothing', async () => {
    const test = useRig();
    const lane = await bootLane(test, [
      fauxAssistantMessage(
        [fauxToolCall('spawn_agent', { role: 'tester', task: 'prove it' })],
        { stopReason: 'toolUse' },
      ),
      fauxAssistantMessage('spawned'),
    ]);
    await runTurn(lane, 'go');
    await expect(
      callTool(lane, 'cancel_agent', { agentId: 'nobody' }),
    ).rejects.toThrow(/unknown_agent.*nobody/);
    test.settle('worker-1');
    await callTool(lane, 'wait_for_agent', { agentId: 'worker-1' });
    await expect(
      callTool(lane, 'cancel_agent', { agentId: 'worker-1' }),
    ).rejects.toThrow(/already_settled.*worker-1/);
    expect(test.cancelled).toEqual([]);
  });
});

describe('manager cancel during a pending follow-up (issue #425)', () => {
  const tests: Rig[] = [];
  afterEach(async () => {
    for (const test of tests.splice(0)) {
      for (const resolve of test.gates.values()) {
        resolve(completedResult('cleanup', []));
      }
      for (const resolve of test.followUpGates.values()) {
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
  /** Count the scheduler slot releases the adapters actually perform. */
  function countCompletes(test: Rig): string[] {
    const completes: string[] = [];
    const scheduler = test.deps.scheduler;
    const actual = scheduler.complete.bind(scheduler);
    scheduler.complete = (agentId: string) => {
      completes.push(agentId);
      return actual(agentId);
    };
    return completes;
  }
  /** Spawn, settle, and leave a send_to_agent follow-up pending. */
  async function settledWithPendingFollowUp(
    test: Rig,
  ): Promise<ManagerLaneHandle> {
    const lane = await bootLane(test, [
      fauxAssistantMessage(
        [fauxToolCall('spawn_agent', { role: 'tester', task: 'prove it' })],
        { stopReason: 'toolUse' },
      ),
      fauxAssistantMessage('spawned'),
    ]);
    await runTurn(lane, 'go');
    test.settle('worker-1');
    await callTool(lane, 'wait_for_agent', { agentId: 'worker-1' });
    await callTool(lane, 'send_to_agent', {
      agentId: 'worker-1',
      prompt: 'now cover the edge case',
    });
    return lane;
  }

  it('cancel during a pending follow-up resolves as cancelled: no throw, run continues, no slot touched', async () => {
    const test = useRig();
    const completes = countCompletes(test);
    const lane = await settledWithPendingFollowUp(test);
    // The initial settlement freed the worker's scheduler slot.
    expect(completes).toEqual(['worker-1']);
    // The worker process already ended (it settled before the follow-up),
    // so the seam must tolerate the cancel — the rig's seam is the prod
    // shape (records the id, never throws on an ended process).
    const cancelled = (await callTool(lane, 'cancel_agent', {
      agentId: 'worker-1',
    })) as { content: Array<{ text: string }> };
    expect(JSON.parse(cancelled.content[0]?.text ?? '{}')).toEqual({
      agentId: 'worker-1',
      status: 'cancelled',
    });
    expect(test.cancelled).toEqual(['worker-1']);
    // The follow-up held no scheduler slot, so the cancel frees none.
    expect(completes).toEqual(['worker-1']);
    // wait/collect observe the cancellation: the run continues past it.
    const collected = (await callTool(lane, 'collect_result', {
      agentId: 'worker-1',
    })) as { content: Array<{ text: string }> };
    expect(JSON.parse(collected.content[0]?.text ?? '{}')).toMatchObject({
      status: 'cancelled',
    });
  });

  it('a follow-up settlement frees no scheduler slot', async () => {
    const test = useRig();
    const completes = countCompletes(test);
    const lane = await settledWithPendingFollowUp(test);
    expect(completes).toEqual(['worker-1']);
    test.settleFollowUp(
      'worker-1',
      completedResult('covered it', ['edge.txt']),
    );
    const waited = (await callTool(lane, 'wait_for_agent', {
      agentId: 'worker-1',
    })) as { content: Array<{ text: string }> };
    expect(JSON.parse(waited.content[0]?.text ?? '{}')).toMatchObject({
      status: 'completed',
    });
    // The follow-up ran with no scheduler slot: its settlement releases none.
    expect(completes).toEqual(['worker-1']);
    expect(test.deps.scheduler.runningIds()).toEqual([]);
  });
});

describe('manager spawn review findings (issue #414 round 1)', () => {
  const tests: Rig[] = [];
  afterEach(async () => {
    for (const test of tests.splice(0)) {
      for (const resolve of test.gates.values()) {
        resolve(completedResult('cleanup', []));
      }
      for (const resolve of test.followUpGates.values()) {
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

  it('a timed-out spawn frees both slots: no scheduler ghost, no held claim', async () => {
    const test = useRig({ maxConcurrency: 1, spawnCap: 2, waitTimeoutMs: 60 });
    const lane = await bootLane(test, [
      fauxAssistantMessage(
        [
          fauxToolCall('spawn_agent', { role: 'implementer', task: 'one' }),
          fauxToolCall('spawn_agent', { role: 'implementer', task: 'two' }),
        ],
        { stopReason: 'toolUse' },
      ),
      fauxAssistantMessage('timed out'),
      fauxAssistantMessage(
        [fauxToolCall('spawn_agent', { role: 'implementer', task: 'three' })],
        { stopReason: 'toolUse' },
      ),
      fauxAssistantMessage('retried'),
    ]);
    await runTurn(lane, 'go');
    expect(test.launched.map((entry) => entry.agentId)).toEqual(['worker-1']);
    // The withdrawn entry is gone from the scheduler — no ghost for a
    // later drain to admit.
    expect(test.deps.scheduler.pendingIds()).toEqual([]);
    expect(test.deps.scheduler.runningIds()).toEqual(['worker-1']);
    // Settle the running worker, then retry: the freed claim admits the
    // retry under the same cap that refused nothing.
    test.settle('worker-1');
    await callTool(lane, 'wait_for_agent', { agentId: 'worker-1' });
    await runTurn(lane, 'retry');
    expect(test.launched.map((entry) => entry.agentId)).toEqual([
      'worker-1',
      'worker-3',
    ]);
  });

  it('a repeated agent id is refused and never overwrites the record', async () => {
    const test = useRig({ mintAgentId: () => 'solo' });
    const lane = await bootLane(test, [
      fauxAssistantMessage(
        [fauxToolCall('spawn_agent', { role: 'tester', task: 'first' })],
        { stopReason: 'toolUse' },
      ),
      fauxAssistantMessage('spawned'),
    ]);
    await runTurn(lane, 'go');
    test.settle('solo', completedResult('first done', ['a.txt']));
    await callTool(lane, 'wait_for_agent', { agentId: 'solo' });
    await expect(
      callTool(lane, 'spawn_agent', { role: 'tester', task: 'second' }),
    ).rejects.toThrow(/duplicate_agent.*solo/);
    expect(test.launched).toHaveLength(1);
    const collected = (await callTool(lane, 'collect_result', {
      agentId: 'solo',
    })) as { content: Array<{ text: string }> };
    expect(JSON.parse(collected.content[0]?.text ?? '{}')).toMatchObject({
      summary: 'first done',
      status: 'completed',
    });
  });
});

describe('manager workspace adapters (issue #416)', () => {
  const tests: Rig[] = [];
  afterEach(async () => {
    for (const test of tests.splice(0)) {
      for (const resolve of test.gates.values()) {
        resolve(completedResult('cleanup', []));
      }
      for (const resolve of test.followUpGates.values()) {
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

  it('a faux manager diff→apply→merge round lands the worker change', async () => {
    const test = useRig();
    const lane = await bootLane(test, [
      fauxAssistantMessage(
        [fauxToolCall('spawn_agent', { role: 'tester', task: 'prove it' })],
        { stopReason: 'toolUse' },
      ),
      fauxAssistantMessage('spawned'),
      fauxAssistantMessage(
        [
          fauxToolCall('workspace_diff', { agentId: 'worker-1' }),
          fauxToolCall('workspace_apply', { agentId: 'worker-1' }),
          fauxToolCall('workspace_merge', {}),
        ],
        { stopReason: 'toolUse' },
      ),
      fauxAssistantMessage('merged'),
    ]);
    await runTurn(lane, 'go');
    test.settle('worker-1', completedResult('proved it', ['worker-1.txt']));
    await callTool(lane, 'wait_for_agent', { agentId: 'worker-1' });
    await runTurn(lane, 'merge it');
    // The worker's change landed through the real queue, in FIFO order.
    expect(test.landed).toEqual(['worker-1']);
    expect(test.queue.list()).toEqual([]);
    const diffed = (await callTool(lane, 'workspace_diff', {
      agentId: 'worker-1',
    })) as { content: Array<{ text: string }> };
    expect(JSON.parse(diffed.content[0]?.text ?? '{}')).toEqual({
      agentId: 'worker-1',
      filesChanged: ['worker-1.txt'],
      patch: '--- a/worker-1.txt\n+++ b/worker-1.txt\n@@ -0,0 +1 @@\n+done\n',
    });
  });

  it('inline file contents in a manager tool call are refused', async () => {
    const test = useRig();
    const lane = await bootLane(test, [
      fauxAssistantMessage(
        [fauxToolCall('spawn_agent', { role: 'tester', task: 'prove it' })],
        { stopReason: 'toolUse' },
      ),
      fauxAssistantMessage('spawned'),
    ]);
    await runTurn(lane, 'go');
    test.settle('worker-1');
    await callTool(lane, 'wait_for_agent', { agentId: 'worker-1' });
    await expect(
      callTool(lane, 'workspace_diff', {
        agentId: 'worker-1',
        contents: 'authored',
      }),
    ).rejects.toThrow(/inline authoring/);
    await expect(
      callTool(lane, 'workspace_apply', {
        agentId: 'worker-1',
        content: 'authored',
      }),
    ).rejects.toThrow(/inline authoring/);
    await expect(
      callTool(lane, 'workspace_merge', { contents: 'authored' }),
    ).rejects.toThrow(/inline authoring/);
    expect(test.landed).toEqual([]);
  });

  it('apply on a running worker and merge on an empty or stopped queue refuse by name', async () => {
    const test = useRig();
    const lane = await bootLane(test, [
      fauxAssistantMessage(
        [fauxToolCall('spawn_agent', { role: 'tester', task: 'prove it' })],
        { stopReason: 'toolUse' },
      ),
      fauxAssistantMessage('spawned'),
    ]);
    await runTurn(lane, 'go');
    await expect(
      callTool(lane, 'workspace_apply', { agentId: 'worker-1' }),
    ).rejects.toThrow(/apply_before_settle.*worker-1/);
    await expect(callTool(lane, 'workspace_merge', {})).rejects.toThrow(
      /merge_queue_empty/,
    );
    await expect(
      callTool(lane, 'workspace_diff', { agentId: 'nobody' }),
    ).rejects.toThrow(/unknown_agent.*nobody/);
    test.settle('worker-1');
    await callTool(lane, 'wait_for_agent', { agentId: 'worker-1' });
    await callTool(lane, 'workspace_apply', { agentId: 'worker-1' });
    expect(test.queue.list()).toEqual([
      { agentId: 'worker-1', branch: 'kubic/run-414/worker-1' },
    ]);
    test.queue.markUnresolvable('worker-1', {
      oursDiff: 'ours',
      theirsDiff: 'theirs',
    });
    await expect(callTool(lane, 'workspace_merge', {})).rejects.toThrow(
      /merge_blocked.*worker-1/,
    );
    expect(test.landed).toEqual([]);
  });
});

describe('manager ask_user adapter (issue #417)', () => {
  const tests: Rig[] = [];
  afterEach(async () => {
    for (const test of tests.splice(0)) {
      for (const resolve of test.gates.values()) {
        resolve(completedResult('cleanup', []));
      }
      for (const resolve of test.followUpGates.values()) {
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

  it('a faux manager ask_user round returns the seat answer', async () => {
    const test = useRig();
    test.seatScript.push({ answered: true, text: 'ship the blue one' });
    const lane = await bootLane(test, [
      fauxAssistantMessage(
        [fauxToolCall('ask_user', { question: 'which option ships?' })],
        { stopReason: 'toolUse' },
      ),
      fauxAssistantMessage('shipping blue'),
    ]);
    await runTurn(lane, 'go');
    expect(test.asked).toEqual(['which option ships?']);
    const texts = await toolTexts(lane, 'ask_user');
    expect(texts).toEqual(['ship the blue one']);
  });

  it('an unanswered seat returns a named error, never a hang', async () => {
    const test = useRig();
    const lane = await bootLane(test, [fauxAssistantMessage('nothing to ask')]);
    await runTurn(lane, 'go');
    // Headless shape: the bound elapsed with nobody presenting.
    const unanswered = (await callTool(lane, 'ask_user', {
      question: 'which option ships?',
    })) as { content: Array<{ text: string }>; details?: unknown };
    expect(
      (unanswered.content[0]?.text ?? '').startsWith(
        'error question_unanswered: ',
      ),
    ).toBe(true);
    expect(unanswered.details).toMatchObject({
      ok: false,
      code: 'question_unanswered',
    });
    // A seat that answers late still settles the call (bounded, not hung).
    test.seatScript.push({ answered: true, text: 'late answer' });
    const late = (await callTool(lane, 'ask_user', {
      question: 'still need this?',
    })) as { content: Array<{ text: string }> };
    expect(late.content[0]?.text).toBe('late answer');
    await expect(callTool(lane, 'ask_user', { question: '' })).rejects.toThrow(
      /invalid_args/,
    );
  });
});

describe('manager read-only git adapters (issue #431)', () => {
  const tests: Rig[] = [];
  afterEach(async () => {
    for (const test of tests.splice(0)) {
      for (const resolve of test.gates.values()) {
        resolve(completedResult('cleanup', []));
      }
      for (const resolve of test.followUpGates.values()) {
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

  it('a faux manager git round returns the seam text verbatim', async () => {
    const test = useRig();
    test.gitText.value = 'on branch main, clean';
    const lane = await bootLane(test, [
      fauxAssistantMessage([fauxToolCall('git_status', {})], {
        stopReason: 'toolUse',
      }),
      fauxAssistantMessage('clean tree'),
    ]);
    await runTurn(lane, 'go');
    expect(await toolTexts(lane, 'git_status')).toEqual([
      'on branch main, clean',
    ]);
    expect(test.askedGit).toEqual([{ tool: 'git_status', args: {} }]);
  });

  it('git_diff and git_log pass validated args to the seam', async () => {
    const test = useRig();
    test.gitText.value = 'diff text';
    const lane = await bootLane(test, [fauxAssistantMessage('nothing to ask')]);
    await runTurn(lane, 'go');
    await callTool(lane, 'git_diff', { range: 'HEAD~1' });
    await callTool(lane, 'git_log', { max: 5 });
    expect(test.askedGit).toEqual([
      { tool: 'git_diff', args: { range: 'HEAD~1' } },
      { tool: 'git_log', args: { max: 5 } },
    ]);
  });

  it('a huge git result is bounded with a named marker', async () => {
    const test = useRig();
    test.gitText.value = `start-${'x'.repeat(100_000)}`;
    const lane = await bootLane(test, [fauxAssistantMessage('nothing to ask')]);
    await runTurn(lane, 'go');
    const out = (await callTool(lane, 'git_diff', {})) as {
      content: Array<{ text: string }>;
    };
    const text = out.content[0]?.text ?? '';
    expect(text.length).toBeLessThan(40_000);
    expect(text).toMatch(/truncated/);
    expect(text.startsWith('start-')).toBe(true);
  });

  it('non-ref args never reach the seam', async () => {
    const test = useRig();
    const lane = await bootLane(test, [fauxAssistantMessage('nothing to ask')]);
    await runTurn(lane, 'go');
    await expect(
      callTool(lane, 'git_diff', { range: '-evil' }),
    ).rejects.toThrow(/invalid_args/);
    await expect(callTool(lane, 'git_log', { bogus: 1 })).rejects.toThrow(
      /invalid_args/,
    );
    expect(test.askedGit).toEqual([]);
  });

  it('writer git tools are not in the lane toolset', async () => {
    const test = useRig();
    const lane = await bootLane(test, [fauxAssistantMessage('ok')]);
    const names = lane.registry
      .snapshot()
      .tools()
      .map(({ tool }) => tool.name);
    for (const writer of [
      'git_stage',
      'git_commit',
      'git_branch',
      'git_checkpoint',
      'git_show',
    ]) {
      expect(names).not.toContain(writer);
    }
  });
});

describe('settle seeding for resumes (issue #431)', () => {
  const tests: Rig[] = [];
  afterEach(async () => {
    for (const test of tests.splice(0)) {
      for (const resolve of test.gates.values()) {
        resolve(completedResult('cleanup', []));
      }
      for (const resolve of test.followUpGates.values()) {
        resolve(completedResult('cleanup', []));
      }
      for (const lane of test.lanes.splice(0)) {
        await lane.close(BACKGROUND_CONTEXT);
      }
    }
  });

  it('a seeded settlement reads back without a launch', async () => {
    const test = rig();
    tests.push(test);
    const tools = buildManagerTools(test.deps);
    const seeded = completedResult('seeded work', ['s.txt']);
    tools.settle.seedSettled('worker-9', seeded);
    expect(tools.settle.resultOf('worker-9')).toBe(seeded);
  });

  it('a seeded settlement never overwrites a launched one', async () => {
    const test = rig();
    tests.push(test);
    const tools = buildManagerTools(test.deps);
    const first = completedResult('first', ['f.txt']);
    const second = completedResult('second', ['s.txt']);
    tools.settle.seedSettled('worker-9', first);
    tools.settle.seedSettled('worker-9', second);
    expect(tools.settle.resultOf('worker-9')).toBe(first);
  });
});

describe('unbounded settle waits (issue #431)', () => {
  const tests: Rig[] = [];
  afterEach(async () => {
    for (const test of tests.splice(0)) {
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
  function toolCall(
    lane: ManagerLaneHandle,
    name: string,
    args: Record<string, unknown>,
  ): Promise<unknown> {
    const tools = new Map(
      lane.registry
        .snapshot()
        .tools()
        .map(({ tool }) => [tool.name, tool]),
    );
    const found = tools.get(name);
    if (found === undefined) throw new Error(`no tool '${name}'`);
    return found.execute(
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
  }

  it('an infinite wait holds until the settlement lands (never an instant timeout)', async () => {
    // `setTimeout(Infinity)` overflows to 1ms: pre-fix this wait rejected
    // with `wait_timeout` before the worker could settle (the prod #431
    // transcript showed `exceeded Infinityms`). Post-fix it holds.
    const test = useRig({ waitTimeoutMs: Number.POSITIVE_INFINITY });
    const lane = await bootLane(test, [
      fauxAssistantMessage(
        [fauxToolCall('spawn_agent', { role: 'tester', task: 'prove it' })],
        { stopReason: 'toolUse' },
      ),
      fauxAssistantMessage('spawned'),
    ]);
    await runTurn(lane, 'go');
    await vi.waitFor(() => expect(test.prepared).toEqual(['worker-1']));
    const waited = toolCall(lane, 'wait_for_agent', { agentId: 'worker-1' });
    let finished = false;
    void waited.then(
      () => {
        finished = true;
      },
      () => {
        finished = true;
      },
    );
    // `setTimeout(Infinity)` overflows to 1ms: poll the clock past that
    // window (load-proof — a fixed sleep flakes under L-D26 load) and
    // require the wait to still be pending before settling it.
    const start = Date.now();
    await vi.waitFor(() =>
      expect(Date.now() - start).toBeGreaterThanOrEqual(25),
    );
    expect(finished).toBe(false);
    test.settle('worker-1', completedResult('late work', ['late.txt']));
    await expect(waited).resolves.toBeDefined();
  });

  it('settled worker spend feeds the aggregate gate: the next spawn queues instead of admitting', async () => {
    // The #207 reviewer gap: trackBackground never fed
    // scheduler.updateUsage, so the budget gate only ever saw the run's
    // opening snapshot and the aggregate gate never bound a lane run.
    // Pre-fix the second spawn admits (usage stays empty); post-fix the
    // $5 settlement trips the $1 gate and the spawn queues, timing out
    // on the test's short admission bound.
    const test = useRig({
      budgetGate: { maxCostUsd: 1 },
      waitTimeoutMs: 50,
    });
    const lane = await bootLane(test, [fauxAssistantMessage('ok')]);
    await toolCall(lane, 'spawn_agent', {
      role: 'implementer',
      task: 'spend',
    });
    test.settle(
      'worker-1',
      completedResult('spent', ['spent.txt'], {
        metrics: {
          inputTokens: 0,
          outputTokens: 0,
          cachedTokens: 0,
          toolCalls: 0,
          latencyMs: 1,
          wallMs: 1,
          costUsd: 5,
        },
      }),
    );
    await expect(
      toolCall(lane, 'spawn_agent', { role: 'implementer', task: 'more' }),
    ).rejects.toThrow('spawn_queue_timeout');
  });

  it('a zero wait still times out by name', async () => {
    const test = useRig({ waitTimeoutMs: 0 });
    const lane = await bootLane(test, [
      fauxAssistantMessage(
        [fauxToolCall('spawn_agent', { role: 'tester', task: 'prove it' })],
        { stopReason: 'toolUse' },
      ),
      fauxAssistantMessage('spawned'),
    ]);
    await runTurn(lane, 'go');
    await vi.waitFor(() => expect(test.prepared).toEqual(['worker-1']));
    await expect(
      toolCall(lane, 'wait_for_agent', { agentId: 'worker-1' }),
    ).rejects.toThrow(/wait_timeout/);
  });
});
