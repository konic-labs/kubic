// `data_policy` on the live path. A tool reads a file holding a secret:
// under "redact" the session stores it redacted (the journal is not
// involved: nothing was written); under "redact-model" the model never reads
// it either, and the run names the redaction. Faux provider only.
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  attachSession,
  openSessionStore,
} from '@kubic/agent/lane/session-store';
import {
  entriesToTranscript,
  readSessionEntries,
} from '@kubic/agent/lane/transcript';
import {
  BACKGROUND_CONTEXT,
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from '@kubic/agent/pi-boundary';
import { fauxToolUse } from '@kubic/agent/test-support/lane-harness';
import { NodeExecutionEnv } from '@kubic/exec/env';
import { createNodeFileBridge } from '@kubic/exec/file-bridge';
import { resolveEffectivePolicy } from '@kubic/host/policy';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { tempDir } from '../../../../test/temp-dir.js';
import { runHeadlessPrompt } from '../../src/run/command.js';

const SECRET = 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY';

beforeEach(() => {
  vi.stubEnv('KUBIC_NO_NOTICE', '1');
});

afterEach(() => {
  vi.unstubAllEnvs();
});

async function readRun(policy: string) {
  const workspace = tempDir('dlp-ws-');
  writeFileSync(
    join(workspace, 'notes.txt'),
    `AWS_SECRET_ACCESS_KEY=${SECRET}\n`,
  );
  const sessionsRoot = tempDir('dlp-sessions-');
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  const seen: string[] = [];
  faux.setResponses([
    fauxToolUse([fauxToolCall('read', { path: 'notes.txt' })]),
    (context) => {
      seen.push(JSON.stringify(context.messages));
      return fauxAssistantMessage('done');
    },
  ]);
  const notices: string[] = [];
  const result = await runHeadlessPrompt(
    'read the notes',
    {},
    {
      sessionsRoot,
      models,
      env: new NodeExecutionEnv(workspace),
      modelPolicy: resolveEffectivePolicy([
        { layer: 'enterprise', policy: { data: { policy } } },
      ]).policy,
      notice: (line) => notices.push(line),
    },
  );
  expect(result.terminus).toBe('completed');
  const stored = readFileSync(
    join(sessionsRoot, result.sessionId, 'main.jsonl'),
    'utf8',
  );
  const store = openSessionStore(
    sessionsRoot,
    createNodeFileBridge(sessionsRoot),
  );
  const session = await attachSession(
    store,
    result.sessionId,
    BACKGROUND_CONTEXT,
  );
  const toolResult = entriesToTranscript(
    await readSessionEntries(session.storage, BACKGROUND_CONTEXT),
  ).find((item) => item.kind === 'tool-result');
  await session.release(BACKGROUND_CONTEXT);
  return { stored, seen: seen.join('\n'), notices, toolResult };
}

describe('data_policy', () => {
  it('"redact" stores what a tool read with its secrets redacted', async () => {
    const run = await readRun('redact');
    expect(run.stored).not.toContain(SECRET);
    expect(run.stored).toContain('AWS_SECRET_ACCESS_KEY=[redacted-secret]');
    // The model still read it in this process: only storage is scanned.
    expect(run.seen).toContain(SECRET);
    expect(run.notices).toContain(
      'data policy: 1 secret value(s) kept out of what the session stored',
    );
  });

  it('"redact-model" keeps the secret from the model too, and says so', async () => {
    const run = await readRun('redact-model');
    expect(run.seen).not.toContain(SECRET);
    expect(run.seen).toContain('AWS_SECRET_ACCESS_KEY=[redacted-secret]');
    expect(run.stored).not.toContain(SECRET);
    expect(run.toolResult).toMatchObject({
      kind: 'tool-result',
      name: 'read',
    });
    expect(run.notices).toContain(
      "data policy: 1 secret value(s) redacted from the read tool's output before the model read it",
    );
  });

  it('a value Kubic does not enforce changes nothing', async () => {
    const run = await readRun('no-external-training');
    expect(run.stored).toContain(SECRET);
    expect(
      run.notices.filter((line) => line.startsWith('data policy')),
    ).toEqual([]);
  });
});
