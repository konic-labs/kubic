// Slice C: before_tool interceptors on the solo lane (issue #15).
import { afterAll, describe, expect, it } from 'vitest';
import { FakeExecutionEnv } from '../../../exec/src/env.js';
import {
  type AgentLane,
  BACKGROUND_CONTEXT,
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
  type HarnessEvent,
  MemorySessionRepo,
  type Session,
} from '../pi-boundary.js';
import {
  confinePath,
  defaultIsDestructive,
  registerPolicyInterceptors,
} from './interceptors.js';
import { bootSoloLane, driveToSettled } from './solo.js';

const sessions: Session[] = [];
afterAll(async () => {
  for (const session of sessions.splice(0)) {
    await session.close(BACKGROUND_CONTEXT);
  }
});

interface Booted {
  harness: {
    events: {
      on: (
        type: 'tool_end',
        listener: (event: HarnessEvent) => void,
      ) => () => void;
    };
    hooks: Parameters<typeof registerPolicyInterceptors>[0];
  };
  lane: AgentLane;
}

async function boot(
  calls: Array<{ name: string; args: Record<string, unknown> }>,
): Promise<Booted> {
  const env = new FakeExecutionEnv({});
  env.fs.writeFile('notes.txt', 'workspace notes\n');
  const repo = new MemorySessionRepo();
  const session = await repo.create({}, BACKGROUND_CONTEXT);
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  faux.setResponses([
    fauxAssistantMessage(
      calls.map((call) => fauxToolCall(call.name, call.args)),
    ),
    fauxAssistantMessage('done'),
  ]);
  const booted = await bootSoloLane({
    session,
    models,
    model: faux.getModel(),
    env,
    sessionId: session.metadata.id,
    agentId: 'root',
  });
  sessions.push(session);
  return booted as unknown as Booted;
}

async function driveToolEnds(booted: Booted): Promise<HarnessEvent[]> {
  const ends: HarnessEvent[] = [];
  const off = booted.harness.events.on('tool_end', (event) => {
    ends.push(event);
  });
  try {
    const admission = await booted.lane.accept(
      { kind: 'prompt', prompt: 'run the tools' },
      BACKGROUND_CONTEXT,
    );
    if (!admission.ok) throw new Error('accept failed');
    await driveToSettled(
      booted.lane,
      admission.value.operationId,
      BACKGROUND_CONTEXT,
    );
  } finally {
    off();
  }
  return ends;
}

describe('policy interceptors (issue #15, slice C)', () => {
  it('blocks destructive bash with a reason and terminate:false', async () => {
    const booted = await boot([
      { name: 'bash', args: { command: 'rm -rf /tmp/x' } },
    ]);
    registerPolicyInterceptors(booted.harness.hooks, { workspace: '/work' });
    const ends = await driveToolEnds(booted);
    expect(ends).toHaveLength(1);
    const end = ends[0];
    expect(end.type).toBe('tool_end');
    if (end.type !== 'tool_end') throw new Error('unreachable');
    expect(end.isError).toBe(true);
    expect(end.terminate).toBe(false);
    expect(JSON.stringify(end.result)).toContain('destructive command blocked');
  });

  it('confines reads outside the workspace, chained across two interceptors', async () => {
    const booted = await boot([
      { name: 'read', args: { path: '/etc/passwd' } },
    ]);
    registerPolicyInterceptors(booted.harness.hooks, { workspace: '/work' });
    const seenBySecond: Array<Record<string, unknown>> = [];
    booted.harness.hooks.on('before_tool', (event) => {
      seenBySecond.push({ ...(event.args as Record<string, unknown>) });
      return undefined;
    });
    const ends = await driveToolEnds(booted);
    expect(ends).toHaveLength(1);
    // The second interceptor saw the confined args (chaining), and the tool ran confined.
    expect(seenBySecond).toHaveLength(1);
    expect(seenBySecond[0]?.['path']).toBe('/work/etc/passwd');
    const end = ends[0];
    if (end.type !== 'tool_end') throw new Error('unreachable');
    expect(JSON.stringify(end.result)).toContain('/work/etc/passwd');
  });

  it('fails closed when a policy handler throws', async () => {
    const booted = await boot([{ name: 'ls', args: { path: '.' } }]);
    registerPolicyInterceptors(booted.harness.hooks, { workspace: '/work' });
    booted.harness.hooks.on('before_tool', () => {
      throw new Error('policy exploded');
    });
    const ends = await driveToolEnds(booted);
    expect(ends).toHaveLength(1);
    const end = ends[0];
    if (end.type !== 'tool_end') throw new Error('unreachable');
    expect(end.isError).toBe(true);
    expect(JSON.stringify(end.result)).toContain('policy exploded');
  });

  it('blocks past maxToolCalls and emits the trigger once', async () => {
    const booted = await boot([
      { name: 'ls', args: { path: '.' } },
      { name: 'ls', args: { path: '.' } },
    ]);
    const triggers: Array<{ kind: string; count: number }> = [];
    registerPolicyInterceptors(booted.harness.hooks, {
      workspace: '/work',
      maxToolCalls: 1,
      onTrigger: (trigger) => {
        triggers.push(trigger);
      },
    });
    const ends = await driveToolEnds(booted);
    expect(ends).toHaveLength(2);
    const blocked = ends.find((end) =>
      JSON.stringify(end).includes('maxToolCalls (1) exceeded'),
    );
    if (blocked?.type !== 'tool_end')
      throw new Error('no blocked call observed');
    expect(blocked.isError).toBe(true);
    expect(triggers).toEqual([
      { kind: 'max_tool_calls', toolName: 'ls', count: 2 },
    ]);
  });

  it('matches destructive commands and confines paths at unit level', () => {
    expect(defaultIsDestructive('rm -rf /tmp/x')).toBe(true);
    expect(defaultIsDestructive('rm -Rf --no-preserve-root /')).toBe(true);
    expect(defaultIsDestructive('echo hello')).toBe(false);
    expect(defaultIsDestructive('ls -la')).toBe(false);
    expect(confinePath('/work', '/etc/passwd')).toEqual({
      confined: '/work/etc/passwd',
      rewritten: true,
    });
    expect(confinePath('/work', 'notes.txt')).toEqual({
      confined: '/work/notes.txt',
      rewritten: false,
    });
    expect(confinePath('/work', '/work/sub/f.txt')).toEqual({
      confined: '/work/sub/f.txt',
      rewritten: false,
    });
  });
});
