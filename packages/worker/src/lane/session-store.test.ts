// Session storage on pi-durable JSONL (issue #392; §21–§22).
//
// One pi-durable Storage per <sessions-root>/<id>/, one durable Session per
// storage, one Kubic `kubic.session` document written in the creating commit,
// and the Kubic lock wrapping every storage open. Legacy 0.87 transcripts
// (`<root>/--<cwd>--/<ts>_<id>.jsonl`) are detected and refused, never read.
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import {
  createNodeFileBridge,
  type FileBridge,
} from '../../../exec/src/file-bridge.js';
import {
  BACKGROUND_CONTEXT,
  createModels,
  createRegistry,
  Harness,
  UserEntry,
} from '../pi-boundary.js';
import {
  acquireSessionLock,
  attachSession,
  createSession,
  KubicSessionDoc,
  listSessions,
  openSessionStore,
  readSessionMetadata,
  SessionAttachError,
  SessionFormatError,
  type SessionHandle,
  SessionIdError,
  SessionLockError,
  sessionsTouchingWorkspace,
} from './session-store.js';

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

// A 0.87 session: `<root>/--<cwd with /, \ and : mapped to -->--/` holding
// `<iso-timestamp>_<encoded id>.jsonl` whose first line is the format-4
// header. Exactly what `JsonlSessionRepo` wrote.
function writeLegacySession(
  root: string,
  cwd: string,
  id: string,
  createdAt: number,
): string {
  const dir = join(
    root,
    `--${cwd.replace(/^[/\\]/, '').replace(/[/\\:]/g, '-')}--`,
  );
  mkdirSync(dir, { recursive: true });
  const path = join(
    dir,
    `${new Date(createdAt).toISOString().replace(/[:.]/g, '-')}_${encodeURIComponent(id)}.jsonl`,
  );
  writeFileSync(
    path,
    `${JSON.stringify({
      v: 4,
      kind: 'header',
      id,
      storageVersion: 1,
      createdAt,
      cwd,
    })}\n${JSON.stringify({
      v: 4,
      kind: 'record',
      seq: 1,
      type: 'message',
      message: { role: 'user', content: 'hello' },
    })}\n`,
  );
  return path;
}

// The harness a Kubic caller boots over a session's storage (K5 #394 boots
// the real lane; here the same Harness.open + root() shape, no model call).
async function openHarness(
  session: SessionHandle,
): Promise<Awaited<ReturnType<typeof Harness.open>>> {
  return await Harness.open(
    session.storage,
    { models: createModels(), registry: createRegistry() },
    BACKGROUND_CONTEXT,
  );
}

describe('pi-durable session storage (issue #392)', () => {
  it('creates a session: JSONL storage, the kubic.session document, and the listing header', async () => {
    const root = tmpRoot();
    const store = storeFor(root);
    const before = Date.now();
    const session = track(
      await createSession(store, { cwd: '/work' }, BACKGROUND_CONTEXT),
    );
    expect(session.meta.cwd).toBe('/work');
    expect(session.id.length).toBeGreaterThan(0);
    expect(Date.parse(session.meta.createdAt)).toBeGreaterThanOrEqual(before);
    expect(session.dir).toBe(join(root, session.id));
    // The durable storage is on disk under <root>/<id>/ — and the Kubic lock
    // lives in the same directory, which the JSONL backend tolerates.
    expect(existsSync(join(session.dir, 'main.jsonl'))).toBe(true);
    expect(existsSync(join(session.dir, 'lock.json'))).toBe(true);
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

  it('refuses an id shaped like a pi transcript directory', async () => {
    const root = tmpRoot();
    const store = storeFor(root);
    // `--a--` matches the id class but is the shape of pi's transcript
    // directories: listing classifies it as a 0.87 layout, so a session with
    // that id would be invisible to `sessions list`, the overlap probe and
    // `kubic doctor`. Refused on both paths, before any directory is made.
    await expect(
      createSession(store, { cwd: '/work', id: '--a--' }, BACKGROUND_CONTEXT),
    ).rejects.toBeInstanceOf(SessionIdError);
    await expect(
      attachSession(store, '--a--', BACKGROUND_CONTEXT),
    ).rejects.toBeInstanceOf(SessionAttachError);
    expect(existsSync(join(root, '--a--'))).toBe(false);
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

  it('refuses to create a durable session over a 0.87 session id', async () => {
    const root = tmpRoot();
    const store = storeFor(root);
    writeLegacySession(root, '/work', 'legacy-3', Date.now() - 60_000);
    // The id belongs to a 0.87 session: reusing it would mix a new durable
    // session into the old session's journal and spans.
    await expect(
      createSession(
        store,
        { cwd: '/work', id: 'legacy-3' },
        BACKGROUND_CONTEXT,
      ),
    ).rejects.toBeInstanceOf(SessionFormatError);
    expect(existsSync(join(root, 'legacy-3', 'main.jsonl'))).toBe(false);
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

describe('session listing (issue #392)', () => {
  it('lists sessions with their recorded metadata, newest first', async () => {
    const root = tmpRoot();
    const store = storeFor(root);
    const current = track(
      await createSession(store, { cwd: '/one' }, BACKGROUND_CONTEXT),
    );
    await current.release(BACKGROUND_CONTEXT);
    // A 0.87 transcript recorded a minute earlier, so the order assertion
    // never depends on two sessions landing in the same millisecond.
    const earlier = Date.parse(current.meta.createdAt) - 60_000;
    writeLegacySession(root, '/two', 'legacy-older', earlier);

    const listed = await listSessions(store, BACKGROUND_CONTEXT);
    expect(listed.map((entry) => entry.id)).toEqual([
      current.id,
      'legacy-older',
    ]);
    expect(listed[0]).toEqual({
      id: current.id,
      meta: { cwd: '/one', createdAt: current.meta.createdAt },
      format: 'durable',
    });
    expect(listed[1]).toEqual({
      id: 'legacy-older',
      meta: {
        cwd: '/two',
        createdAt: new Date(earlier).toISOString(),
      },
      format: 'legacy',
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

  it('reports a 0.87 session directory as legacy and refuses to attach it', async () => {
    const root = tmpRoot();
    const store = storeFor(root);
    const createdAt = Date.now() - 60_000;
    const path = writeLegacySession(root, '/work', 'legacy-1', createdAt);

    const listed = await listSessions(store, BACKGROUND_CONTEXT);
    expect(listed).toEqual([
      {
        id: 'legacy-1',
        meta: { cwd: '/work', createdAt: new Date(createdAt).toISOString() },
        format: 'legacy',
      },
    ]);
    // A legacy transcript is never a live sibling: it cannot be attached.
    expect(
      await sessionsTouchingWorkspace(store, '/work', BACKGROUND_CONTEXT),
    ).toEqual([]);

    let caught: unknown;
    try {
      await attachSession(store, 'legacy-1', BACKGROUND_CONTEXT);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(SessionFormatError);
    expect((caught as Error).message).toBe(
      'session legacy-1 was written by Kubic on Pi 0.87; start a new session',
    );
    // Nothing was converted or moved: the transcript is exactly as written.
    expect(existsSync(path)).toBe(true);
  });

  it('skips a 0.87 header whose id is not a session id', async () => {
    const root = tmpRoot();
    const store = storeFor(root);
    // A hand-edited or foreign header: its id never reaches a listing that
    // #400's CLI renders, and it can never be attached.
    writeLegacySession(root, '/work', '../escape', Date.now() - 60_000);
    expect(await listSessions(store, BACKGROUND_CONTEXT)).toEqual([]);
    await expect(
      attachSession(store, 'escape', BACKGROUND_CONTEXT),
    ).rejects.toBeInstanceOf(SessionAttachError);
  });

  it('lists a 1.0 session beside a legacy one and keeps the 1.0 entry', async () => {
    const root = tmpRoot();
    const store = storeFor(root);
    const current = track(
      await createSession(
        store,
        { cwd: '/work', id: 'legacy-2' },
        BACKGROUND_CONTEXT,
      ),
    );
    await current.release(BACKGROUND_CONTEXT);
    // A 0.87 transcript that claims the same id (a hand-copied leftover):
    // the current format wins, and attach opens the storage, not the file.
    writeLegacySession(root, '/work', 'legacy-2', Date.now() - 60_000);
    const listed = await listSessions(store, BACKGROUND_CONTEXT);
    expect(listed).toEqual([
      {
        id: 'legacy-2',
        meta: { cwd: '/work', createdAt: current.meta.createdAt },
        format: 'durable',
      },
    ]);
    const attached = track(
      await attachSession(store, 'legacy-2', BACKGROUND_CONTEXT),
    );
    expect(attached.meta.cwd).toBe('/work');
  });

  it('skips a session directory with no storage and no legacy transcript', async () => {
    const root = tmpRoot();
    mkdirSync(join(root, 'half-created', 'journal'), { recursive: true });
    expect(await listSessions(storeFor(root), BACKGROUND_CONTEXT)).toEqual([]);
    await expect(
      attachSession(storeFor(root), 'half-created', BACKGROUND_CONTEXT),
    ).rejects.toBeInstanceOf(SessionAttachError);
  });
});

// Session locking (issue #118): the exclusive, stale-safe lock primitive.
// Hermetic by rule: pid liveness is probed through `process.kill(pid, 0)`,
// so every test here uses fake pid numbers and stubs `process.kill` — no
// test ever signals a real process.
describe('session lock primitive (issue #118)', () => {
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

  function readLock(dir: string): { pid?: unknown; startedAt?: unknown } {
    return JSON.parse(readFileSync(join(dir, 'lock.json'), 'utf8')) as {
      pid?: unknown;
      startedAt?: unknown;
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

  it('steals a day-old lock even when its pid looks alive (pid reuse)', () => {
    const dir = lockDir();
    writeFileSync(
      join(dir, 'lock.json'),
      JSON.stringify({ pid: FAKE_PID, startedAt: Date.now() - DAY_MS - 1 }),
    );
    // Liveness stubbed ALIVE: only the age arm can make this lock stale
    // (the dead-pid arm is covered by the same-day crash-recovery case).
    const kill = stubKill(true);
    try {
      acquireSessionLock(dir, 'sess-b');
    } finally {
      kill.mockRestore();
    }
    expect(readLock(dir).pid).toBe(process.pid);
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

// Lock wiring (issue #118): create/attach acquire, release gives the lock back.
describe('session locking wiring (issue #118)', () => {
  const FAKE_PID = 424242;

  function stubKill(alive: boolean): ReturnType<typeof vi.spyOn> {
    return vi.spyOn(process, 'kill').mockImplementation((() => {
      if (!alive) {
        throw Object.assign(new Error('kill ESRCH'), { code: 'ESRCH' });
      }
      return 0;
    }) as never);
  }

  it('acquires the lock on create and releases it on release', async () => {
    const root = tmpRoot();
    const store = storeFor(root);
    const session = await createSession(
      store,
      { cwd: '/work' },
      BACKGROUND_CONTEXT,
    );
    const lockPath = join(root, session.id, 'lock.json');
    expect(existsSync(lockPath)).toBe(true);
    await session.release(BACKGROUND_CONTEXT);
    expect(existsSync(lockPath)).toBe(false);
    // Release is idempotent: a second call is a no-op, not a crash.
    await session.release(BACKGROUND_CONTEXT);
  });

  it('acquires the lock on attach and releases it on release', async () => {
    const root = tmpRoot();
    const store = storeFor(root);
    const session = await createSession(
      store,
      { cwd: '/work' },
      BACKGROUND_CONTEXT,
    );
    const id = session.id;
    await session.release(BACKGROUND_CONTEXT);
    const attached = await attachSession(store, id, BACKGROUND_CONTEXT);
    const lockPath = join(root, id, 'lock.json');
    expect(existsSync(lockPath)).toBe(true);
    await attached.release(BACKGROUND_CONTEXT);
    expect(existsSync(lockPath)).toBe(false);
  });

  it('refuses a second attach while a live holder exists, naming the pid', async () => {
    const root = tmpRoot();
    const store = storeFor(root);
    const session = await createSession(
      store,
      { cwd: '/work' },
      BACKGROUND_CONTEXT,
    );
    const id = session.id;
    await session.release(BACKGROUND_CONTEXT);
    // A live-looking lock fixture: fake pid, stubbed liveness — no real
    // process is ever signalled.
    writeFileSync(
      join(root, id, 'lock.json'),
      JSON.stringify({ pid: FAKE_PID, startedAt: Date.now() }),
    );
    const kill = stubKill(true);
    try {
      let caught: unknown;
      try {
        await attachSession(store, id, BACKGROUND_CONTEXT);
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(SessionLockError);
      expect((caught as Error).message).toContain(String(FAKE_PID));
    } finally {
      kill.mockRestore();
    }
  });

  it('steals a crashed holder lock on attach (same-day dead pid)', async () => {
    const root = tmpRoot();
    const store = storeFor(root);
    const session = await createSession(
      store,
      { cwd: '/work' },
      BACKGROUND_CONTEXT,
    );
    const id = session.id;
    await session.release(BACKGROUND_CONTEXT);
    writeFileSync(
      join(root, id, 'lock.json'),
      JSON.stringify({ pid: FAKE_PID, startedAt: Date.now() }),
    );
    const kill = stubKill(false);
    try {
      const attached = await attachSession(store, id, BACKGROUND_CONTEXT);
      // The crashed holder's lock now names this process.
      const lock = JSON.parse(
        readFileSync(join(root, id, 'lock.json'), 'utf8'),
      ) as { pid?: unknown };
      expect(lock.pid).toBe(process.pid);
      await attached.release(BACKGROUND_CONTEXT);
    } finally {
      kill.mockRestore();
    }
    expect(existsSync(join(root, id, 'lock.json'))).toBe(false);
  });
});

// Issue #361: session state is private — transcripts hold the conversation,
// and `session.json` holds the workspace. The directory is 0700, every file
// in it 0600, and an existing loose directory is tightened when the lock is
// taken.
describe('session state permissions (issue #361)', () => {
  it.skipIf(process.platform === 'win32')(
    'creates the session directory 0700 and its files 0600',
    async () => {
      const root = tmpRoot();
      const store = storeFor(root);
      const session = track(
        await createSession(store, { cwd: '/work' }, BACKGROUND_CONTEXT),
      );
      await session.release(BACKGROUND_CONTEXT);
      const dir = join(root, session.id);
      expect(statSync(dir).mode & 0o777).toBe(0o700);
      const files = readdirSync(dir).filter((name) =>
        statSync(join(dir, name)).isFile(),
      );
      expect(files.length).toBeGreaterThan(0);
      for (const name of files) {
        expect(statSync(join(dir, name)).mode & 0o777).toBe(0o600);
      }
    },
  );

  it.skipIf(process.platform === 'win32')(
    'tightens an existing loose sessions root when the lock is taken',
    async () => {
      const root = tmpRoot();
      chmodSync(root, 0o755);
      expect(statSync(root).mode & 0o777).toBe(0o755);
      const store = storeFor(root);
      const session = track(
        await createSession(store, { cwd: '/work' }, BACKGROUND_CONTEXT),
      );
      // The root is what `kubic doctor` reports; the open closes it, so the
      // warn cannot outlive the next session.
      expect(statSync(root).mode & 0o777).toBe(0o700);
      await session.release(BACKGROUND_CONTEXT);
    },
  );

  describe('session ancestry (issue #164)', () => {
    it('records parentSessionId, role and agentId on the worker session', async () => {
      const root = tmpRoot();
      const store = storeFor(root);
      const parent = track(
        await createSession(store, { cwd: '/repo' }, BACKGROUND_CONTEXT),
      );
      await parent.release(BACKGROUND_CONTEXT);
      const worker = track(
        await createSession(
          store,
          {
            cwd: '/repo/.kubic/wt/aaa',
            parentSessionId: parent.id,
            role: 'implementer',
            agentId: 'aaa',
          },
          BACKGROUND_CONTEXT,
        ),
      );
      expect(worker.meta.parentSessionId).toBe(parent.id);
      expect(worker.meta.role).toBe('implementer');
      expect(worker.meta.agentId).toBe('aaa');
      // The durable document carries the same linkage.
      expect(
        await readSessionMetadata(worker.storage, BACKGROUND_CONTEXT),
      ).toEqual(worker.meta);
      await worker.release(BACKGROUND_CONTEXT);
      // The listing header carries it too, so listSessions surfaces the
      // tree without opening any storage.
      const listed = await listSessions(store, BACKGROUND_CONTEXT);
      const child = listed.find((entry) => entry.id === worker.id);
      expect(child?.meta?.parentSessionId).toBe(parent.id);
      expect(child?.meta?.role).toBe('implementer');
      expect(child?.meta?.agentId).toBe('aaa');
    });

    it('keeps child metadata free of parent transcript references', async () => {
      const root = tmpRoot();
      const store = storeFor(root);
      const parent = track(
        await createSession(store, { cwd: '/repo' }, BACKGROUND_CONTEXT),
      );
      await parent.release(BACKGROUND_CONTEXT);
      const worker = track(
        await createSession(
          store,
          {
            cwd: '/repo/.kubic/wt/aaa',
            parentSessionId: parent.id,
            role: 'implementer',
            agentId: 'aaa',
          },
          BACKGROUND_CONTEXT,
        ),
      );
      await worker.release(BACKGROUND_CONTEXT);
      const header = readHeader(root, worker.id);
      for (const key of Object.keys(header)) {
        expect(key).not.toMatch(/transcript|message|history|entries/i);
      }
      const value = JSON.stringify(header);
      expect(value).not.toContain('user:');
      expect(value).not.toContain('assistant:');
    });

    it('refuses a parentSessionId outside the session id alphabet', async () => {
      const root = tmpRoot();
      const store = storeFor(root);
      await expect(
        createSession(
          store,
          { cwd: '/work', parentSessionId: '../evil' },
          BACKGROUND_CONTEXT,
        ),
      ).rejects.toThrow(SessionIdError);
    });
  });

  it.skipIf(process.platform === 'win32')(
    'tightens an existing loose session directory when the lock is taken',
    async () => {
      const root = tmpRoot();
      const store = storeFor(root);
      const session = track(
        await createSession(store, { cwd: '/work' }, BACKGROUND_CONTEXT),
      );
      await session.release(BACKGROUND_CONTEXT);
      const dir = join(root, session.id);
      chmodSync(dir, 0o755);
      expect(statSync(dir).mode & 0o777).toBe(0o755);
      // The next attach (which takes the lock) closes it.
      const attached = track(
        await attachSession(store, session.id, BACKGROUND_CONTEXT),
      );
      expect(statSync(dir).mode & 0o777).toBe(0o700);
      await attached.release(BACKGROUND_CONTEXT);
    },
  );
});
