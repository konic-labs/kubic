// Slice B: kill mid-run -> attach -> lane resumes the pending op (#14).
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { FakeExecutionEnv } from '../../../exec/src/env.js';
import { createNodeFileBridge } from '../../../exec/src/file-bridge.js';
import {
  BACKGROUND_CONTEXT,
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  type OperationResultRecord,
  type Session,
} from '../pi-boundary.js';
import { requestLaneAbort } from './abort.js';
import {
  attachSession,
  createSession,
  openSessionStore,
} from './session-store.js';
import { bootSoloLane, driveToSettled } from './solo.js';

const openSessions: Session[] = [];
const scratchDirs: string[] = [];

afterAll(async () => {
  for (const session of openSessions.splice(0)) {
    await session.close(BACKGROUND_CONTEXT);
  }
  for (const dir of scratchDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function scratch(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  scratchDirs.push(dir);
  return dir;
}

describe('session resume (issue #14, slice B)', () => {
  it('resumes a pending op after a simulated kill', async () => {
    const root = scratch('resume-');
    const env = new FakeExecutionEnv({});
    const store = openSessionStore(root, createNodeFileBridge(root));
    const session = await createSession(store, '/work', BACKGROUND_CONTEXT);
    const id = session.metadata.id;

    // First "process": boot, accept an op, then die without driving or closing.
    let pendingOp = '';
    {
      const faux = fauxProvider();
      const models = createModels();
      models.setProvider(faux.provider);
      faux.setResponses([fauxAssistantMessage('unfinished')]);
      const { lane } = await bootSoloLane({
        session,
        models,
        model: faux.getModel(),
        env,
        sessionId: id,
        agentId: 'root',
      });
      const admission = await lane.accept(
        { kind: 'prompt', prompt: 'finish this' },
        BACKGROUND_CONTEXT,
      );
      if (!admission.ok) throw new Error('accept failed');
      pendingOp = admission.value.operationId;
    }

    // Second "process": attach and resume the same operation. The first
    // "process" died holding its session lock (it never closed), so the
    // fixture rewrites lock.json as that crashed holder: a fake pid with
    // liveness stubbed dead (hermetic — no real process is ever signalled;
    // issue #118). A live holder would refuse this attach, correctly.
    writeFileSync(
      join(root, id, 'lock.json'),
      JSON.stringify({ pid: 424242, startedAt: Date.now() }),
    );
    const store2 = openSessionStore(root, createNodeFileBridge(root));
    const kill = vi.spyOn(process, 'kill').mockImplementation((() => {
      throw Object.assign(new Error('kill ESRCH'), { code: 'ESRCH' });
    }) as never);
    const attached = await attachSession(
      store2,
      id,
      BACKGROUND_CONTEXT,
    ).finally(() => kill.mockRestore());
    openSessions.push(attached);
    const faux2 = fauxProvider();
    const models2 = createModels();
    models2.setProvider(faux2.provider);
    faux2.setResponses([fauxAssistantMessage('done')]);
    const resumed = await bootSoloLane({
      session: attached,
      models: models2,
      model: faux2.getModel(),
      env,
      sessionId: id,
      agentId: 'root',
    });
    const driven = await driveToSettled(
      resumed.lane,
      pendingOp,
      BACKGROUND_CONTEXT,
    );
    expect(driven.kind).toBe('settled');
    if (driven.kind === 'settled') {
      const record = driven.outcome as OperationResultRecord;
      expect(record.status).toBe('completed');
    }
    const transcript = JSON.stringify(
      await resumed.lane.findEntries(undefined, BACKGROUND_CONTEXT),
    );
    // The prompt was persisted by the dead process; the reply can only
    // come from the resumed lane driving the pending op to completion.
    expect(transcript).toContain('finish this');
    expect(transcript).toContain('done');
    expect(transcript).not.toContain('unfinished');
  });
});

describe('abort persistence (issue #14, slice E)', () => {
  it('abort settles the op as aborted with kills drained', async () => {
    const root = scratch('abort-');
    const env = new FakeExecutionEnv({});
    const store = openSessionStore(root, createNodeFileBridge(root));
    const session = await createSession(store, '/work', BACKGROUND_CONTEXT);
    openSessions.push(session);
    const faux = fauxProvider();
    const models = createModels();
    models.setProvider(faux.provider);
    faux.setResponses([fauxAssistantMessage('never runs')]);
    const { lane, kills } = await bootSoloLane({
      session,
      models,
      model: faux.getModel(),
      env,
      sessionId: session.metadata.id,
      agentId: 'root',
    });
    const admission = await lane.accept(
      { kind: 'prompt', prompt: 'doomed work' },
      BACKGROUND_CONTEXT,
    );
    if (!admission.ok) throw new Error('accept failed');
    const operationId = admission.value.operationId;
    let drained = 0;
    kills.track(operationId, () => {
      drained += 1;
    });
    const aborted = await requestLaneAbort(
      lane,
      kills,
      operationId,
      BACKGROUND_CONTEXT,
    );
    expect(aborted.newlyRequested).toBe(true);
    expect(aborted.killed).toBe(1);
    expect(drained).toBe(1);
    const driven = await driveToSettled(lane, operationId, BACKGROUND_CONTEXT);
    expect(driven.kind).toBe('settled');
    if (driven.kind === 'settled') {
      const record = driven.outcome as OperationResultRecord;
      expect(record.status).toBe('aborted');
    }
    expect(
      JSON.stringify(await lane.findEntries(undefined, BACKGROUND_CONTEXT)),
    ).not.toContain('never runs');
  });
});
