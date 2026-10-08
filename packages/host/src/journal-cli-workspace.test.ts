// A session journal's relative paths belong to
// the workspace the session recorded, never to whatever cwd `kubic undo`
// happens to run in. The bare fallback considers only sessions recorded
// for the current workspace; any session store resolves its root from the
// recorded cwd; a vanished recorded cwd is a named refusal.
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createNodeFileBridge } from '../../exec/src/file-bridge.js';
import { FileJournalStore } from '../../exec/src/journal.js';
import {
  createSession,
  openSessionStore,
} from '../../worker/src/lane/session-store.js';
import { BACKGROUND_CONTEXT } from '../../worker/src/pi-boundary.js';
import { type JournalRequest, runJournalCommand } from './journal-cli.js';

const made: string[] = [];

afterEach(() => {
  for (const dir of made.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

function mkTmp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  made.push(dir);
  return dir;
}

async function recordSession(
  sessionsRoot: string,
  id: string,
  cwd: string,
): Promise<void> {
  const store = openSessionStore(
    sessionsRoot,
    createNodeFileBridge(sessionsRoot),
  );
  const session = await createSession(store, { id, cwd }, BACKGROUND_CONTEXT);
  await session.release(BACKGROUND_CONTEXT);
}

function journalOf(sessionsRoot: string, id: string): FileJournalStore {
  return new FileJournalStore(join(sessionsRoot, id, 'journal'));
}

function seedWrite(
  sessionsRoot: string,
  id: string,
  path: string,
  before: string | null,
  after: string | null,
  mtime?: Date,
): void {
  journalOf(sessionsRoot, id).append({
    path,
    op: after === null ? 'delete' : before === null ? 'create' : 'write',
    before,
    after,
    bytesDelta: 0,
    sessionId: id,
    agentId: 'root',
    toolCallId: 'call-1',
    timestamp: 1_700_000_000_000,
  });
  if (mtime !== undefined) {
    const idx = join(sessionsRoot, id, 'journal', 'index.jsonl');
    utimesSync(idx, mtime, mtime);
  }
}

async function run(
  request: JournalRequest,
  deps: { root: string; sessionsRoot: string },
): Promise<{ code: number; lines: string[]; errs: string[] }> {
  const lines: string[] = [];
  const errs: string[] = [];
  const code = (
    await runJournalCommand(request, {
      ...deps,
      out: (l) => lines.push(l),
      err: (l) => errs.push(l),
    })
  ).exitCode;
  return { code, lines, errs };
}

// Two projects, A and B, each with a recorded session. B's journal is the
// newer one by mtime — the pre fallback picked it from anywhere.
async function twoProjects() {
  const sessionsRoot = mkTmp('sr362-');
  const wsA = mkTmp('wsA362-');
  const wsB = mkTmp('wsB362-');
  await recordSession(sessionsRoot, 'sess-a', wsA);
  await recordSession(sessionsRoot, 'sess-b', wsB);
  mkdirSync(join(wsA, 'src'));
  mkdirSync(join(wsB, 'src'));
  writeFileSync(join(wsA, 'src', 'index.ts'), 'A-after\n');
  writeFileSync(join(wsB, 'src', 'index.ts'), 'B-own\n');
  seedWrite(
    sessionsRoot,
    'sess-a',
    'src/index.ts',
    'A-before\n',
    'A-after\n',
    new Date('2026-01-01T00:00:00Z'),
  );
  // The delete hazard: A deleted `gone.txt`; B has no such file.
  seedWrite(sessionsRoot, 'sess-a', 'gone.txt', 'A-pre-image\n', null);
  utimesSync(
    join(sessionsRoot, 'sess-a', 'journal', 'index.jsonl'),
    new Date('2026-01-01T00:00:00Z'),
    new Date('2026-01-01T00:00:00Z'),
  );
  seedWrite(
    sessionsRoot,
    'sess-b',
    'b-only.txt',
    'b1\n',
    'b2\n',
    new Date('2026-01-02T00:00:00Z'),
  );
  return { sessionsRoot, wsA, wsB };
}

describe('journal CLI workspace binding', () => {
  it('bare diff from A shows only A’s session even when B’s journal is newer', async () => {
    const { sessionsRoot, wsA } = await twoProjects();
    const { code, lines, errs } = await run(
      { command: 'diff' },
      { root: wsA, sessionsRoot },
    );
    expect(code).toBe(0);
    const text = lines.join('\n');
    expect(text).toContain('src/index.ts');
    expect(text).not.toContain('b-only.txt');
    expect(errs).toEqual([
      `info: session: sess-a (latest session journal for this workspace) — workspace ${wsA}`,
    ]);
  });

  it('bare diff from a subdirectory of A still resolves A’s session', async () => {
    const { sessionsRoot, wsA } = await twoProjects();
    const { lines } = await run(
      { command: 'diff' },
      { root: join(wsA, 'src'), sessionsRoot },
    );
    expect(lines.join('\n')).toContain('src/index.ts');
  });

  it('undo --force from B with no flags never selects A’s journal; B is byte-identical', async () => {
    const sessionsRoot = mkTmp('sr362-');
    const wsA = mkTmp('wsA362-');
    const wsB = mkTmp('wsB362-');
    await recordSession(sessionsRoot, 'sess-a', wsA);
    mkdirSync(join(wsB, 'src'));
    writeFileSync(join(wsB, 'src', 'index.ts'), 'B-own\n');
    seedWrite(sessionsRoot, 'sess-a', 'src/index.ts', 'A-before\n', 'B-own\n');
    seedWrite(sessionsRoot, 'sess-a', 'gone.txt', 'A-pre-image\n', null);
    const { code, lines } = await run(
      { command: 'undo', force: true },
      { root: wsB, sessionsRoot },
    );
    expect(code).toBe(0);
    expect(lines).toEqual(['nothing to undo']);
    expect(readFileSync(join(wsB, 'src', 'index.ts'), 'utf8')).toBe('B-own\n');
    // The delete-entry hazard: A's pre-image never materializes in B.
    expect(existsSync(join(wsB, 'gone.txt'))).toBe(false);
  });

  it('undo --session A from B restores under A’s recorded workspace only', async () => {
    const { sessionsRoot, wsA, wsB } = await twoProjects();
    const { code, errs } = await run(
      { command: 'undo', session: 'sess-a', force: true },
      { root: wsB, sessionsRoot },
    );
    expect(code).toBe(0);
    expect(errs).toContain(`info: session: sess-a — workspace ${wsA}`);
    expect(readFileSync(join(wsA, 'src', 'index.ts'), 'utf8')).toBe(
      'A-before\n',
    );
    expect(readFileSync(join(wsA, 'gone.txt'), 'utf8')).toBe('A-pre-image\n');
    // B untouched: same bytes, no materialized pre-image.
    expect(readFileSync(join(wsB, 'src', 'index.ts'), 'utf8')).toBe('B-own\n');
    expect(existsSync(join(wsB, 'gone.txt'))).toBe(false);
  });

  it('a session whose recorded workspace is gone is a named refusal, nothing written', async () => {
    const sessionsRoot = mkTmp('sr362-');
    const gone = mkTmp('wsGone362-');
    const wsB = mkTmp('wsB362-');
    await recordSession(sessionsRoot, 'sess-g', gone);
    seedWrite(sessionsRoot, 'sess-g', 'gone.txt', 'pre\n', null);
    seedWrite(sessionsRoot, 'sess-g', 'a.txt', 'a1\n', 'a2\n');
    rmSync(gone, { recursive: true, force: true });
    for (const command of ['undo', 'status'] as const) {
      const { code, lines, errs } = await run(
        { command, session: 'sess-g', force: true } as JournalRequest,
        { root: wsB, sessionsRoot },
      );
      expect(code).toBe(2);
      expect(lines).toEqual([]);
      expect(errs.join('\n')).toContain(
        `session sess-g: recorded workspace ${gone} no longer exists`,
      );
    }
    expect(existsSync(gone)).toBe(false);
    expect(existsSync(join(wsB, 'gone.txt'))).toBe(false);
    expect(existsSync(join(wsB, 'a.txt'))).toBe(false);
  });

  it('a session journal with no recorded workspace refuses undo by name', async () => {
    const sessionsRoot = mkTmp('sr362-');
    const wsB = mkTmp('wsB362-');
    seedWrite(sessionsRoot, 'sess-x', 'gone.txt', 'pre\n', null);
    const { code, errs } = await run(
      { command: 'undo', session: 'sess-x', force: true },
      { root: wsB, sessionsRoot },
    );
    expect(code).toBe(2);
    expect(errs.join('\n')).toContain('session sess-x: no recorded workspace');
    expect(existsSync(join(wsB, 'gone.txt'))).toBe(false);
  });

  it('with no session for the cwd, the bare command prints the no-journal hint', async () => {
    const { sessionsRoot } = await twoProjects();
    const elsewhere = mkTmp('wsC362-');
    const { code, lines, errs } = await run(
      { command: 'diff' },
      { root: elsewhere, sessionsRoot },
    );
    expect(code).toBe(0);
    expect(lines).toEqual(['no changes']);
    expect(errs).toEqual([
      `info: no journal under ${join(elsewhere, '.kubic', 'journal')} and none under the sessions root (${sessionsRoot}) — start a run or pass --session`,
    ]);
  });

  it('--json for diff, undo, log and status names the resolved session and root', async () => {
    const { sessionsRoot, wsA, wsB } = await twoProjects();
    const diff = await run(
      { command: 'diff', json: true },
      { root: wsA, sessionsRoot },
    );
    const diffDoc = JSON.parse(diff.lines.join('\n'));
    expect(diffDoc.session).toBe('sess-a');
    expect(diffDoc.root).toBe(wsA);
    expect(diffDoc.changes.map((c: { path: string }) => c.path)).toContain(
      'src/index.ts',
    );
    expect(diff.errs).toEqual([]);

    const log = await run(
      { command: 'log', json: true, session: 'sess-a' },
      { root: wsB, sessionsRoot },
    );
    const logDoc = JSON.parse(log.lines.join('\n'));
    expect(logDoc).toMatchObject({ session: 'sess-a', root: wsA });
    expect(logDoc.entries).toHaveLength(2);

    const status = await run(
      { command: 'status', json: true },
      { root: wsA, sessionsRoot },
    );
    expect(JSON.parse(status.lines.join('\n'))).toMatchObject({
      session: 'sess-a',
      root: wsA,
      entries: 2,
    });

    const undo = await run(
      { command: 'undo', json: true, dryRun: true },
      { root: wsA, sessionsRoot },
    );
    expect(JSON.parse(undo.lines.join('\n'))).toMatchObject({
      session: 'sess-a',
      root: wsA,
      dryRun: true,
    });

    // A workspace store (no session) reports session null and the cwd.
    const plain = mkTmp('wsP362-');
    const none = await run(
      { command: 'status', json: true },
      { root: plain, sessionsRoot },
    );
    expect(JSON.parse(none.lines.join('\n'))).toMatchObject({
      session: null,
      root: plain,
    });
  });
});

// Read-time retention and undo are cross-process hazards. A live
// run appends to its journal while `kubic log --session S` rewrites it (the
// line it appended is dropped by the rename, and the sweep deletes the blobs
// it just wrote), and `kubic undo --session S` restores files the run is
// writing. The session lock is the shipped liveness view: a live holder makes
// the reader skip its self-heal (with a notice) and makes undo refuse by name
// until --force.
describe('journal commands step aside for a live session', () => {
  function liveLock(sessionsRoot: string, id: string): void {
    // A live pid — this process — is what `sessionLockIsLive` probes for.
    writeFileSync(
      join(sessionsRoot, id, 'lock.json'),
      JSON.stringify({ pid: process.pid, startedAt: Date.now() }),
    );
  }

  async function logSession(
    sessionsRoot: string,
    id: string,
    root: string,
  ): Promise<{ code: number; lines: string[]; errs: string[] }> {
    const lines: string[] = [];
    const errs: string[] = [];
    const code = (
      await runJournalCommand(
        { command: 'log', session: id },
        {
          root,
          sessionsRoot,
          retentionDays: 1,
          out: (l) => lines.push(l),
          err: (l) => errs.push(l),
        },
      )
    ).exitCode;
    return { code, lines, errs };
  }

  it('leaves a live session journal byte-identical, with a notice', async () => {
    const sessionsRoot = mkTmp('sr337-');
    const ws = mkTmp('ws337-');
    await recordSession(sessionsRoot, 'sess-live', ws);
    // seedWrite stamps entries at 1_700_000_000_000 — years older than the
    // 1-day window — so the self-heal WOULD drop it.
    seedWrite(sessionsRoot, 'sess-live', 'a.txt', null, 'a\n');
    const dir = join(sessionsRoot, 'sess-live', 'journal');
    const indexPath = join(dir, 'index.jsonl');
    const indexBefore = readFileSync(indexPath, 'utf8');
    const blobsBefore = readdirSync(join(dir, 'blobs')).sort();
    liveLock(sessionsRoot, 'sess-live');

    const live = await logSession(sessionsRoot, 'sess-live', ws);
    expect(live.code).toBe(0);
    expect(readFileSync(indexPath, 'utf8')).toBe(indexBefore);
    expect(readdirSync(join(dir, 'blobs')).sort()).toEqual(blobsBefore);
    expect(live.errs.join('\n')).toMatch(
      /retention skipped: session 'sess-live' is attached by pid \d+/,
    );

    // Control: with the holder gone, the same read prunes as before.
    rmSync(join(sessionsRoot, 'sess-live', 'lock.json'));
    const free = await logSession(sessionsRoot, 'sess-live', ws);
    expect(free.code).toBe(0);
    expect(free.errs.join('\n')).not.toMatch(/retention skipped/);
    expect(readFileSync(indexPath, 'utf8')).not.toBe(indexBefore);
  });

  it('refuses to undo under a live session unless --force', async () => {
    const sessionsRoot = mkTmp('sr337u-');
    const ws = mkTmp('ws337u-');
    await recordSession(sessionsRoot, 'sess-busy', ws);
    writeFileSync(join(ws, 'a.txt'), 'v1\n');
    seedWrite(sessionsRoot, 'sess-busy', 'a.txt', 'v1\n', 'v2\n');
    writeFileSync(join(ws, 'a.txt'), 'v2\n');
    liveLock(sessionsRoot, 'sess-busy');

    const refused = await run(
      { command: 'undo', session: 'sess-busy' },
      { root: ws, sessionsRoot },
    );
    expect(refused.code).toBe(1);
    expect(refused.errs.join('\n')).toMatch(
      /attached by pid \d+ — refusing to undo under a live run \(pass --force to override\)/,
    );
    // Nothing was restored, and nothing was journaled.
    expect(readFileSync(join(ws, 'a.txt'), 'utf8')).toBe('v2\n');
    expect(journalOf(sessionsRoot, 'sess-busy').entries()).toHaveLength(1);

    const forced = await run(
      { command: 'undo', session: 'sess-busy', force: true },
      { root: ws, sessionsRoot },
    );
    expect(forced.code).toBe(0);
    expect(readFileSync(join(ws, 'a.txt'), 'utf8')).toBe('v1\n');
  });
});
