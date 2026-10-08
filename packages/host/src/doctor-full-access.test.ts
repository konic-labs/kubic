// Doctor's full-access session enumeration: the current
// workspace's LIVE sessions whose posture.json records fullAccess — the
// report `kubic doctor` warns with. Real session dirs in a temp store
// (createSession takes a real lock, so a created session is live until
// released); posture through the prod FileApprovalStore. Faux only: no
// network, no paid tokens.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createSession,
  openSessionStore,
  type SessionHandle,
} from '../../agent/src/lane/session-store.js';
import { BACKGROUND_CONTEXT } from '../../agent/src/pi-boundary.js';
import { createNodeFileBridge } from '../../exec/src/file-bridge.js';
import { FileApprovalStore } from './approvals.js';
import {
  describeFullAccessSession,
  listFullAccessSessions,
} from './doctor-full-access.js';

const roots: string[] = [];
const handles: SessionHandle[] = [];

function tempRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), 'kubic-doctor-full-access-'));
  roots.push(dir);
  return dir;
}

afterEach(async () => {
  for (const handle of handles.splice(0)) {
    try {
      await handle.release(BACKGROUND_CONTEXT);
    } catch {
      // A released-twice handle is not a test failure.
    }
  }
  for (const dir of roots.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

async function create(
  root: string,
  id: string,
  cwd: string,
): Promise<SessionHandle> {
  const store = openSessionStore(root, createNodeFileBridge(root));
  const handle = await createSession(store, { id, cwd }, BACKGROUND_CONTEXT);
  handles.push(handle);
  return handle;
}

function grantFullAccess(root: string, id: string, by = 'tester'): void {
  new FileApprovalStore(join(root, id)).savePosture({
    fullAccess: true,
    enabledAt: 1700000000000,
    enabledBy: by,
  });
}

describe('listFullAccessSessions', () => {
  it('lists a live full-access session with its provenance', async () => {
    const root = tempRoot();
    const workspace = join(root, 'repo');
    await create(root, 'live-full', workspace);
    grantFullAccess(root, 'live-full');
    const sessions = await listFullAccessSessions({
      sessionsRoot: root,
      workspace,
    });
    expect(sessions).toEqual([
      {
        sessionId: 'live-full',
        enabledAt: 1700000000000,
        enabledBy: 'tester',
      },
    ]);
  });

  it('skips a released session even with a full-access posture on disk', async () => {
    const root = tempRoot();
    const workspace = join(root, 'repo');
    const handle = await create(root, 'ended-full', workspace);
    grantFullAccess(root, 'ended-full');
    // Session end drops the lock (the grant expired with it); the posture
    // file outlives the session but doctor must not warn about the dead.
    await handle.release(BACKGROUND_CONTEXT);
    const sessions = await listFullAccessSessions({
      sessionsRoot: root,
      workspace,
    });
    expect(sessions).toEqual([]);
  });

  it('skips live sessions that never left enforcement', async () => {
    const root = tempRoot();
    const workspace = join(root, 'repo');
    await create(root, 'enforced', workspace);
    const sessions = await listFullAccessSessions({
      sessionsRoot: root,
      workspace,
    });
    expect(sessions).toEqual([]);
  });

  it('skips live full-access sessions of another workspace', async () => {
    const root = tempRoot();
    await create(root, 'other-ws', join(root, 'elsewhere'));
    grantFullAccess(root, 'other-ws');
    const sessions = await listFullAccessSessions({
      sessionsRoot: root,
      workspace: join(root, 'repo'),
    });
    expect(sessions).toEqual([]);
  });

  it('reads one named session without the workspace filter', async () => {
    const root = tempRoot();
    await create(root, 'named', join(root, 'elsewhere'));
    grantFullAccess(root, 'named');
    // The workspace enumeration skips it (other workspace)…
    expect(
      await listFullAccessSessions({
        sessionsRoot: root,
        workspace: join(root, 'repo'),
      }),
    ).toEqual([]);
    // …but the named read (`doctor --session`) reports it.
    expect(await describeFullAccessSession(root, 'named')).toEqual({
      sessionId: 'named',
      enabledAt: 1700000000000,
      enabledBy: 'tester',
    });
    // Released, enforced and missing sessions read undefined.
    expect(await describeFullAccessSession(root, 'nope')).toBeUndefined();
  });

  it('treats a corrupt posture file as enforced, never a crash', async () => {
    const root = tempRoot();
    const workspace = join(root, 'repo');
    await create(root, 'corrupt', workspace);
    const bridge = createNodeFileBridge('/');
    bridge.writeFile(join(root, 'corrupt', 'posture.json'), 'not json{');
    const sessions = await listFullAccessSessions({
      sessionsRoot: root,
      workspace,
    });
    expect(sessions).toEqual([]);
  });

  it('reports nothing on an empty store', async () => {
    const sessions = await listFullAccessSessions({
      sessionsRoot: tempRoot(),
      workspace: join('nowhere'),
    });
    expect(sessions).toEqual([]);
  });
});
