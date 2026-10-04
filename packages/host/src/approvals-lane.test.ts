// Slice D end to end: the host approval service gating a real solo lane
// through the worker approve hook (issues #15/#16). The lane boots through
// the shared faux harness factory (#401); its tool-end events come from the
// durable watch (#398) exactly as `kubic run`/`tui` consume them.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type {
  KubicLaneEvent,
  LaneEventSink,
} from '../../worker/src/lane/events.js';
import {
  confinePath,
  defaultIsDestructive,
  isNetworkCommand,
} from '../../worker/src/lane/interceptors.js';
import {
  bootFauxLane,
  fauxToolUse,
} from '../../worker/src/lane/test-harness.js';
import {
  fauxAssistantMessage,
  fauxToolCall,
} from '../../worker/src/pi-boundary.js';
import {
  ApprovalService,
  createApprovalAsk,
  enableFullAccess,
  FileApprovalStore,
  type TriggerContext,
  validatePolicy,
} from './approvals.js';

const made: string[] = [];

function mkTmp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  made.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of made.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

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
    const dir = mkTmp('approvals-lane-');
    const store = new FileApprovalStore(dir);
    const service = new ApprovalService({
      policy: validatePolicy({ maxPendingMs: 20 }),
      store,
    });
    let ask = createApprovalAsk(service, triggerContext(), store);

    const runOnce = async (): Promise<KubicLaneEvent[]> => {
      const lane = await bootFauxLane({
        policy: { interceptors: { workspace: '/fake', approve: ask } },
        responses: [
          fauxToolUse([fauxToolCall('bash', { command: 'rm -rf /tmp/x' })]),
          fauxAssistantMessage('done'),
        ],
      });
      try {
        const ends: KubicLaneEvent[] = [];
        const sink: LaneEventSink = (event) => {
          if (event.type === 'tool-end') ends.push(event);
        };
        const stop = await lane.subscribe(sink);
        try {
          await lane.run('clean tmp');
        } finally {
          await stop();
        }
        return ends;
      } finally {
        await lane.cleanup();
      }
    };

    const denied = await runOnce();
    expect(denied).toHaveLength(1);
    expect(JSON.stringify(denied[0])).toContain('not approved');

    enableFullAccess(store, 'test');
    // Issue #325: the posture is read once at boot, so full access applies
    // to the NEXT boot of the ask, never mid-session.
    ask = createApprovalAsk(service, triggerContext(), store);
    const allowed = await runOnce();
    expect(allowed).toHaveLength(1);
    expect(JSON.stringify(allowed[0])).not.toContain('not approved');
    expect(JSON.stringify(allowed[0])).not.toContain(
      'destructive command blocked',
    );
  });
});
