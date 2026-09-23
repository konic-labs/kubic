// Slice D end to end: the host approval service gating a real solo lane
// through the worker approve hook (issues #15/#16).

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { FakeExecutionEnv } from '../../exec/src/env.js';
import {
  confinePath,
  defaultIsDestructive,
  isNetworkCommand,
} from '../../worker/src/lane/interceptors.js';
import { bootSoloLane, driveToSettled } from '../../worker/src/lane/solo.js';
import {
  BACKGROUND_CONTEXT,
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
  type HarnessEvent,
  MemorySessionRepo,
  type Session,
} from '../../worker/src/pi-boundary.js';
import {
  ApprovalService,
  createApprovalAsk,
  enableFullAccess,
  FileApprovalStore,
  type TriggerContext,
  validatePolicy,
} from './approvals.js';

function triggerContext(): TriggerContext {
  return {
    workspace: '/fake',
    network: 'none',
    isDestructive: defaultIsDestructive,
    isNetworkCommand,
    isOutsideWorkspace: (path) => confinePath('/fake', path).rewritten,
  };
}

describe('approvals gate the lane (issue #16, slice D)', () => {
  it('denies a destructive call headless, runs it under full-access', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'approvals-lane-'));
    const store = new FileApprovalStore(dir);
    const service = new ApprovalService({
      policy: validatePolicy({ maxPendingMs: 20 }),
      store,
    });
    const ask = createApprovalAsk(service, triggerContext(), store);

    const runOnce = async (): Promise<HarnessEvent[]> => {
      const env = new FakeExecutionEnv({});
      const repo = new MemorySessionRepo();
      const session: Session = await repo.create({}, BACKGROUND_CONTEXT);
      const faux = fauxProvider();
      const models = createModels();
      models.setProvider(faux.provider);
      faux.setResponses([
        fauxAssistantMessage([
          fauxToolCall('bash', { command: 'rm -rf /tmp/x' }),
        ]),
        fauxAssistantMessage('done'),
      ]);
      const booted = await bootSoloLane({
        session,
        models,
        model: faux.getModel(),
        env,
        sessionId: session.metadata.id,
        agentId: 'root',
        policy: { interceptors: { workspace: '/fake', approve: ask } },
      });
      try {
        const ends: HarnessEvent[] = [];
        const off = booted.harness.events.on('tool_end', (event) => {
          ends.push(event);
        });
        try {
          const admission = await booted.lane.accept(
            { kind: 'prompt', prompt: 'clean tmp' },
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
      } finally {
        await session.close(BACKGROUND_CONTEXT);
      }
    };

    const denied = await runOnce();
    expect(denied).toHaveLength(1);
    expect(JSON.stringify(denied[0])).toContain('not approved');

    enableFullAccess(store, 'test');
    const allowed = await runOnce();
    expect(allowed).toHaveLength(1);
    expect(JSON.stringify(allowed[0])).not.toContain('not approved');
    expect(JSON.stringify(allowed[0])).not.toContain(
      'destructive command blocked',
    );
  });
});
