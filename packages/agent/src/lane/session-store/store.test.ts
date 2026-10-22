// Session storage on pi-durable JSONL.
//
// One pi-durable Storage per <sessions-root>/<id>/, one durable Session per
// storage, one Kubic `kubic.session` document written in the creating commit,
// and the Kubic lock wrapping every storage open.
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createNodeFileBridge, type FileBridge } from '@kubic/exec/file-bridge';
import { processStartTimeOf } from '@kubic/exec/lock-file';
import { afterAll, describe, expect, it, vi } from 'vitest';
import {
  BACKGROUND_CONTEXT,
  createModels,
  createRegistry,
  fauxAssistantMessage,
  Harness,
  UserEntry,
} from '../../pi-boundary.js';
import { bootFauxLane } from '../../test-support/lane-harness.js';
import { readSessionEntries } from '../transcript.js';
import { SessionIdError } from './ids.js';
import {
  acquireSessionLock,
  releaseSessionLock,
  SessionLockError,
} from './lock.js';
import {
  KubicSessionDoc,
  openSessionStore,
  readSessionMetadata,
} from './meta.js';
import type { SessionHandle } from './store.js';
import {
  attachSession,
  createSession,
  listSessions,
  SessionAttachError,
  sessionsTouchingWorkspace,
  workspacePeers,
} from './store.js';

const openSessions: SessionHandle[] = [];

const scratchDirs: string[] = [];

afterAll(async () => {
  for (const session of openSessions.splice(0)) {
    await session.release(BACKGROUND_CONTEXT);
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

function tmpRoot(): string {
  return scratch('sessions-');
}

function storeFor(root: string): ReturnType<typeof openSessionStore> {
  return openSessionStore(root, createNodeFileBridge(root));
}

function track(handle: SessionHandle): SessionHandle {
  openSessions.push(handle);
  return handle;
}

// A bridge that counts the storage's file reads, so "the second attach never
// opened the storage" is an observation, not an assumption.
function countingBridge(root: string): {
  bridge: FileBridge;
  reads: () => number;
} {
  const inner = createNodeFileBridge(root);
  let reads = 0;
  return {
    bridge: {
      ...inner,
      readBinaryFile: (path: string): Uint8Array => {
        reads += 1;
        return inner.readBinaryFile(path);
      },
    },
    reads: () => reads,
  };
}

function readHeader(root: string, id: string): Record<string, unknown> {
  return JSON.parse(
    readFileSync(join(root, id, 'session.json'), 'utf8'),
  ) as Record<string, unknown>;
}

// Rewrites a session's header `createdAt`, the value the listing orders by.
function backdateSession(root: string, id: string, createdAt: string): void {
  const path = join(root, id, 'session.json');
  const header = JSON.parse(readFileSync(path, 'utf8')) as Record<
    string,
    unknown
  >;
  writeFileSync(path, `${JSON.stringify({ ...header, createdAt })}\n`);
}

// The harness a Kubic caller boots over a session's storage (the real lane
// boots the same way; here the same Harness.open + root() shape, no model
// call).
async function openHarness(
  session: SessionHandle,
): Promise<Awaited<ReturnType<typeof Harness.open>>> {
  return await Harness.open(
    session.storage,
    { models: createModels(), registry: createRegistry() },
    BACKGROUND_CONTEXT,
  );
}

describe('pi-durable session storage', () => {
  it('creates a session: JSONL storage, the kubic.session document, and the listing header', async () => {
    const root = tmpRoot();
    const store = storeFor(root);
    const before = Date.now();
    const session = track(
      await createSession(store, { cwd: '/work' }, BACKGROUND_CONTEXT),
    );
    expect(session.meta.cwd).toBe('/work');
    // The id gate session-store.ts enforces (isSessionId): uuidv7 passes
    // it, so a generator regression fails here instead of at attach.
    expect(session.id).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(Date.parse(session.meta.createdAt)).toBeGreaterThanOrEqual(before);
    expect(session.dir).toBe(join(root, session.id));
    // The durable storage is on disk under <root>/<id>/ — and the Kubic lock
    // lives in the same directory, which the JSONL backend tolerates.
    expect(existsSync(join(session.dir, 'main.jsonl'))).toBe(true);
    expect(existsSync(join(session.dir, 'lock.json'))).toBe(true);
    // The storage opens with its identity commit: the first JSONL line is
    // the format-1 commit creating the kubic.session document (the cwd
    // itself rides session.json, pinned exact in the header below).
    const firstLine = readFileSync(
      join(session.dir, 'main.jsonl'),
      'utf8',
    ).split('\n')[0] as string;
    const first = JSON.parse(firstLine) as {
      format: number;
      type: string;
      seq: number;
      writes: Array<{ record: { kind: string } }>;
    };
    expect(first).toMatchObject({ format: 1, type: 'commit', seq: 1 });
    expect(
      first.writes.some((write) => write.record.kind === 'kubic.session'),
    ).toBe(true);
    // The run's mode rides the session metadata when
    // given, and stays absent otherwise (off by default).
    const withMode = track(
      await createSession(
        store,
        { cwd: '/work', mode: 'autonomous' },
        BACKGROUND_CONTEXT,
      ),
    );
    expect(withMode.meta.mode).toBe('autonomous');
    expect(session.meta.mode).toBeUndefined();
    // The listing header: the projection listSessions reads without opening
    // a live session's storage.
    expect(readHeader(root, session.id)).toEqual({
      v: 1,
      kind: 'kubic.session',
      id: session.id,
      ...session.meta,
    });
    // The document itself, read back through the storage it was committed to.
    expect(
      await readSessionMetadata(session.storage, BACKGROUND_CONTEXT),
    ).toEqual(session.meta);
  });

  it('a restored entry deep-equals the committed one across an attach', async () => {
    // One faux turn commits entries to <root>/<id>/main.jsonl; after
    // cleanup the lock is gone, so a fresh attach reopens the same dir
    // and must read back byte-identical entries.
    const root = tmpRoot();
    const lane = await bootFauxLane({
      storage: 'jsonl',
      root,
      responses: [fauxAssistantMessage('hello')],
    });
    const id = lane.sessionId;
    await lane.run('say hi');
    const committed = await readSessionEntries(
      lane.session.storage,
      BACKGROUND_CONTEXT,
    );
    expect(committed.length).toBeGreaterThan(0);
    await lane.cleanup();
    const attached = track(
      await attachSession(storeFor(root), id, BACKGROUND_CONTEXT),
    );
    expect(
      await readSessionEntries(attached.storage, BACKGROUND_CONTEXT),
    ).toEqual(committed);
  });

  it('records who created a session and the team it is billed to', async () => {
    const root = tmpRoot();
    const store = storeFor(root);
    const session = track(
      await createSession(
        store,
        { cwd: '/work', user: 'ada', team: 'core' },
        BACKGROUND_CONTEXT,
      ),
    );
    expect(session.meta).toMatchObject({ user: 'ada', team: 'core' });
    expect(readHeader(root, session.id)).toMatchObject({
      user: 'ada',
      team: 'core',
    });
    expect(
      await readSessionMetadata(session.storage, BACKGROUND_CONTEXT),
    ).toMatchObject({ user: 'ada', team: 'core' });
  });

  it('records a declared workspace beside the cwd', async () => {
    const root = tmpRoot();
    const store = storeFor(root);
    const session = track(
      await createSession(
        store,
        { cwd: '/work/pkg', workspace: '/work' },
        BACKGROUND_CONTEXT,
      ),
    );
    expect(session.meta).toEqual({
      cwd: '/work/pkg',
      createdAt: session.meta.createdAt,
      workspace: '/work',
    });
    await session.release(BACKGROUND_CONTEXT);
    // The probe matches the declared workspace, not the cwd.
    expect(
      await sessionsTouchingWorkspace(store, '/work', BACKGROUND_CONTEXT),
    ).toEqual([session.id]);
    expect(
      await sessionsTouchingWorkspace(store, '/work/pkg', BACKGROUND_CONTEXT),
    ).toEqual([]);
    // The synchronous peer read the end-of-run sweep uses: the same match,
    // the asking session left out.
    expect(workspacePeers(store, '/work', 'another-session')).toEqual([
      { id: session.id, dir: join(root, session.id) },
    ]);
    expect(workspacePeers(store, '/work', session.id)).toEqual([]);
    expect(workspacePeers(store, '/work/pkg', 'another-session')).toEqual([]);
  });

  it('attach restores the root conversation, its entries and the kubic.session doc', async () => {
    const root = tmpRoot();
    const store = storeFor(root);
    const session = await createSession(
      store,
      { cwd: '/work' },
      BACKGROUND_CONTEXT,
    );
    const id = session.id;
    const harness = await openHarness(session);
    const conversation = await harness.root(BACKGROUND_CONTEXT, {
      agent: { cwd: '/work' },
    });
    await conversation.commit(
      (tx) =>
        tx.appendEntry(UserEntry, conversation.id, {
          model: [{ role: 'user', content: 'hello', timestamp: Date.now() }],
        }),
      BACKGROUND_CONTEXT,
    );
    await harness.close(BACKGROUND_CONTEXT);
    await session.release(BACKGROUND_CONTEXT);

    const attached = track(await attachSession(store, id, BACKGROUND_CONTEXT));
    expect(attached.meta).toEqual(session.meta);
    const reopened = await openHarness(attached);
    try {
      expect(
        await reopened.snapshot(KubicSessionDoc, BACKGROUND_CONTEXT),
      ).toMatchObject(session.meta);
      const page = await (await reopened.root(BACKGROUND_CONTEXT)).entries(
        {},
        50,
        undefined,
        BACKGROUND_CONTEXT,
      );
      expect(JSON.stringify(page.items)).toContain('hello');
    } finally {
      await reopened.close(BACKGROUND_CONTEXT);
    }
  });

  it('refuses a second attach through the Kubic lock without opening the storage', async () => {
    const root = tmpRoot();
    const first = track(
      await createSession(storeFor(root), { cwd: '/work' }, BACKGROUND_CONTEXT),
    );
    const { bridge, reads } = countingBridge(root);
    const store = openSessionStore(root, bridge);
    let caught: unknown;
    try {
      await attachSession(store, first.id, BACKGROUND_CONTEXT);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(SessionLockError);
    expect((caught as Error).message).toContain(String(process.pid));
    // The refusal happens BEFORE any storage open: nothing read main.jsonl.
    expect(reads()).toBe(0);
    // A dead holder's lock is stolen, so attach still works after a crash.
    await first.release(BACKGROUND_CONTEXT);
    const attached = track(
      await attachSession(store, first.id, BACKGROUND_CONTEXT),
    );
    expect(attached.id).toBe(first.id);
  });

  it('rejects an id that would escape the sessions root', async () => {
    const root = tmpRoot();
    const store = storeFor(root);
    await expect(
      createSession(
        store,
        { cwd: '/work', id: '../escape' },
        BACKGROUND_CONTEXT,
      ),
    ).rejects.toBeInstanceOf(SessionIdError);
    await expect(
      attachSession(store, '../escape', BACKGROUND_CONTEXT),
    ).rejects.toBeInstanceOf(SessionAttachError);
  });

  it('refuses to create over an existing session and never rewrites its metadata', async () => {
    const root = tmpRoot();
    const store = storeFor(root);
    const first = track(
      await createSession(
        store,
        { cwd: '/work', id: 'kept' },
        BACKGROUND_CONTEXT,
      ),
    );
    await first.release(BACKGROUND_CONTEXT);
    await expect(
      createSession(store, { cwd: '/other', id: 'kept' }, BACKGROUND_CONTEXT),
    ).rejects.toThrow(/already exists/);
    // The original session is untouched: same metadata, same header.
    const attached = track(
      await attachSession(store, 'kept', BACKGROUND_CONTEXT),
    );
    expect(attached.meta).toEqual(first.meta);
    expect(readHeader(root, 'kept').cwd).toBe('/work');
  });

  it('leaves no half-made session behind when create fails', async () => {
    const root = tmpRoot();
    const inner = createNodeFileBridge(root);
    // A bridge that fails writing the listing header — the last step of a
    // create, after the creating commit landed.
    const failing: FileBridge = {
      ...inner,
      writeFile: (path, content, options) => {
        if (path.endsWith('session.json')) throw new Error('disk full');
        inner.writeFile(path, content, options);
      },
    };
    const store = openSessionStore(root, failing);
    await expect(
      createSession(store, { cwd: '/work', id: 'failed' }, BACKGROUND_CONTEXT),
    ).rejects.toThrow('disk full');
    // No lock, no storage: the id is free again and a retry works.
    expect(existsSync(join(root, 'failed', 'lock.json'))).toBe(false);
    expect(existsSync(join(root, 'failed', 'main.jsonl'))).toBe(false);
    expect(await listSessions(storeFor(root), BACKGROUND_CONTEXT)).toEqual([]);
    const retry = track(
      await createSession(
        storeFor(root),
        { cwd: '/work', id: 'failed' },
        BACKGROUND_CONTEXT,
      ),
    );
    expect(retry.meta.cwd).toBe('/work');
  });

  it('writes jq-inspectable JSONL under the session directory', async () => {
    const root = tmpRoot();
    const store = storeFor(root);
    const session = track(
      await createSession(store, { cwd: '/work' }, BACKGROUND_CONTEXT),
    );
    const jsonlFiles: string[] = [];
    const walk = (dir: string): void => {
      for (const name of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, name.name);
        if (name.isDirectory()) walk(full);
        else if (name.name.endsWith('.jsonl')) jsonlFiles.push(full);
      }
    };
    walk(session.dir);
    expect(jsonlFiles.length).toBeGreaterThan(0);
    let lines = 0;
    for (const file of jsonlFiles) {
      for (const line of readFileSync(file, 'utf8').split('\n')) {
        if (line.trim().length === 0) continue;
        lines += 1;
        expect(() => JSON.parse(line)).not.toThrow();
      }
    }
    expect(lines).toBeGreaterThan(0);
  });

  it('release closes a storage no harness took, and gives the lock back', async () => {
    const root = tmpRoot();
    const store = storeFor(root);
    const session = await createSession(
      store,
      { cwd: '/work' },
      BACKGROUND_CONTEXT,
    );
    await session.release(BACKGROUND_CONTEXT);
    expect(existsSync(join(root, session.id, 'lock.json'))).toBe(false);
    // Nobody adopted the storage, so the handle closed it: it is unusable.
    await expect(
      Harness.open(
        session.storage,
        { models: createModels(), registry: createRegistry() },
        BACKGROUND_CONTEXT,
      ),
    ).rejects.toThrow(/closed/i);
  });

  it('release leaves an adopted storage open and still gives the lock back', async () => {
    const root = tmpRoot();
    const store = storeFor(root);
    const session = await createSession(
      store,
      { cwd: '/work' },
      BACKGROUND_CONTEXT,
    );
    const adopted = session.adopt();
    expect(adopted).toBe(session.storage);
    await session.release(BACKGROUND_CONTEXT);
    // The lock is released either way...
    expect(existsSync(join(root, session.id, 'lock.json'))).toBe(false);
    // ...but the storage is the harness's now, so release never closed it.
    const harness = await Harness.open(
      adopted,
      { models: createModels(), registry: createRegistry() },
      BACKGROUND_CONTEXT,
    );
    await harness.close(BACKGROUND_CONTEXT);
    // Release stays idempotent after the harness closed it.
    await session.release(BACKGROUND_CONTEXT);
  });

  it('commits without an fsync seam on the bridge (upstream default)', async () => {
    const root = tmpRoot();
    const inner = createNodeFileBridge(root);
    const { flushFile: _flush, ...withoutFlush } = inner;
    const store = openSessionStore(root, withoutFlush as FileBridge);
    const session = track(
      await createSession(store, { cwd: '/work' }, BACKGROUND_CONTEXT),
    );
    const id = session.id;
    await session.release(BACKGROUND_CONTEXT);
    const attached = track(await attachSession(store, id, BACKGROUND_CONTEXT));
    expect(attached.meta).toEqual(session.meta);
  });
});

describe('session listing', () => {
  it('lists sessions with their recorded metadata, newest first', async () => {
    const root = tmpRoot();
    const store = storeFor(root);
    const current = track(
      await createSession(store, { cwd: '/one' }, BACKGROUND_CONTEXT),
    );
    await current.release(BACKGROUND_CONTEXT);
    const older = track(
      await createSession(store, { cwd: '/two' }, BACKGROUND_CONTEXT),
    );
    await older.release(BACKGROUND_CONTEXT);
    // The older session is backdated a minute, so the order assertion never
    // depends on two sessions landing in the same millisecond.
    const earlier = new Date(
      Date.parse(current.meta.createdAt) - 60_000,
    ).toISOString();
    backdateSession(root, older.id, earlier);

    const listed = await listSessions(store, BACKGROUND_CONTEXT);
    expect(listed.map((entry) => entry.id)).toEqual([current.id, older.id]);
    expect(listed[0]).toEqual({
      id: current.id,
      meta: { cwd: '/one', createdAt: current.meta.createdAt },
    });
    expect(listed[1]).toEqual({
      id: older.id,
      meta: { cwd: '/two', createdAt: earlier },
    });
  });

  it('lists nothing when the sessions root does not exist', async () => {
    const root = join(tmpRoot(), 'missing');
    expect(await listSessions(storeFor(root), BACKGROUND_CONTEXT)).toEqual([]);
    expect(
      await sessionsTouchingWorkspace(
        storeFor(root),
        '/work',
        BACKGROUND_CONTEXT,
      ),
    ).toEqual([]);
  });

  it('names only the sessions recorded for one workspace', async () => {
    const root = tmpRoot();
    const store = storeFor(root);
    const mine = track(
      await createSession(store, { cwd: '/work' }, BACKGROUND_CONTEXT),
    );
    const other = track(
      await createSession(store, { cwd: '/else' }, BACKGROUND_CONTEXT),
    );
    await mine.release(BACKGROUND_CONTEXT);
    await other.release(BACKGROUND_CONTEXT);
    expect(
      await sessionsTouchingWorkspace(store, '/work', BACKGROUND_CONTEXT),
    ).toEqual([mine.id]);
  });

  it('ignores a folder that holds a transcript but no session storage', async () => {
    const root = tmpRoot();
    const store = storeFor(root);
    const folder = join(root, '--work--');
    mkdirSync(folder, { recursive: true });
    writeFileSync(
      join(folder, 'stray-1.jsonl'),
      `${JSON.stringify({ v: 4, kind: 'header', id: 'stray-1', cwd: '/work' })}\n`,
    );
    expect(await listSessions(store, BACKGROUND_CONTEXT)).toEqual([]);
    await expect(
      attachSession(store, 'stray-1', BACKGROUND_CONTEXT),
    ).rejects.toBeInstanceOf(SessionAttachError);
  });

  it('skips a session directory with no storage', async () => {
    const root = tmpRoot();
    mkdirSync(join(root, 'half-created', 'journal'), { recursive: true });
    expect(await listSessions(storeFor(root), BACKGROUND_CONTEXT)).toEqual([]);
    await expect(
      attachSession(storeFor(root), 'half-created', BACKGROUND_CONTEXT),
    ).rejects.toBeInstanceOf(SessionAttachError);
  });
});

// Session locking: the exclusive, stale-safe lock primitive.
// Hermetic by rule: pid liveness is probed through `process.kill(pid, 0)`,
// so every test here uses fake pid numbers and stubs `process.kill` — no
// test ever signals a real process.
describe('session lock primitive', () => {
  const FAKE_PID = 424242;
  const DAY_MS = 24 * 60 * 60 * 1000;

  function lockDir(): string {
    return scratch('lock-');
  }

  function stubKill(alive: boolean): ReturnType<typeof vi.spyOn> {
    return vi.spyOn(process, 'kill').mockImplementation((() => {
      if (!alive) {
        throw Object.assign(new Error('kill ESRCH'), { code: 'ESRCH' });
      }
      return 0;
    }) as never);
  }

  function readLock(dir: string): {
    pid?: unknown;
    startedAt?: unknown;
    nonce?: unknown;
  } {
    return JSON.parse(readFileSync(join(dir, 'lock.json'), 'utf8')) as {
      pid?: unknown;
      startedAt?: unknown;
      nonce?: unknown;
    };
  }

  it('refuses a second acquire while a live-looking lock exists, naming the holder', () => {
    const dir = lockDir();
    const startedAt = Date.now();
    writeFileSync(
      join(dir, 'lock.json'),
      JSON.stringify({ pid: FAKE_PID, startedAt }),
    );
    const kill = stubKill(true);
    try {
      let caught: unknown;
      try {
        acquireSessionLock(dir, 'sess-a');
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(SessionLockError);
      expect((caught as Error).name).toBe('SessionLockError');
      const message = (caught as Error).message;
      expect(message).toContain("session 'sess-a'");
      expect(message).toContain(String(FAKE_PID));
      expect(message).toContain(new Date(startedAt).toISOString());
    } finally {
      kill.mockRestore();
    }
  });

  it('does not steal a 48h-old lock whose holder pid is alive', () => {
    const dir = lockDir();
    // A legacy-shaped lock (no procStart): a long TUI session's holder is
    // alive, so the 24h age rule must not take it.
    const fixture = JSON.stringify({
      pid: FAKE_PID,
      startedAt: Date.now() - 48 * DAY_MS,
    });
    writeFileSync(join(dir, 'lock.json'), fixture);
    const kill = stubKill(true);
    try {
      let caught: unknown;
      try {
        acquireSessionLock(dir, 'sess-b');
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(SessionLockError);
      expect((caught as Error).message).toContain(String(FAKE_PID));
    } finally {
      kill.mockRestore();
    }
    // The live holder's lock is untouched: no steal, no clobber.
    expect(readFileSync(join(dir, 'lock.json'), 'utf8')).toBe(fixture);
  });

  it('does not steal a 48h-old lock whose recorded process start still matches', () => {
    const dir = lockDir();
    const procStart = processStartTimeOf(process.pid);
    const fixture = JSON.stringify({
      pid: process.pid,
      startedAt: Date.now() - 48 * DAY_MS,
      ...(procStart === undefined ? {} : { procStart }),
    });
    writeFileSync(join(dir, 'lock.json'), fixture);
    // No kill stub: process.pid is really alive, so only the process-start
    // match (or the pid-only fallback where the reader is unavailable) can
    // refuse this acquire.
    let caught: unknown;
    try {
      acquireSessionLock(dir, 'sess-b2');
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(SessionLockError);
    expect(readFileSync(join(dir, 'lock.json'), 'utf8')).toBe(fixture);
  });

  (processStartTimeOf(process.pid) === undefined ? it.skip : it)(
    'steals a lock whose pid is alive but whose process start moved (pid reuse)',
    () => {
      const dir = lockDir();
      // Our own pid is alive, but epoch-1 is not when this process started:
      // the pid number was recycled by a younger process.
      writeFileSync(
        join(dir, 'lock.json'),
        JSON.stringify({
          pid: process.pid,
          startedAt: Date.now(),
          procStart: 1,
        }),
      );
      acquireSessionLock(dir, 'sess-reuse');
      const taken = JSON.parse(
        readFileSync(join(dir, 'lock.json'), 'utf8'),
      ) as {
        pid?: unknown;
        procStart?: unknown;
      };
      expect(taken.pid).toBe(process.pid);
      expect(taken.procStart).not.toBe(1);
    },
  );

  it('a simulated concurrent stale takeover leaves exactly one owner', () => {
    const dir = lockDir();
    writeFileSync(
      join(dir, 'lock.json'),
      JSON.stringify({ pid: FAKE_PID, startedAt: Date.now() }),
    );
    // Racer A arrives first: the holder is dead, so A steals and owns.
    let kill = stubKill(false);
    try {
      acquireSessionLock(dir, 'sess-race');
    } finally {
      kill.mockRestore();
    }
    const owned = readFileSync(join(dir, 'lock.json'), 'utf8');
    expect((JSON.parse(owned) as { pid?: unknown }).pid).toBe(process.pid);
    // Racer B arrives after: the holder (A, this process) is alive, so B
    // is refused and A's lock is byte-identical — exactly one owner.
    kill = stubKill(true);
    try {
      let caught: unknown;
      try {
        acquireSessionLock(dir, 'sess-race');
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(SessionLockError);
    } finally {
      kill.mockRestore();
    }
    expect(readFileSync(join(dir, 'lock.json'), 'utf8')).toBe(owned);
  });

  it("release does not remove another process's lock", () => {
    const dir = lockDir();
    const fixture = JSON.stringify({ pid: FAKE_PID, startedAt: Date.now() });
    writeFileSync(join(dir, 'lock.json'), fixture);
    const kill = stubKill(true);
    try {
      releaseSessionLock(dir);
    } finally {
      kill.mockRestore();
    }
    expect(readFileSync(join(dir, 'lock.json'), 'utf8')).toBe(fixture);
  });

  it('a stale release cannot remove a re-acquired lock', () => {
    const dir = lockDir();
    const first = acquireSessionLock(dir, 'sess-nonce');
    releaseSessionLock(dir, first);
    expect(existsSync(join(dir, 'lock.json'))).toBe(false);
    const second = acquireSessionLock(dir, 'sess-nonce');
    expect(second).not.toBe(first);
    // The stale handle's release names the old nonce: no-op.
    releaseSessionLock(dir, first);
    expect(readLock(dir)).toMatchObject({ pid: process.pid, nonce: second });
    releaseSessionLock(dir, second);
    expect(existsSync(join(dir, 'lock.json'))).toBe(false);
  });

  it('treats a torn lock.json as a stale candidate and steals it', () => {
    const dir = lockDir();
    writeFileSync(join(dir, 'lock.json'), '{"pid": 4242'); // torn write
    // Even with every pid looking alive, a torn payload names no holder.
    const kill = stubKill(true);
    try {
      acquireSessionLock(dir, 'sess-c');
    } finally {
      kill.mockRestore();
    }
    expect(readLock(dir).pid).toBe(process.pid);
  });

  it('surfaces a lost steal race as SessionLockError, never a crash', () => {
    const dir = lockDir();
    // A lock.json that cannot be removed (a directory): the steal's rmSync
    // fails and the retry write hits EEXIST exactly as a lost race would.
    mkdirSync(join(dir, 'lock.json'));
    const kill = stubKill(false);
    try {
      let caught: unknown;
      try {
        acquireSessionLock(dir, 'sess-d');
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(SessionLockError);
    } finally {
      kill.mockRestore();
    }
  });

  it('steals a same-day lock whose holder process is gone (crash recovery)', () => {
    const dir = lockDir();
    writeFileSync(
      join(dir, 'lock.json'),
      JSON.stringify({ pid: FAKE_PID, startedAt: Date.now() }),
    );
    const kill = stubKill(false);
    try {
      acquireSessionLock(dir, 'sess-e');
    } finally {
      kill.mockRestore();
    }
    expect(readLock(dir).pid).toBe(process.pid);
  });
});
