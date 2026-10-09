// Request options on the headless lane: the merged
// `[model]` tuning — with the run's role layered over it — becomes the
// lane's `settings.stream`, observed at the faux provider's own request
// options. Full headless runs on injected faux models; temp sessions root
// and workspace, env restored after each test.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  type MutableModels,
} from '@kubic/agent/pi-boundary';
import { NodeExecutionEnv } from '@kubic/exec/env';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { tempDir } from '../../../../test/temp-dir.js';
import { runHeadlessPrompt } from '../../src/run/command.js';

const seen: Array<Record<string, unknown> | undefined> = [];

beforeEach(() => {
  vi.stubEnv('KUBIC_NO_NOTICE', '1');
  seen.length = 0;
});

afterEach(() => {
  vi.unstubAllEnvs();
});

function capturingModels(): MutableModels {
  const faux = fauxProvider({
    provider: 'faux',
    models: [{ id: 'echo', contextWindow: 100000 }],
  });
  faux.setResponses([
    (_context, options) => {
      seen.push({ ...(options as Record<string, unknown>) });
      return fauxAssistantMessage('done');
    },
  ]);
  const models = createModels();
  models.setProvider(faux.provider);
  return models;
}

function writeRoleDoc(ws: string, name: string): void {
  const dir = join(ws, '.kubic', 'roles');
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, `${name}.md`),
    `---\nrole: ${name}\ntools: [read, ls, find, grep]\nfilesystem: read\nshell: false\nnetwork: none\ngit: false\ncredentials: none\n---\n\n# ${name}\n\n## Prompt\n\nYou are a reader.\n`,
  );
}

describe('headless stream tuning', () => {
  it('hands the [model] tuning to the lane as settings.stream', async () => {
    const ws = tempDir('stream-model-ws-');
    const result = await runHeadlessPrompt(
      'hi',
      {},
      {
        sessionsRoot: tempDir('stream-model-sessions-'),
        env: new NodeExecutionEnv(ws),
        models: capturingModels(),
        model: { provider: 'faux', id: 'echo' },
        warn: () => undefined,
        streamTuning: {
          model: {
            timeoutMs: 60000,
            maxRetries: 5,
            maxRetryDelayMs: 10000,
            cacheRetention: 'long',
          },
        },
      },
    );
    expect(result.terminus).toBe('completed');
    expect(seen.length).toBeGreaterThan(0);
    expect(seen[0]).toMatchObject({
      timeoutMs: 60000,
      maxRetries: 5,
      maxRetryDelayMs: 10000,
      cacheRetention: 'long',
    });
  });

  it('layers the run role over [model] per key', async () => {
    const ws = tempDir('stream-role-ws-');
    writeRoleDoc(ws, 'reader');
    const result = await runHeadlessPrompt(
      'hi',
      { role: 'reader' },
      {
        sessionsRoot: tempDir('stream-role-sessions-'),
        env: new NodeExecutionEnv(ws),
        models: capturingModels(),
        model: { provider: 'faux', id: 'echo' },
        warn: () => undefined,
        roles: { cwd: ws, trusted: true },
        streamTuning: {
          model: { timeoutMs: 60000, maxRetries: 5 },
          roles: { reader: { maxRetries: 1 } },
        },
      },
    );
    expect(result.terminus).toBe('completed');
    expect(seen.length).toBeGreaterThan(0);
    expect(seen[0]).toMatchObject({ timeoutMs: 60000, maxRetries: 1 });
  });

  it('an untuned run sends no tuning keys (provider defaults stand)', async () => {
    const ws = tempDir('stream-plain-ws-');
    const result = await runHeadlessPrompt(
      'hi',
      {},
      {
        sessionsRoot: tempDir('stream-plain-sessions-'),
        env: new NodeExecutionEnv(ws),
        models: capturingModels(),
        model: { provider: 'faux', id: 'echo' },
        warn: () => undefined,
      },
    );
    expect(result.terminus).toBe('completed');
    expect(seen.length).toBeGreaterThan(0);
    for (const key of [
      'timeoutMs',
      'maxRetries',
      'maxRetryDelayMs',
      'cacheRetention',
    ]) {
      expect(seen[0]).not.toHaveProperty(key);
    }
  });
});
