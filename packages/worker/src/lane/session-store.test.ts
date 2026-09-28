// Slice A: JSONL session store — create, attach restores, jq-inspectable.
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
import { afterAll, describe, expect, it, vi } from 'vitest';
import { createNodeFileBridge } from '../../../exec/src/file-bridge.js';
import { BACKGROUND_CONTEXT, type Session } from '../pi-boundary.js';
import {
  acquireSessionLock,
  attachSession,
  createSession,
  openSessionStore,
  SessionLockError,
} from './session-store.js';

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

function tmpRoot(): string {
  return scratch('sessions-');
}

describe('JSONL session store (issue #14, slice A)', () => {
  it('creates a session with cwd metadata', async () => {
    const root = tmpRoot();
    const store = openSessionStore(root, createNodeFileBridge(root));
    const session = await createSession(store, '/work', BACKGROUND_CONTEXT);
    openSessions.push(session);
    expect(session.metadata.cwd).toBe('/work');
    expect(session.metadata.id.length).toBeGreaterThan(0);
  });

  it('attach restores transcript after close', async () => {
    const root = tmpRoot();
    const bridge = createNodeFileBridge(root);
    const store = openSessionStore(root, bridge);
    const session = await createSession(store, '/work', BACKGROUND_CONTEXT);
    const id = session.metadata.id;
    await session.mutate(async (mutator) => {
      await mutator.commit(
        [
          {
            kind: 'entry',
            entry: {
              id: 'e-hello',
              parentId: null,
              type: 'message',
              message: {
                role: 'user',
                content: [{ type: 'text', text: 'hello' }],
                timestamp: Date.now(),
              },
            },
          },
        ],
        BACKGROUND_CONTEXT,
      );
    }, BACKGROUND_CONTEXT);
    await session.close(BACKGROUND_CONTEXT);

    const store2 = openSessionStore(root, createNodeFileBridge(root));
    const attached = await attachSession(store2, id, BACKGROUND_CONTEXT);
    openSessions.push(attached);
    const entries = await attached.findEntries(undefined, BACKGROUND_CONTEXT);
    expect(JSON.stringify(entries)).toContain('hello');
  });

  it('writes jq-inspectable JSONL under the sessions root', async () => {
    const root = tmpRoot();
    const store = openSessionStore(root, createNodeFileBridge(root));
    const session = await createSession(store, '/work', BACKGROUND_CONTEXT);
    openSessions.push(session);
    const jsonlFiles: string[] = [];
    const walk = (dir: string): void => {
      for (const name of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, name.name);
        if (name.isDirectory()) walk(full);
        else if (name.name.endsWith('.jsonl')) jsonlFiles.push(full);
      }
    };
    walk(root);
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
});

describe('mutation serialization (issue #14, slice D)', () => {
  it('loses no writes under concurrent mutates', async () => {
    const root = tmpRoot();
    const store = openSessionStore(root, createNodeFileBridge(root));
    const session = await createSession(store, '/work', BACKGROUND_CONTEXT);
    openSessions.push(session);
    const writers = Array.from({ length: 10 }, (_, i) =>
      session.mutate(async (mutator) => {
        await mutator.commit(
          [
            {
              kind: 'entry',
              entry: {
                id: `e-concurrent-${i}`,
                parentId: null,
                type: 'message',
                message: {
                  role: 'user',
                  content: [{ type: 'text', text: `writer ${i}` }],
                  timestamp: Date.now(),
                },
              },
            },
          ],
          BACKGROUND_CONTEXT,
        );
      }, BACKGROUND_CONTEXT),
    );
    await Promise.all(writers);
    const entries = await session.findEntries(undefined, BACKGROUND_CONTEXT);
    const texts = entries.map((entry) => JSON.stringify(entry));
    for (let i = 0; i < 10; i += 1) {
      expect(texts.some((text) => text.includes(`writer ${i}`))).toBe(true);
    }
    const seqs = entries.map((entry) => entry.seq);
    expect(new Set(seqs).size).toBe(seqs.length);
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

// Lock wiring (issue #118): create/attach acquire, close releases.
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

  it('acquires the lock on create and releases it on close', async () => {
    const root = tmpRoot();
    const store = openSessionStore(root, createNodeFileBridge(root));
    const session = await createSession(store, '/work', BACKGROUND_CONTEXT);
    const lockPath = join(root, session.metadata.id, 'lock.json');
    expect(existsSync(lockPath)).toBe(true);
    await session.close(BACKGROUND_CONTEXT);
    expect(existsSync(lockPath)).toBe(false);
  });

  it('acquires the lock on attach and releases it on close', async () => {
    const root = tmpRoot();
    const store = openSessionStore(root, createNodeFileBridge(root));
    const session = await createSession(store, '/work', BACKGROUND_CONTEXT);
    const id = session.metadata.id;
    await session.close(BACKGROUND_CONTEXT);
    const attached = await attachSession(store, id, BACKGROUND_CONTEXT);
    const lockPath = join(root, id, 'lock.json');
    expect(existsSync(lockPath)).toBe(true);
    await attached.close(BACKGROUND_CONTEXT);
    expect(existsSync(lockPath)).toBe(false);
  });

  it('refuses a second attach while a live holder exists, naming the pid', async () => {
    const root = tmpRoot();
    const store = openSessionStore(root, createNodeFileBridge(root));
    const session = await createSession(store, '/work', BACKGROUND_CONTEXT);
    const id = session.metadata.id;
    await session.close(BACKGROUND_CONTEXT);
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
    const store = openSessionStore(root, createNodeFileBridge(root));
    const session = await createSession(store, '/work', BACKGROUND_CONTEXT);
    const id = session.metadata.id;
    await session.close(BACKGROUND_CONTEXT);
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
      await attached.close(BACKGROUND_CONTEXT);
    } finally {
      kill.mockRestore();
    }
    expect(existsSync(join(root, id, 'lock.json'))).toBe(false);
  });
});
