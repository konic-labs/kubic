// Write/edit safety on the node seam: mode preservation across tmp+rename,
// no lossy pre-image for binary files, journal intent before the rename.
import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  lstatSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { type FileSystem, NodeExecutionEnv } from '@kubic/exec/env';
import {
  applyUndo,
  captureBaseline,
  diffEntries,
  FileJournalStore,
  journalStatus,
  planUndo,
  reconcile,
} from '@kubic/exec/journal';
import { describe, expect, it } from 'vitest';
import { tempDir } from '../../../../test/temp-dir.js';
import { inv } from '../test-support/invocation.js';
import { PREIMAGE_CHUNK_BYTES, PREIMAGE_MAX_BYTES } from './atomic-file.js';
import { callOperation } from './registry.js';
import type { OpContext } from './types.js';

function setup(): { root: string; journal: FileJournalStore; c: OpContext } {
  const root = tempDir('ws-');
  const journal = new FileJournalStore(tempDir('j-'));
  const c: OpContext = {
    env: new NodeExecutionEnv(root),
    sessionId: 's1',
    agentId: 'root',
    toolCallId: 'call-1',
    journal,
  };
  return { root, journal, c };
}

const posix = process.platform !== 'win32';

// Every tmp the tmp+rename writer leaves behind, under any spelling.
function tmpNames(dir: string): string[] {
  return readdirSync(dir).filter((name) => name.includes('.kubic-tmp'));
}

describe('write/edit safety on the node seam', () => {
  it.runIf(posix)('write preserves an existing file mode', async () => {
    const { root, c } = setup();
    writeFileSync(join(root, 'run.sh'), '#!/bin/sh\n');
    chmodSync(join(root, 'run.sh'), 0o755);
    writeFileSync(join(root, 'secret'), 'a\n');
    chmodSync(join(root, 'secret'), 0o600);
    await callOperation(
      'write',
      { path: 'run.sh', content: 'echo\n' },
      inv(),
      c,
    );
    await callOperation('write', { path: 'secret', content: 'b\n' }, inv(), c);
    expect(statSync(join(root, 'run.sh')).mode & 0o777).toBe(0o755);
    expect(statSync(join(root, 'secret')).mode & 0o777).toBe(0o600);
  });

  it.runIf(posix)('edit preserves an existing file mode', async () => {
    const { root, c } = setup();
    writeFileSync(join(root, 'run.sh'), 'echo a\n');
    chmodSync(join(root, 'run.sh'), 0o755);
    const out = await callOperation(
      'edit',
      { path: 'run.sh', oldText: 'a', newText: 'b' },
      inv(),
      c,
    );
    expect(out.ok).toBe(true);
    expect(statSync(join(root, 'run.sh')).mode & 0o777).toBe(0o755);
  });

  it('overwriting a binary file never records a lossy pre-image; undo refuses instead of mangling', async () => {
    const { root, journal, c } = setup();
    const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0xff, 0xfe, 0x00, 0x80]);
    writeFileSync(join(root, 'img.png'), bytes);
    await callOperation(
      'write',
      { path: 'img.png', content: 'text\n' },
      inv(),
      c,
    );
    const entry = journal.entries()[0];
    expect(entry?.op).toBe('write');
    // The recorded before-hash is the hash of the real bytes.
    expect(entry?.beforeHash).not.toBeNull();
    expect(entry === undefined ? 'x' : journal.readBefore(entry)).toBeNull();
    const result = applyUndo(journal, planUndo(journal, {}, root), root, {});
    expect(result.restored).toEqual([]);
    // A designed hash-only pre-image, not lost content.
    expect(entry?.beforeOmitted).toBe(true);
    expect(journalStatus(journal, root).corrupt).toBe(0);
    expect(diffEntries(journal, {})[0]?.corrupt).toBe(false);
    // Undo must not write U+FFFD-mangled content, nor delete the file.
    expect(readFileSync(join(root, 'img.png'), 'utf8')).toBe('text\n');
  });

  it('hashes an oversized pre-image in bounded chunks, never a file-sized buffer', async () => {
    const { root, journal, c } = setup();
    const original = Buffer.alloc(PREIMAGE_MAX_BYTES + 4096, 0x61);
    writeFileSync(join(root, 'big.txt'), original);
    const reads: number[] = [];
    const fs = Object.create(c.env.fs) as typeof c.env.fs;
    fs.readFileRange = (path: string, start: number, end: number) => {
      reads.push(end - start);
      return c.env.fs.readFileRange?.(path, start, end) ?? new Uint8Array();
    };
    const out = await callOperation(
      'write',
      { path: 'big.txt', content: 'new\n' },
      inv(),
      { ...c, env: { ...c.env, fs } },
    );
    expect(out.ok).toBe(true);
    expect(readFileSync(join(root, 'big.txt'), 'utf8')).toBe('new\n');
    // Bounded: several chunk-sized reads, never one the size of the file.
    expect(reads.length).toBeGreaterThan(1);
    expect(Math.max(...reads)).toBeLessThanOrEqual(PREIMAGE_CHUNK_BYTES);
    const entry = journal.entries()[0];
    expect(entry?.beforeOmitted).toBe(true);
    expect(entry?.beforeHash).toBe(
      createHash('sha256').update(original).digest('hex'),
    );
    expect(entry === undefined ? 'x' : journal.readBefore(entry)).toBeNull();
    // Hash-only is non-reversible: undo skips it, never inventing content.
    const plan = planUndo(journal, {}, root);
    expect(plan.nonReversible).toEqual(['big.txt']);
    const result = applyUndo(journal, plan, root, {});
    expect(result.restored).toEqual([]);
    expect(result.skipped).toEqual(['big.txt']);
    expect(result.skippedDetails[0]?.reason).toContain('no before-content');
    expect(journalStatus(journal, root).corrupt).toBe(0);
  });

  it('keeps a pre-image exactly at the bound reversible, and one byte over hash-only', async () => {
    const { root, journal, c } = setup();
    // Exactly at the bound: whole-file path, before-content recorded, undo
    // can restore it. This is the one off-by-one (`>` vs `>=`) that would
    // silently change reversibility.
    writeFileSync(join(root, 'at.txt'), Buffer.alloc(PREIMAGE_MAX_BYTES, 0x61));
    const at = await callOperation(
      'write',
      { path: 'at.txt', content: 'new\n' },
      inv(),
      c,
    );
    expect(at.ok).toBe(true);
    const atEntry = journal.entries()[0];
    expect(atEntry?.beforeOmitted).toBeUndefined();
    expect(
      atEntry === undefined ? 'x' : journal.readBefore(atEntry),
    ).not.toBeNull();
    expect(planUndo(journal, {}, root).nonReversible).toEqual([]);
    // One byte over: hash-only and non-reversible.
    writeFileSync(
      join(root, 'over.txt'),
      Buffer.alloc(PREIMAGE_MAX_BYTES + 1, 0x61),
    );
    const over = await callOperation(
      'write',
      { path: 'over.txt', content: 'new\n' },
      inv(),
      c,
    );
    expect(over.ok).toBe(true);
    const overEntry = journal.entries()[1];
    expect(overEntry?.beforeOmitted).toBe(true);
    expect(
      overEntry === undefined ? 'x' : journal.readBefore(overEntry),
    ).toBeNull();
    expect(planUndo(journal, {}, root).nonReversible).toEqual(['over.txt']);
  });

  it('records the journal intent before the rename: a failed journal leaves the file untouched', async () => {
    const { root, c } = setup();
    writeFileSync(join(root, 'a.txt'), 'old\n');
    const failing = {
      append: () => {
        throw new Error('disk full');
      },
    } as unknown as FileJournalStore;
    const out = await callOperation(
      'write',
      { path: 'a.txt', content: 'new\n' },
      inv(),
      { ...c, journal: failing },
    );
    expect(out.ok).toBe(false);
    expect(readFileSync(join(root, 'a.txt'), 'utf8')).toBe('old\n');
    expect(tmpNames(root)).toEqual([]);
    const edit = await callOperation(
      'edit',
      { path: 'a.txt', oldText: 'old', newText: 'new' },
      inv(),
      { ...c, journal: failing },
    );
    expect(edit.ok).toBe(false);
    expect(readFileSync(join(root, 'a.txt'), 'utf8')).toBe('old\n');
  });
});

// Tmp+rename must write THROUGH a symlink, not over it. The
// rename replaces the inode at the named path, so a symlinked target turned
// into a regular file and the link (plus the target's real content) was
// silently lost. A resolved target outside the workspace is refused
// instead, and a failed rename never leaves its tmp behind.
describe('write/edit symlink safety', () => {
  it.runIf(posix)(
    'edit through a symlink updates the target and keeps the link',
    async () => {
      const { root, journal, c } = setup();
      writeFileSync(join(root, 'real.md'), 'old\n');
      symlinkSync('real.md', join(root, 'link.md'));
      const out = await callOperation(
        'edit',
        { path: 'link.md', oldText: 'old', newText: 'new' },
        inv(),
        c,
      );
      expect(out.ok).toBe(true);
      expect(lstatSync(join(root, 'link.md')).isSymbolicLink()).toBe(true);
      expect(readFileSync(join(root, 'real.md'), 'utf8')).toBe('new\n');
      expect(tmpNames(root)).toEqual([]);
      // The journal names the file whose content changed,
      // so the sweep keys it like the walk does and undo restores the
      // target — see the two tests below.
      expect(journal.entries()[0]?.path).toBe('real.md');
    },
  );

  it.runIf(posix)(
    'a symlinked edit reconciles clean: no phantom write or delete at run end',
    async () => {
      const { root, journal, c } = setup();
      writeFileSync(join(root, 'real.md'), 'old\n');
      symlinkSync('real.md', join(root, 'link.md'));
      // Boot baseline: the walk skips symlinks, so it knows real.md only.
      const baseline = captureBaseline(root);
      const out = await callOperation(
        'edit',
        { path: 'link.md', oldText: 'old', newText: 'new' },
        inv(),
        c,
      );
      expect(out.ok).toBe(true);
      const added = reconcile(journal, baseline, root, {
        sessionId: 's1',
        timestamp: Date.now(),
      });
      // Before the journal keyed the resolved path this recorded two
      // phantoms: an unattributed `write real.md` (the target really
      // changed) and a `delete link.md` (the walk skips the link, so it
      // looked absent).
      expect(added).toBe(0);
      expect(journal.entries().map((e) => e.path)).toEqual(['real.md']);
    },
  );

  it.runIf(posix)(
    'undo of a symlinked edit restores the target and keeps the link',
    async () => {
      const { root, journal, c } = setup();
      writeFileSync(join(root, 'real.md'), 'old\n');
      symlinkSync('real.md', join(root, 'link.md'));
      const out = await callOperation(
        'edit',
        { path: 'link.md', oldText: 'old', newText: 'new' },
        inv(),
        c,
      );
      expect(out.ok).toBe(true);
      const result = applyUndo(journal, planUndo(journal, {}, root), root, {});
      expect(result.restored).toEqual(['real.md']);
      expect(readFileSync(join(root, 'real.md'), 'utf8')).toBe('old\n');
      expect(lstatSync(join(root, 'link.md')).isSymbolicLink()).toBe(true);
    },
  );

  it.runIf(posix)(
    'refuses an escape even when the workspace is spelled physically',
    async () => {
      // The cwd itself is reached through a link (macOS /tmp and /var), so
      // `realpathSync(cwd)` is a second spelling of the same workspace. A
      // path through it must not bypass the resolution: with the early
      // return on the lexical test it did, and the write landed outside.
      const real = tempDir('ws-real-');
      const link = join(tempDir('ws-link-'), 'ws');
      symlinkSync(real, link);
      const journal = new FileJournalStore(tempDir('j-'));
      const c: OpContext = {
        env: new NodeExecutionEnv(link),
        sessionId: 's1',
        agentId: 'root',
        toolCallId: 'call-1',
        journal,
      };
      const outside = tempDir('outside-');
      symlinkSync(outside, join(real, 'linkdir'));
      const out = await callOperation(
        'write',
        {
          path: join(realpathSync(link), 'linkdir', 'new.txt'),
          content: 'pwned\n',
        },
        inv(),
        c,
      );
      expect(out.ok).toBe(false);
      if (!out.ok) expect(out.error.code).toBe('symlink_escape');
      expect(existsSync(join(outside, 'new.txt'))).toBe(false);
      expect(journal.entries()).toEqual([]);
    },
  );

  it.runIf(posix)(
    'writes through the physical spelling of the workspace',
    async () => {
      const real = tempDir('ws-real-');
      const link = join(tempDir('ws-link-'), 'ws');
      symlinkSync(real, link);
      const journal = new FileJournalStore(tempDir('j-'));
      const c: OpContext = {
        env: new NodeExecutionEnv(link),
        sessionId: 's1',
        agentId: 'root',
        toolCallId: 'call-1',
        journal,
      };
      // Boot baseline: the file does not exist yet.
      const baseline = captureBaseline(link);
      const out = await callOperation(
        'write',
        { path: join(realpathSync(link), 'a.txt'), content: 'new\n' },
        inv(),
        c,
      );
      expect(out.ok).toBe(true);
      expect(readFileSync(join(real, 'a.txt'), 'utf8')).toBe('new\n');
      // Keyed the way the walk sees it, so the sweep stays quiet: a path the
      // sweep cannot key (the physical absolute) reads as an unattributed
      // create of a.txt instead.
      expect(journal.entries()[0]?.path).toBe('a.txt');
      expect(
        reconcile(journal, baseline, link, {
          sessionId: 's1',
          timestamp: Date.now(),
        }),
      ).toBe(0);
    },
  );

  it('does not resolve through a realpath failure that is not a missing component', async () => {
    const { root, c } = setup();
    writeFileSync(join(root, 'a.txt'), 'old\n');
    const written: string[] = [];
    const renamed: string[][] = [];
    // A seam whose realpath answers for the parent but fails the leaf with
    // EACCES: the resolution is UNKNOWN, so the writer must fall back to the
    // named path (and the seam's own confinement), never to a guessed
    // resolved one.
    const fake: FileSystem = {
      readFile: () => 'old\n',
      writeFile: (path) => {
        written.push(path);
      },
      rename: (from, to) => {
        renamed.push([from, to]);
      },
      listDir: () => [],
      stat: () => ({ isFile: true, isDirectory: false, size: 4, mode: 0o644 }),
      realpath: (path) => {
        if (path === 'a.txt') {
          throw Object.assign(new Error('denied'), { code: 'EACCES' });
        }
        return '/fake-root';
      },
      unlink: () => undefined,
    };
    const out = await callOperation(
      'write',
      { path: 'a.txt', content: 'new\n' },
      inv(),
      { ...c, env: { ...c.env, fs: fake } },
    );
    expect(out.ok).toBe(true);
    expect(written[0]).toMatch(/^a\.txt\.kubic-tmp-\d+-\d+$/);
    expect(renamed[0]?.[1]).toBe('a.txt');
  });

  it.runIf(posix)(
    'collects crash residue at its own tmp name before writing',
    async () => {
      const { root, c } = setup();
      writeFileSync(join(root, 'a.txt'), 'old\n');
      // Residue from a crashed run (another pid, so this writer never
      // overwrites it): without the sweep it lingers forever and the next
      // end-of-run sweep journals it as an unattributed create.
      writeFileSync(join(root, 'a.txt.kubic-tmp-4242-9'), 'stale\n');
      const out = await callOperation(
        'write',
        { path: 'a.txt', content: 'new\n' },
        inv(),
        c,
      );
      expect(out.ok).toBe(true);
      expect(readFileSync(join(root, 'a.txt'), 'utf8')).toBe('new\n');
      expect(tmpNames(root)).toEqual([]);
    },
  );

  it.runIf(posix)(
    'write through a symlink updates the target and keeps the link',
    async () => {
      const { root, c } = setup();
      writeFileSync(join(root, 'real.md'), 'old\n');
      symlinkSync('real.md', join(root, 'link.md'));
      const out = await callOperation(
        'write',
        { path: 'link.md', content: 'new\n' },
        inv(),
        c,
      );
      expect(out.ok).toBe(true);
      expect(lstatSync(join(root, 'link.md')).isSymbolicLink()).toBe(true);
      expect(readFileSync(join(root, 'real.md'), 'utf8')).toBe('new\n');
      expect(tmpNames(root)).toEqual([]);
    },
  );

  it.runIf(posix)(
    'refuses a symlink whose target escapes the workspace',
    async () => {
      const { root, journal, c } = setup();
      const outside = tempDir('outside-');
      writeFileSync(join(outside, 'secret.txt'), 'secret\n');
      symlinkSync(join(outside, 'secret.txt'), join(root, 'link.txt'));
      const out = await callOperation(
        'write',
        { path: 'link.txt', content: 'pwned\n' },
        inv(),
        c,
      );
      expect(out.ok).toBe(false);
      if (!out.ok) expect(out.error.code).toBe('symlink_escape');
      expect(readFileSync(join(outside, 'secret.txt'), 'utf8')).toBe(
        'secret\n',
      );
      expect(lstatSync(join(root, 'link.txt')).isSymbolicLink()).toBe(true);
      // Refused before the journal: nothing to undo.
      expect(journal.entries()).toEqual([]);
      expect(tmpNames(root)).toEqual([]);
    },
  );

  it.runIf(posix)(
    'refuses a write through a symlinked directory that escapes the workspace',
    async () => {
      const { root, c } = setup();
      const outside = tempDir('outside-');
      symlinkSync(outside, join(root, 'linkdir'));
      const out = await callOperation(
        'write',
        { path: 'linkdir/new.txt', content: 'pwned\n' },
        inv(),
        c,
      );
      expect(out.ok).toBe(false);
      if (!out.ok) expect(out.error.code).toBe('symlink_escape');
      // Nothing was created through the link, and the link is intact.
      expect(existsSync(join(outside, 'new.txt'))).toBe(false);
      expect(lstatSync(join(root, 'linkdir')).isSymbolicLink()).toBe(true);
      expect(tmpNames(root)).toEqual([]);
    },
  );

  it.runIf(posix)(
    'clears a stale tmp at its own name before writing it (pid reuse)',
    async () => {
      const { root, c } = setup();
      writeFileSync(join(root, 'a.txt'), 'old\n');
      const events: string[] = [];
      const fs = new Proxy(c.env.fs, {
        get: (target, prop, receiver) => {
          if (prop === 'unlink' || prop === 'writeFile') {
            return (path: string, ...rest: unknown[]) => {
              events.push(`${prop}:${path}`);
              const fn = Reflect.get(target, prop, receiver) as (
                p: string,
                ...r: unknown[]
              ) => unknown;
              return fn.call(receiver, path, ...rest);
            };
          }
          return Reflect.get(target, prop, receiver) as unknown;
        },
      });
      const out = await callOperation(
        'write',
        { path: 'a.txt', content: 'new\n' },
        inv(),
        { ...c, env: { ...c.env, fs } },
      );
      expect(out.ok).toBe(true);
      const [cleared, written] = events;
      expect(cleared).toMatch(/^unlink:.*\.kubic-tmp-\d+-\d+$/);
      const after = (event: string | undefined): string =>
        (event ?? '').slice((event ?? '').indexOf(':') + 1);
      expect(after(written)).toBe(after(cleared));
      expect(readFileSync(join(root, 'a.txt'), 'utf8')).toBe('new\n');
      expect(tmpNames(root)).toEqual([]);
    },
  );

  it.runIf(posix)(
    'a failed rename removes its tmp file instead of leaking it',
    async () => {
      const { root, journal, c } = setup();
      writeFileSync(join(root, 'a.txt'), 'old\n');
      const failingFs = new Proxy(c.env.fs, {
        get: (target, prop, receiver) => {
          if (prop === 'rename') {
            return () => {
              throw new Error('EXDEV: cross-device link');
            };
          }
          return Reflect.get(target, prop, receiver) as unknown;
        },
      });
      const out = await callOperation(
        'write',
        { path: 'a.txt', content: 'new\n' },
        inv(),
        { ...c, env: { ...c.env, fs: failingFs } },
      );
      expect(out.ok).toBe(false);
      expect(readFileSync(join(root, 'a.txt'), 'utf8')).toBe('old\n');
      expect(tmpNames(root)).toEqual([]);
      expect(journal.entries()).toHaveLength(1);
    },
  );
});
