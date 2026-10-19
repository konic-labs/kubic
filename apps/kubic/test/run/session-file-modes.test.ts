// Session state is private on the run path too: after a headless run every
// directory under the session is 0700 and every file 0600 — the transcript,
// the documents pi-durable creates by appending and by rewriting, the span
// artifact, the trajectory and the journal baseline. The store's own test
// pins a bare session; this one goes through the run's scrubbing bridge.
// Faux provider only: zero network, zero paid tokens.
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fauxAssistantMessage } from '@kubic/agent/pi-boundary';
import { NodeExecutionEnv } from '@kubic/exec/env';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { tempDir } from '../../../../test/temp-dir.js';
import { runHeadlessPrompt } from '../../src/run/command.js';
import { modelsWith } from '../fixtures/models.js';

beforeEach(() => {
  vi.stubEnv('KUBIC_NO_NOTICE', '1');
});

afterEach(() => {
  vi.unstubAllEnvs();
});

// Every entry under `dir`, with its mode, relative to `dir`.
function modesUnder(
  dir: string,
  prefix = '',
): Array<[string, number, boolean]> {
  const found: Array<[string, number, boolean]> = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    const info = statSync(path);
    const rel = `${prefix}${name}`;
    found.push([rel, info.mode & 0o777, info.isDirectory()]);
    if (info.isDirectory()) found.push(...modesUnder(path, `${rel}/`));
  }
  return found;
}

describe('session file modes on the run path', () => {
  it.skipIf(process.platform === 'win32')(
    'leaves every directory 0700 and every file 0600',
    async () => {
      const sessionsRoot = tempDir('session-modes-root-');
      const result = await runHeadlessPrompt(
        'hello',
        {},
        {
          sessionsRoot,
          models: modelsWith([fauxAssistantMessage('done')]),
          env: new NodeExecutionEnv(tempDir('session-modes-ws-')),
          warn: () => undefined,
        },
      );
      expect(result.terminus).toBe('completed');
      const entries = modesUnder(join(sessionsRoot, result.sessionId));
      const names = entries.map(([name]) => name);
      for (const expected of [
        'main.jsonl',
        'session.json',
        'spans.jsonl',
        'trajectory.json',
        'journal',
      ]) {
        expect(names).toContain(expected);
      }
      const loose = entries.filter(
        ([, mode, isDir]) => mode !== (isDir ? 0o700 : 0o600),
      );
      expect(loose).toEqual([]);
    },
  );
});
