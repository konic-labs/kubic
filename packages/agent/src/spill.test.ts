// Session-scoped spill files: the sink writes inside the
// session directory, so `kubic sessions prune` — one recursive
// `bridge.remove(<sessionDir>)` per candidate
// (`deleteSessionPruneCandidates`, host/src/sessions-prune.ts) — takes the
// spills with it. Nothing lands in the workspace (where the end-of-run sweep
// would journal it) or in $TMPDIR (which nothing would clean).

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { createNodeFileBridge } from '@kubic/exec/file-bridge';
import { describe, expect, it } from 'vitest';
import { tempDir } from '../../../test/temp-dir.js';
import { createSessionSpillSink, SPILL_DIR_NAME } from './spill.js';

describe('session spill sink', () => {
  it('writes the full stream inside the session directory, 0600, in order', () => {
    const sessionDir = tempDir('spill-session-');
    const sink = createSessionSpillSink(sessionDir);
    const first = sink.write('stdout', 'head\ntail\n');
    const second = sink.write('stderr', 'boom\n');
    expect(first.startsWith(join(sessionDir, SPILL_DIR_NAME))).toBe(true);
    expect(second.startsWith(join(sessionDir, SPILL_DIR_NAME))).toBe(true);
    expect(first).not.toBe(second);
    expect(readFileSync(first, 'utf8')).toBe('head\ntail\n');
    expect(readFileSync(second, 'utf8')).toBe('boom\n');
    const names = readdirSync(join(sessionDir, SPILL_DIR_NAME));
    expect(names).toEqual([
      `0001-stdout-${process.pid}.log`,
      `0002-stderr-${process.pid}.log`,
    ]);
    // A command's output can carry secrets: the spill is never wider than
    // the session directory it lives in.
    expect(statSync(first).mode & 0o777).toBe(0o600);
  });

  it('never reuses a path a previous sink returned (a resumed session)', () => {
    const sessionDir = tempDir('spill-resume-');
    const first = createSessionSpillSink(sessionDir);
    const before = first.write('stdout', 'first run\n');
    // A resumed session builds a NEW sink over the same directory; its first
    // write must not truncate the file an earlier tool result still names.
    const second = createSessionSpillSink(sessionDir);
    const after = second.write('stdout', 'second run\n');
    expect(after).not.toBe(before);
    expect(readFileSync(before, 'utf8')).toBe('first run\n');
    expect(readFileSync(after, 'utf8')).toBe('second run\n');
  });

  it('goes away with the session: the prune removes the directory it lives in', () => {
    const sessionDir = tempDir('spill-prune-');
    const workspace = tempDir('spill-ws-');
    const sink = createSessionSpillSink(sessionDir);
    const spillPath = sink.write('stdout', 'x'.repeat(10));
    expect(statSync(spillPath).isFile()).toBe(true);
    // The session prune's whole effect on a candidate directory: one
    // recursive remove of the session dir.
    createNodeFileBridge('/').remove(sessionDir, true, true);
    expect(() => statSync(sessionDir)).toThrow();
    expect(() => statSync(spillPath)).toThrow();
    // Never in the workspace, never in a temp dir of its own.
    expect(readdirSync(workspace)).toEqual([]);
  });
});
