// Pending operations on re-attach (issue #147; §21). A process that dies
// mid-turn leaves the lane's operation open in the durable session; these
// tests pin that bootSoloLane surfaces it and that settling it (resume or
// durable abort) frees the lane for the next prompt — and that a
// never-replay tool the dead process was running is not executed again.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  type ExecutionEnv,
  FakeExecutionEnv,
  type ProcessHandle,
} from '../../../exec/src/env.js';
import { createNodeFileBridge } from '../../../exec/src/file-bridge.js';
import {
  BACKGROUND_CONTEXT,
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
  type Session,
} from '../pi-boundary.js';
import { OperationKillRegistry } from './abort.js';
import {
  describePendingOperation,
  describeSettlement,
  inspectOpenOperations,
  lastUserPromptText,
  settlePendingOperation,
} from './pending.js';
import {
  attachSession,
  createSession,
  openSessionStore,
} from './session-store.js';
import { bootSoloLane, type SoloLane } from './solo.js';

const dirs: string[] = [];
const sessions: Session[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  for (const session of sessions.splice(0)) {
    await session.close(BACKGROUND_CONTEXT).catch(() => undefined);
  }
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), 'kubic-pending-'));
  dirs.push(dir);
  return dir;
}

async function boot(
  session: Session,
  replies: ReturnType<typeof fauxAssistantMessage>[],
  env: ExecutionEnv = new FakeExecutionEnv({}),
): Promise<SoloLane> {
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  faux.setResponses(replies);
  return bootSoloLane({
    session,
    models,
    model: faux.getModel(),
    env,
    sessionId: session.metadata.id,
    agentId: 'root',
  });
}

// First "process": accept a prompt and die without driving or closing. The
// dead holder's lock is rewritten as a crashed pid (liveness stubbed dead in
// reattach) — hermetic, no real process is signalled.
async function crashAfterAccept(
  root: string,
  prompt: string,
): Promise<{ id: string; operationId: string }> {
  const store = openSessionStore(root, createNodeFileBridge(root));
  const session = await createSession(store, '/work', BACKGROUND_CONTEXT);
  const solo = await boot(session, [fauxAssistantMessage('never')]);
  const admission = await solo.lane.accept(
    { kind: 'prompt', prompt },
    BACKGROUND_CONTEXT,
  );
  if (!admission.ok) throw new Error('accept failed');
  writeFileSync(
    join(root, session.metadata.id, 'lock.json'),
    JSON.stringify({ pid: 424242, startedAt: Date.now() }),
  );
  return {
    id: session.metadata.id,
    operationId: admission.value.operationId,
  };
}

async function reattach(root: string, id: string): Promise<Session> {
  const store = openSessionStore(root, createNodeFileBridge(root));
  const kill = vi.spyOn(process, 'kill').mockImplementation((() => {
    throw Object.assign(new Error('kill ESRCH'), { code: 'ESRCH' });
  }) as never);
  try {
    const session = await attachSession(store, id, BACKGROUND_CONTEXT);
    sessions.push(session);
    return session;
  } finally {
    kill.mockRestore();
  }
}

describe('pending operations on re-attach (issue #147)', () => {
  it('bootSoloLane surfaces the operation a dead process left open', async () => {
    const root = scratch();
    const { id, operationId } = await crashAfterAccept(root, 'first task');
    const solo = await boot(await reattach(root, id), []);
    expect(solo.open).toEqual([
      expect.objectContaining({ operationId, kind: 'run', lane: 'main' }),
    ]);
    // Unsettled, the lane refuses a new prompt — the defect this fixes.
    const refused = await solo.lane.accept(
      { kind: 'prompt', prompt: 'second' },
      BACKGROUND_CONTEXT,
    );
    expect(refused.ok).toBe(false);
  });

  it('resume drives the pending op to completion and frees the lane', async () => {
    const root = scratch();
    const { id, operationId } = await crashAfterAccept(root, 'first task');
    const solo = await boot(await reattach(root, id), [
      fauxAssistantMessage('resumed reply'),
      fauxAssistantMessage('second reply'),
    ]);
    const [op] = solo.open ?? [];
    if (op === undefined) throw new Error('no open op');
    const settled = await settlePendingOperation(
      solo,
      op,
      'resume',
      BACKGROUND_CONTEXT,
    );
    expect(settled).toMatchObject({
      operationId,
      kind: 'run',
      action: 'resumed',
      status: 'completed',
    });
    expect(describeSettlement(settled)).toContain(
      `pending operation ${operationId} (run, started `,
    );
    expect(describeSettlement(settled)).toContain('resumed');
    const next = await solo.lane.accept(
      { kind: 'prompt', prompt: 'second' },
      BACKGROUND_CONTEXT,
    );
    expect(next.ok).toBe(true);
    const text = JSON.stringify(
      await solo.lane.findEntries(undefined, BACKGROUND_CONTEXT),
    );
    expect(text).toContain('resumed reply');
  });

  it('abort policy settles the pending op as aborted without a model call', async () => {
    const root = scratch();
    const { id } = await crashAfterAccept(root, 'first task');
    const solo = await boot(await reattach(root, id), [
      fauxAssistantMessage('must not run'),
    ]);
    const [op] = solo.open ?? [];
    if (op === undefined) throw new Error('no open op');
    const settled = await settlePendingOperation(
      solo,
      op,
      'abort',
      BACKGROUND_CONTEXT,
    );
    expect(settled).toMatchObject({ action: 'aborted', status: 'aborted' });
    expect(settled.reason).toBeUndefined();
    expect(describeSettlement(settled)).toMatch(
      /aborted after an interrupted run$/,
    );
    expect(
      JSON.stringify(
        await solo.lane.findEntries(undefined, BACKGROUND_CONTEXT),
      ),
    ).not.toContain('must not run');
  });

  it('a resume whose driver throws falls back to the durable abort, naming why', async () => {
    const root = scratch();
    const { id } = await crashAfterAccept(root, 'first task');
    const solo = await boot(await reattach(root, id), []);
    const [op] = solo.open ?? [];
    if (op === undefined) throw new Error('no open op');
    const settled = await settlePendingOperation(
      solo,
      op,
      'resume',
      BACKGROUND_CONTEXT,
      async () => {
        throw new Error('turn budget exhausted after 1 turns');
      },
    );
    expect(settled).toMatchObject({
      action: 'aborted',
      status: 'aborted',
      reason: 'turn budget exhausted after 1 turns',
    });
    expect(describeSettlement(settled)).toContain(
      'resume could not settle: turn budget exhausted after 1 turns',
    );
    const next = await solo.lane.accept(
      { kind: 'prompt', prompt: 'after' },
      BACKGROUND_CONTEXT,
    );
    expect(next.ok).toBe(true);
  });

  it('a resume that suspends on a deferred approval is aborted', async () => {
    const root = scratch();
    const { id } = await crashAfterAccept(root, 'first task');
    const solo = await boot(await reattach(root, id), []);
    const [op] = solo.open ?? [];
    if (op === undefined) throw new Error('no open op');
    const settled = await settlePendingOperation(
      solo,
      op,
      'resume',
      BACKGROUND_CONTEXT,
      async (operationId) => ({
        kind: 'waiting-deferred',
        operationId,
        deferred: {} as never,
      }),
    );
    expect(settled).toMatchObject({
      action: 'aborted',
      reason: 'suspended waiting on an approval',
    });
  });

  it('inspectOpenOperations reports the open op without acquiring the lane', async () => {
    const root = scratch();
    const { id, operationId } = await crashAfterAccept(root, 'first task');
    const session = await reattach(root, id);
    const open = await inspectOpenOperations(session, BACKGROUND_CONTEXT);
    expect(open).toHaveLength(1);
    const [op] = open;
    if (op === undefined) throw new Error('no open op');
    expect(op.operationId).toBe(operationId);
    expect(describePendingOperation(op)).toBe(
      `pending operation: ${operationId} (run, started ${new Date(op.startedAt).toISOString()})`,
    );
    expect(describePendingOperation({ ...op, aborting: true })).toContain(
      ', abort requested)',
    );
    // The probe does not consume it: a real boot still sees it open.
    const solo = await boot(session, []);
    expect(solo.open?.map((o) => o.operationId)).toEqual([operationId]);
  });

  it('lastUserPromptText reads the newest user prompt', async () => {
    expect(lastUserPromptText([])).toBeUndefined();
    expect(
      lastUserPromptText([
        { type: 'message', message: { role: 'user', content: 'old' } },
        {
          type: 'message',
          message: {
            role: 'user',
            content: [
              { type: 'text', text: 'new ' },
              { type: 'image' },
              { type: 'text', text: 'prompt' },
            ],
          },
        },
        { type: 'message', message: { role: 'assistant', content: 'x' } },
        { type: 'custom' },
      ]),
    ).toBe('new prompt');
    expect(
      lastUserPromptText([
        { type: 'message', message: { role: 'user', content: 7 } },
      ]),
    ).toBeUndefined();
  });

  it('a never-replay tool the dead process was running is not executed again on resume', async () => {
    const root = scratch();
    const store = openSessionStore(root, createNodeFileBridge(root));
    const session = await createSession(store, '/work', BACKGROUND_CONTEXT);
    const id = session.metadata.id;
    let spawns = 0;
    // First process: the bash call spawns, then the process "dies" while
    // the command is still running (wait never settles).
    const hanging = new FakeExecutionEnv({});
    const hangingEnv: ExecutionEnv = {
      cwd: hanging.cwd,
      fs: hanging.fs,
      provenance: hanging.provenance,
      withProvenance: () => hangingEnv,
      shell: {
        spawn: (): ProcessHandle => {
          spawns += 1;
          return {
            pid: undefined,
            wait: () => new Promise(() => undefined),
            kill: () => undefined,
          };
        },
      },
    };
    const first = await boot(
      session,
      [
        fauxAssistantMessage([
          fauxToolCall('bash', { command: 'echo side-effect >> log' }),
        ]),
      ],
      hangingEnv,
    );
    const admission = await first.lane.accept(
      { kind: 'prompt', prompt: 'run the effect' },
      BACKGROUND_CONTEXT,
    );
    if (!admission.ok) throw new Error('accept failed');
    void first.lane.drive(
      { operationId: admission.value.operationId },
      BACKGROUND_CONTEXT,
    );
    await vi.waitFor(() => expect(spawns).toBe(1));
    writeFileSync(
      join(root, id, 'lock.json'),
      JSON.stringify({ pid: 424242, startedAt: Date.now() }),
    );
    // Second process: resume. The effect must not run again.
    const counting = new FakeExecutionEnv({});
    const countingEnv: ExecutionEnv = {
      cwd: counting.cwd,
      fs: counting.fs,
      provenance: counting.provenance,
      withProvenance: () => countingEnv,
      shell: {
        spawn: (cmd, args, options) => {
          spawns += 1;
          return counting.shell.spawn(cmd, args, options);
        },
      },
    };
    const solo = await boot(
      await reattach(root, id),
      [fauxAssistantMessage('done after interruption')],
      countingEnv,
    );
    const [op] = solo.open ?? [];
    if (op === undefined) throw new Error('no open op');
    const settled = await settlePendingOperation(
      solo,
      op,
      'resume',
      BACKGROUND_CONTEXT,
    );
    expect(settled).toMatchObject({ action: 'resumed', status: 'completed' });
    expect(spawns).toBe(1);
  });

  describe('with a stub lane', () => {
    function stubLane(outcome: unknown) {
      const calls: string[] = [];
      const lane = {
        drive: async (options: { operationId: string }) => {
          calls.push(`drive:${options.operationId}`);
          return {
            ok: true as const,
            value: { kind: 'settled' as const, outcome },
          };
        },
        requestAbort: async (operationId: string) => {
          calls.push(`abort:${operationId}`);
          return {
            ok: true as const,
            value: { operationId, newlyRequested: true },
          };
        },
      };
      return {
        calls,
        solo: { lane: lane as never, kills: new OperationKillRegistry() },
      };
    }
    const op = {
      lane: 'main',
      operationId: 'op-1',
      kind: 'run' as const,
      startedAt: 0,
    };

    it('an abort the dead process already requested is not requested twice', async () => {
      const { calls, solo } = stubLane({ status: 'aborted' });
      const settled = await settlePendingOperation(
        solo,
        { ...op, aborting: true },
        'resume',
        BACKGROUND_CONTEXT,
      );
      expect(settled).toMatchObject({ action: 'aborted', status: 'aborted' });
      expect(settled.reason).toBeUndefined();
      expect(calls).toEqual(['drive:op-1']);
    });

    it('the abort policy requests the abort before driving', async () => {
      const { calls, solo } = stubLane({ status: 'aborted' });
      await settlePendingOperation(solo, op, 'abort', BACKGROUND_CONTEXT);
      expect(calls).toEqual(['abort:op-1', 'drive:op-1']);
    });

    it('reports a settlement with no status as settled', async () => {
      const { solo } = stubLane(null);
      const settled = await settlePendingOperation(
        solo,
        op,
        'resume',
        BACKGROUND_CONTEXT,
      );
      expect(settled).toMatchObject({ action: 'resumed', status: 'settled' });
      const numeric = stubLane({ status: 7 });
      expect(
        (
          await settlePendingOperation(
            numeric.solo,
            op,
            'resume',
            BACKGROUND_CONTEXT,
          )
        ).status,
      ).toBe('settled');
    });

    it('a non-Error driver throw is named verbatim', async () => {
      const { solo } = stubLane({ status: 'aborted' });
      const settled = await settlePendingOperation(
        solo,
        op,
        'resume',
        BACKGROUND_CONTEXT,
        async () => {
          throw 'plain refusal';
        },
      );
      expect(settled.reason).toBe('plain refusal');
    });
  });

  it('lastUserPromptText skips non-user and malformed entries', () => {
    expect(
      lastUserPromptText([
        { type: 'message', message: { role: 'user', content: 'wanted' } },
        null,
        { type: 'custom', message: { role: 'user', content: 'custom' } },
        { type: 'message', message: { role: 'assistant', content: 'reply' } },
        { type: 'message' },
      ]),
    ).toBe('wanted');
    expect(
      lastUserPromptText([
        { type: 'message', message: { role: 'user', content: 'older' } },
        {
          type: 'message',
          message: {
            role: 'user',
            content: [
              null,
              { type: 'image', text: 'not text' },
              { type: 'text', text: 3 },
              { type: 'text', text: 'only this' },
            ],
          },
        },
      ]),
    ).toBe('only this');
  });
});
