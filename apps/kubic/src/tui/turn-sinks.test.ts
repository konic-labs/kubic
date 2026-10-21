// A settled TUI turn is the interactive run end: the run-end hooks hear it
// with the turn's status, and a turn with no hooks runs none.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { tempDir } from '../../../../test/temp-dir.js';
import type { SessionBoot } from '../session/bootstrap.js';
import { turnSpans } from './turn-sinks.js';

function fakeBoot(workspace: string): SessionBoot {
  return {
    bridge: { appendFile: () => undefined },
    env: { cwd: workspace },
    liveModelRef: 'faux/faux-1',
  } as unknown as SessionBoot;
}

const SETTLED = {
  spans: [],
  startedAt: Date.now(),
  usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, costUsd: 0 },
  toolErrors: 0,
};

describe('turnSpans', () => {
  it('runs the run-end hooks when a turn settles', async () => {
    const workspace = tempDir('turn-sinks-');
    const sink = turnSpans(
      fakeBoot(workspace),
      's-tui',
      {
        hooks: [
          {
            event: 'runEnd',
            command: 'cat > end.json',
            timeoutMs: 5_000,
            layer: 'global',
          },
        ],
      },
      { transcript: [] },
    );
    sink?.write('', SETTLED);
    const end = join(workspace, 'end.json');
    await vi.waitFor(() => {
      expect(readFileSync(end, 'utf8')).toContain('"status":"completed"');
    });
    expect(JSON.parse(readFileSync(end, 'utf8'))).toMatchObject({
      event: 'runEnd',
      sessionId: 's-tui',
      model: 'faux/faux-1',
    });
    // The run is audited once it ends: wait for the row, so no write lands
    // after the workspace is removed.
    await vi.waitFor(() => {
      expect(
        readFileSync(join(workspace, '.kubic', 'audit', 'audit.jsonl'), 'utf8'),
      ).toContain('hook:runEnd');
    });
  });

  it('runs nothing without hooks', () => {
    const workspace = tempDir('turn-sinks-');
    turnSpans(fakeBoot(workspace), 's-tui', {}, { transcript: [] })?.write(
      '',
      SETTLED,
    );
    expect(existsSync(join(workspace, '.kubic'))).toBe(false);
  });
});
