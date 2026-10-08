// The SessionHandle seam on the solo boot: the lane
// hands the handle's storage to the Harness through `adopt()`, so the handle
// records that a harness owns it and its `release()` gives the lock back
// without closing a storage a live harness is using.
import { describe, expect, it } from 'vitest';
import { FakeExecutionEnv } from '../../../exec/src/env.js';
import {
  BACKGROUND_CONTEXT,
  type Context,
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  MemoryStorage,
  type Storage,
} from '../pi-boundary.js';
import type { SessionHandle } from './session-store.js';
import { bootLane, type Lane } from './solo.js';

// The shipped handle's own contract, reduced to what this file observes:
// `adopt()` marks the storage as the harness's, and `release()` closes the
// storage only while nobody adopted it. A closed MemoryStorage rejects every
// operation, so "still usable" is the observable half of "not closed".
function trackableHandle(id: string): {
  handle: SessionHandle;
  adopted: () => boolean;
  closed: () => boolean;
} {
  const storage = new MemoryStorage();
  let adopted = false;
  let closed = false;
  const handle: SessionHandle = {
    id,
    dir: `/tmp/kubic-solo-adopt/${id}`,
    get storage(): Storage {
      return storage;
    },
    meta: { cwd: '/ws', createdAt: new Date(0).toISOString() },
    adopt: () => {
      adopted = true;
      return storage;
    },
    release: async (context: Context): Promise<void> => {
      if (!adopted) {
        closed = true;
        await storage.close(context);
      }
    },
  };
  return { handle, adopted: () => adopted, closed: () => closed };
}

async function boot(handle: SessionHandle): Promise<Lane> {
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  faux.setResponses([fauxAssistantMessage('booted')]);
  return bootLane({
    session: handle,
    models,
    model: faux.getModel(),
    env: new FakeExecutionEnv({}),
    sessionId: handle.id,
    agentId: 'root',
  });
}

describe('solo boot adopts the session storage', () => {
  it('adopts the handle and keeps the storage usable after release', async () => {
    const tracked = trackableHandle('sess-adopt');
    const solo = await boot(tracked.handle);
    try {
      expect(tracked.adopted()).toBe(true);
      // The caller's release path: the lock goes back, the storage stays
      // open for the harness that owns it.
      await tracked.handle.release(BACKGROUND_CONTEXT);
      expect(tracked.closed()).toBe(false);
      // Still usable: a read on the live harness does not throw `closed`.
      const page = await solo.conversation.entries(
        {},
        1,
        undefined,
        BACKGROUND_CONTEXT,
      );
      expect(Array.isArray(page.items)).toBe(true);
    } finally {
      await solo.close(BACKGROUND_CONTEXT);
    }
  });

  it('releases the storage when no harness ever booted (control)', async () => {
    const tracked = trackableHandle('sess-unbooted');
    await tracked.handle.release(BACKGROUND_CONTEXT);
    expect(tracked.adopted()).toBe(false);
    expect(tracked.closed()).toBe(true);
  });
});
