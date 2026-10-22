// Session storage on pi-durable JSONL.
//
// One pi-durable Storage per <sessions-root>/<id>/, one durable Session per
// storage, one Kubic `kubic.session` document written in the creating commit,
// and the Kubic lock wrapping every storage open.
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createNodeFileBridge } from '@kubic/exec/file-bridge';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { BACKGROUND_CONTEXT } from '../../pi-boundary.js';
import { readSessionEntries } from '../transcript.js';
import { SessionLockError } from './lock.js';
import { openSessionStore, readSessionMetadata } from './meta.js';
import type { SessionHandle } from './store.js';
import { attachSession, createSession, listSessions } from './store.js';

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

function readHeader(root: string, id: string): Record<string, unknown> {
  return JSON.parse(
    readFileSync(join(root, id, 'session.json'), 'utf8'),
  ) as Record<string, unknown>;
}

// Lock wiring: create/attach acquire, release gives the lock back.
describe('session locking wiring', () => {
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

  it("a refused attach leaves the live holder's lock alone", async () => {
    const root = tmpRoot();
    const store = storeFor(root);
    const session = await createSession(
      store,
      { cwd: '/work' },
      BACKGROUND_CONTEXT,
    );
    const id = session.id;
    await session.release(BACKGROUND_CONTEXT);
    const fixture = JSON.stringify({ pid: FAKE_PID, startedAt: Date.now() });
    writeFileSync(join(root, id, 'lock.json'), fixture);
    const kill = stubKill(true);
    try {
      await expect(
        attachSession(store, id, BACKGROUND_CONTEXT),
      ).rejects.toBeInstanceOf(SessionLockError);
    } finally {
      kill.mockRestore();
    }
    // The refusal must not delete (or rewrite) the live holder's lock.
    expect(readFileSync(join(root, id, 'lock.json'), 'utf8')).toBe(fixture);
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

// Session state is private — transcripts hold the conversation,
// and `session.json` holds the workspace. The directory is 0700, every file
// in it 0600, and an existing loose directory is tightened when the lock is
// taken.
describe('session state permissions', () => {
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

  describe('session metadata', () => {
    it('ignores role and agentId keys an older session header still carries', async () => {
      const root = tmpRoot();
      const store = storeFor(root);
      const session = track(
        await createSession(store, { cwd: '/repo' }, BACKGROUND_CONTEXT),
      );
      // The durable document carries the same facts as the listing header.
      expect(
        await readSessionMetadata(session.storage, BACKGROUND_CONTEXT),
      ).toEqual(session.meta);
      await session.release(BACKGROUND_CONTEXT);
      // A header written before the identity keys were dropped.
      writeFileSync(
        join(root, session.id, 'session.json'),
        JSON.stringify({
          ...readHeader(root, session.id),
          role: 'implementer',
          agentId: 'aaa',
        }),
      );
      const listed = await listSessions(store, BACKGROUND_CONTEXT);
      const entry = listed.find((item) => item.id === session.id);
      expect(entry?.meta?.cwd).toBe('/repo');
      expect(entry?.meta).not.toHaveProperty('role');
      expect(entry?.meta).not.toHaveProperty('agentId');
      const reopened = track(
        await attachSession(store, session.id, BACKGROUND_CONTEXT),
      );
      expect(reopened.meta).not.toHaveProperty('role');
      expect(reopened.meta).not.toHaveProperty('agentId');
      await reopened.release(BACKGROUND_CONTEXT);
    });

    it('lists, attaches and reads a session whose durable document still carries role and agentId', async () => {
      // Older builds wrote the identity into the kubic.session document and
      // into the listing header. Such a session must still list, attach and
      // read, and it must expose no role or agentId.
      const root = tmpRoot();
      const store = storeFor(root);
      const session = track(
        await createSession(store, { cwd: '/repo' }, BACKGROUND_CONTEXT),
      );
      const id = session.id;
      await session.release(BACKGROUND_CONTEXT);
      // Adds the identity keys to every object that carries the session's
      // cwd and createdAt, wherever the storage keeps the document.
      const withLegacyIdentity = (value: unknown): unknown => {
        if (Array.isArray(value)) return value.map(withLegacyIdentity);
        if (value === null || typeof value !== 'object') return value;
        const record = value as Record<string, unknown>;
        if ('cwd' in record && 'createdAt' in record) {
          return { ...record, role: 'implementer', agentId: 'aaa' };
        }
        return Object.fromEntries(
          Object.entries(record).map(([key, child]) => [
            key,
            withLegacyIdentity(child),
          ]),
        );
      };
      for (const name of readdirSync(join(root, id))) {
        if (!/^(main|doc-\d+)\.jsonl$/.test(name)) continue;
        const path = join(root, id, name);
        const lines = readFileSync(path, 'utf8')
          .split('\n')
          .filter((line) => line.trim() !== '');
        writeFileSync(
          path,
          lines
            .map(
              (line) =>
                `${JSON.stringify(withLegacyIdentity(JSON.parse(line) as unknown))}\n`,
            )
            .join(''),
        );
      }
      // The premise: the legacy keys really reached the stored document.
      expect(
        readdirSync(join(root, id))
          .filter((name) => /^(main|doc-\d+)\.jsonl$/.test(name))
          .some((name) =>
            readFileSync(join(root, id, name), 'utf8').includes(
              '"agentId":"aaa"',
            ),
          ),
      ).toBe(true);
      writeFileSync(
        join(root, id, 'session.json'),
        JSON.stringify({
          ...readHeader(root, id),
          role: 'implementer',
          agentId: 'aaa',
        }),
      );
      const listed = await listSessions(store, BACKGROUND_CONTEXT);
      const entry = listed.find((item) => item.id === id);
      expect(entry?.meta?.cwd).toBe('/repo');
      expect(entry?.meta).not.toHaveProperty('role');
      expect(entry?.meta).not.toHaveProperty('agentId');
      const attached = track(
        await attachSession(store, id, BACKGROUND_CONTEXT),
      );
      expect(attached.meta).not.toHaveProperty('role');
      expect(attached.meta).not.toHaveProperty('agentId');
      expect(
        await readSessionMetadata(attached.storage, BACKGROUND_CONTEXT),
      ).toEqual(attached.meta);
      expect(
        await readSessionEntries(attached.storage, BACKGROUND_CONTEXT),
      ).toEqual([]);
      await attached.release(BACKGROUND_CONTEXT);
    });

    it('keeps the listing header free of transcript references', async () => {
      const root = tmpRoot();
      const store = storeFor(root);
      const session = track(
        await createSession(store, { cwd: '/repo' }, BACKGROUND_CONTEXT),
      );
      await session.release(BACKGROUND_CONTEXT);
      const header = readHeader(root, session.id);
      for (const key of Object.keys(header)) {
        expect(key).not.toMatch(/transcript|message|history|entries/i);
      }
      const value = JSON.stringify(header);
      expect(value).not.toContain('user:');
      expect(value).not.toContain('assistant:');
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
