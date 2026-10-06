// Session ancestry on the orchestrate path (issue #164; §22–§23).
//
// The production `createWorkerSession` records the run tree in the session
// store: each worker session's metadata names the orchestrate session as its
// parent (plus the role/agent it spawned as), and the run itself gets a
// manager session record as the tree root. Real JSONL sessions in a scratch
// root — no child process, no model, no network.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createNodeFileBridge } from '../../../packages/exec/src/file-bridge.js';
import {
  listSessions,
  openSessionStore,
} from '../../../packages/worker/src/lane/session-store.js';
import { BACKGROUND_CONTEXT } from '../../../packages/worker/src/pi-boundary.js';
import { orchestrateDepsWithDefaults } from './orchestrate-run.js';

const made: string[] = [];

function scratch(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  made.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of made.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

async function linked(dir: string) {
  const store = openSessionStore(
    join(dir, 'sessions'),
    createNodeFileBridge(join(dir, 'sessions')),
  );
  const entries = await listSessions(store, BACKGROUND_CONTEXT);
  return new Map(entries.map((entry) => [entry.id, entry.meta]));
}

describe('orchestrate session ancestry (issue #164)', () => {
  it('creates the worker session with parent linkage and registers the manager session', async () => {
    const dir = scratch('ancestry-');
    const deps = await orchestrateDepsWithDefaults({
      out: () => undefined,
      err: () => undefined,
      cwd: dir,
      sessionsRoot: join(dir, 'sessions'),
    });
    const created = await deps.createWorkerSession({
      sessionId: 'orch-1',
      agentId: 'aaa',
      workerSessionId: 'orch-1-aaa',
      worktree: { path: dir, branch: 'worker-aaa' },
      role: 'implementer',
      // Issue #278 (§19): the run's mode travels to both records.
      mode: 'autonomous',
    });
    expect(created).toEqual({ sessionId: 'orch-1-aaa' });

    const sessions = await linked(dir);
    // The manager record: the tree root, parent of nothing.
    expect(sessions.get('orch-1')?.parentSessionId).toBeUndefined();
    expect(sessions.get('orch-1')?.mode).toBe('autonomous');
    // The worker: parented to the run, spawned as implementer/aaa.
    expect(sessions.get('orch-1-aaa')).toMatchObject({
      parentSessionId: 'orch-1',
      role: 'implementer',
      agentId: 'aaa',
      mode: 'autonomous',
    });
  });

  it('reuses the run tree on a second worker (one manager record, two children)', async () => {
    const dir = scratch('ancestry-');
    const deps = await orchestrateDepsWithDefaults({
      out: () => undefined,
      err: () => undefined,
      cwd: dir,
      sessionsRoot: join(dir, 'sessions'),
    });
    for (const agent of ['aaa', 'bbb']) {
      await deps.createWorkerSession({
        sessionId: 'orch-1',
        agentId: agent,
        workerSessionId: `orch-1-${agent}`,
        worktree: { path: dir, branch: `worker-${agent}` },
        mode: 'interactive',
      });
    }
    const sessions = await linked(dir);
    expect(sessions.get('orch-1')?.parentSessionId).toBeUndefined();
    expect(sessions.get('orch-1-aaa')?.parentSessionId).toBe('orch-1');
    expect(sessions.get('orch-1-bbb')?.parentSessionId).toBe('orch-1');
  });

  it('refuses a worker session id equal to the run id (the spawnAgent parent-linkage rule, live)', async () => {
    const dir = scratch('ancestry-');
    const deps = await orchestrateDepsWithDefaults({
      out: () => undefined,
      err: () => undefined,
      cwd: dir,
      sessionsRoot: join(dir, 'sessions'),
    });
    await expect(
      deps.createWorkerSession({
        sessionId: 'orch-1',
        agentId: 'aaa',
        workerSessionId: 'orch-1',
        worktree: { path: dir, branch: 'worker-aaa' },
        mode: 'autonomous',
      }),
    ).rejects.toThrow(/must differ from parentSessionId/);
  });
});
