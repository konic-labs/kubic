// Slice B: kill mid-run -> attach -> lane resumes the pending op (#14).
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { FakeExecutionEnv } from '../../../exec/src/env.js';
import { createNodeFileBridge } from '../../../exec/src/file-bridge.js';
import {
  BACKGROUND_CONTEXT,
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  type Session,
} from '../pi-boundary.js';
import {
  attachSession,
  createSession,
  openSessionStore,
} from './session-store.js';
import { bootSoloLane, driveToSettled } from './solo.js';

const openSessions: Session[] = [];

afterAll(async () => {
  for (const session of openSessions.splice(0)) {
    await session.close(BACKGROUND_CONTEXT);
  }
});

describe('session resume (issue #14, slice B)', () => {
  it('resumes a pending op after a simulated kill', async () => {
    const root = mkdtempSync(join(tmpdir(), 'resume-'));
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

    // Second "process": attach and resume the same operation.
    const store2 = openSessionStore(root, createNodeFileBridge(root));
    const attached = await attachSession(store2, id, BACKGROUND_CONTEXT);
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
    const entries = await resumed.lane.findEntries(
      undefined,
      BACKGROUND_CONTEXT,
    );
    expect(JSON.stringify(entries)).toContain('finish this');
  });
});
