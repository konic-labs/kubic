// `kubic diff / undo / log / status` CLI.

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  createSession,
  openSessionStore,
} from '@kubic/agent/lane/session-store';
import { BACKGROUND_CONTEXT } from '@kubic/agent/pi-boundary';
import { createNodeFileBridge } from '@kubic/exec/file-bridge';
import { FileJournalStore } from '@kubic/exec/journal';
import { disposeAllGitSandboxes } from '@kubic/exec/test-support/git-sandbox';
import { afterEach, describe, expect, it } from 'vitest';
import { tempDir } from '../../../../test/temp-dir.js';
import { setup } from '../test-support/journal-cli.js';
import { runJournalCommand } from './index.js';

afterEach(() => {
  disposeAllGitSandboxes();
});

// The default session-workspace lookup reads the durable session
// store's own metadata (`kubic.session` → listing meta), so a real session
// created by the store associates its journal with the workspace it recorded.
describe('journal CLI default session workspaces over the durable store', () => {
  it('finds the latest journal of a session the store recorded for this workspace', async () => {
    const sessionsRoot = tempDir('sr-');
    const root = tempDir('ws-');
    // The session ran in a subdirectory but declared the repo as its
    // workspace: `kubic diff` from the repo must still find it.
    const store = openSessionStore(
      sessionsRoot,
      createNodeFileBridge(sessionsRoot),
    );
    const session = await createSession(
      store,
      { cwd: join(root, 'pkg'), workspace: root },
      BACKGROUND_CONTEXT,
    );
    await session.release(BACKGROUND_CONTEXT);
    const journalDir = join(sessionsRoot, session.id, 'journal');
    new FileJournalStore(journalDir).append({
      path: 'durable.txt',
      op: 'write',
      before: 'd1\n',
      after: 'd2\n',
      bytesDelta: 0,
      sessionId: session.id,
      toolCallId: 'call-1',
      timestamp: 1700000000000,
    });

    // No injected sessionWorkspaces: the default lookup must read the
    // session's recorded cwd out of the durable store.
    const lines: string[] = [];
    const errs: string[] = [];
    const code = (
      await runJournalCommand(
        { command: 'diff' },
        {
          root,
          sessionsRoot,
          out: (line) => lines.push(line),
          err: (line) => errs.push(line),
        },
      )
    ).exitCode;
    expect(code).toBe(0);
    expect(errs[0]).toContain(`session: ${session.id}`);
    expect(lines.join('\n')).toContain('durable.txt');
  });
});

describe('journal CLI HEAD moves', () => {
  const MOVE_A = { head: 'a'.repeat(40), branch: 'main', stash: 0 };
  const MOVE_B = { head: 'b'.repeat(40), branch: 'feature', stash: 0 };

  function movedSetup(): {
    journalDir: string;
    root: string;
    lines: string[];
  } {
    const journalDir = tempDir('j-');
    const root = tempDir('ws-');
    writeFileSync(join(root, 'a.txt'), 'v2\n');
    const store = new FileJournalStore(journalDir);
    store.append({
      path: 'a.txt',
      op: 'write',
      before: 'v1\n',
      after: 'v2\n',
      bytesDelta: 0,
      sessionId: 's1',
      toolCallId: 'call-1',
      timestamp: 1700000000000,
    });
    store.append({
      path: '',
      op: 'marker',
      before: null,
      after: null,
      bytesDelta: 0,
      headFrom: MOVE_A,
      headTo: MOVE_B,
      sessionId: 's1',
      toolCallId: null,
      timestamp: 1700000001000,
      unattributed: true,
    });
    return { journalDir, root, lines: [] as string[] };
  }

  it('undo refuses without --force and names the HEAD move', async () => {
    const { journalDir, root, lines } = movedSetup();
    const deps = {
      journalDir,
      root,
      out: (l: string) => lines.push(l),
    };
    expect((await runJournalCommand({ command: 'undo' }, deps)).exitCode).toBe(
      1,
    );
    const text = lines.join('\n');
    expect(text).toContain('head-moved (skipped):');
    expect(text).toContain('a.txt');
    expect(text).toContain('feature@');
    // Nothing was written for the step.
    expect(readFileSync(join(root, 'a.txt'), 'utf8')).toBe('v2\n');
  });

  it('undo proceeds across the marker with --force', async () => {
    const { journalDir, root, lines } = movedSetup();
    const deps = {
      journalDir,
      root,
      out: (l: string) => lines.push(l),
    };
    expect(
      (await runJournalCommand({ command: 'undo', force: true }, deps))
        .exitCode,
    ).toBe(0);
    expect(lines.join('\n')).toContain('restored a.txt');
    expect(readFileSync(join(root, 'a.txt'), 'utf8')).toBe('v1\n');
  });

  it('status prints the warning; --json carries headMoves', async () => {
    const { journalDir, root, lines } = movedSetup();
    const deps = {
      journalDir,
      root,
      out: (l: string) => lines.push(l),
    };
    expect(
      (await runJournalCommand({ command: 'status' }, deps)).exitCode,
    ).toBe(0);
    expect(lines.join('\n')).toContain('head-moved:');
    const json: string[] = [];
    expect(
      (
        await runJournalCommand(
          { command: 'status', json: true },
          { ...deps, out: (l: string) => json.push(l) },
        )
      ).exitCode,
    ).toBe(0);
    const parsed = JSON.parse(json.join('\n')) as {
      headMoves: Array<{ from: unknown; to: unknown }>;
    };
    expect(parsed.headMoves).toEqual([{ from: MOVE_A, to: MOVE_B }]);
  });

  it('log renders the marker as a head-moved line', async () => {
    const { journalDir, root, lines } = movedSetup();
    expect(
      (
        await runJournalCommand(
          { command: 'log' },
          { journalDir, root, out: (l: string) => lines.push(l) },
        )
      ).exitCode,
    ).toBe(0);
    expect(lines.join('\n')).toContain('head-moved');
  });
});

describe('journal CLI diff path scope', () => {
  it('a scoped request shows only that path', async () => {
    const { journalDir, root } = setup();
    const store = new FileJournalStore(journalDir);
    store.append({
      path: 'b.txt',
      op: 'write',
      before: null,
      after: 'other\n',
      bytesDelta: 6,
      sessionId: 's1',
      toolCallId: 'call-2',
      timestamp: 1700000000001,
    });
    const lines: string[] = [];
    expect(
      (
        await runJournalCommand(
          { command: 'diff', path: 'b.txt' },
          { journalDir, root, out: (l: string) => lines.push(l) },
        )
      ).exitCode,
    ).toBe(0);
    const text = lines.join('\n');
    expect(text).toContain('b.txt');
    expect(text).not.toContain('a.txt');
  });
});

describe('journal CLI diff --stat', () => {
  function statSetup(): { journalDir: string; root: string } {
    const journalDir = tempDir('j-');
    const root = tempDir('ws-');
    const store = new FileJournalStore(journalDir);
    store.append({
      path: 'a.txt',
      op: 'write',
      before: 'v1\n',
      after: 'v2\ntail\n',
      bytesDelta: 5,
      sessionId: 's1',
      toolCallId: 'call-1',
      toolName: 'edit',
      turn: 3,
      timestamp: 1700000000000,
    });
    return { journalDir, root };
  }

  it('prints per-file counts with tool and turn instead of hunks', async () => {
    const { journalDir, root } = statSetup();
    const lines: string[] = [];
    expect(
      (
        await runJournalCommand(
          { command: 'diff', stat: true },
          { journalDir, root, out: (l: string) => lines.push(l) },
        )
      ).exitCode,
    ).toBe(0);
    // before v1\n vs after v2\ntail\n: -v1 +v2 +tail.
    expect(lines).toEqual(['a.txt +2 -1 edit, turn 3']);
  });

  it('diff and log --json carry toolName and turn', async () => {
    const { journalDir, root } = statSetup();
    const diff: string[] = [];
    await runJournalCommand(
      { command: 'diff', json: true },
      { journalDir, root, out: (l: string) => diff.push(l) },
    );
    const changes = (
      JSON.parse(diff.join('\n')) as {
        changes: Array<{ toolName?: string; turn?: number }>;
      }
    ).changes;
    expect(changes.map((c) => [c.toolName, c.turn])).toEqual([['edit', 3]]);
    const log: string[] = [];
    await runJournalCommand(
      { command: 'log', json: true },
      { journalDir, root, out: (l: string) => log.push(l) },
    );
    const entries = (
      JSON.parse(log.join('\n')) as {
        entries: Array<{ toolName?: string; turn?: number }>;
      }
    ).entries;
    expect(entries.map((e) => [e.toolName, e.turn])).toEqual([['edit', 3]]);
  });
});
