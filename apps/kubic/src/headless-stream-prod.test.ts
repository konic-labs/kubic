// Request options on the headless lane: the merged
// `[model]` tuning — with the run's role layered over it — becomes the
// lane's `settings.stream`, observed at the faux provider's own request
// options. Full headless runs on injected faux models; temp sessions root
// and workspace, env restored after each test.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  type MutableModels,
} from '../../../packages/agent/src/pi-boundary.js';
import { NodeExecutionEnv } from '../../../packages/exec/src/env.js';
import { runHeadlessPrompt } from './headless-run.js';

const made: string[] = [];

function tmp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  made.push(dir);
  return dir;
}

const seen: Array<Record<string, unknown> | undefined> = [];

beforeEach(() => {
  vi.stubEnv('KUBIC_NO_NOTICE', '1');
  seen.length = 0;
});

afterEach(() => {
  vi.unstubAllEnvs();
  for (const dir of made.splice(0))
    rmSync(dir, { recursive: true, force: true });
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
    const ws = tmp('stream-model-ws-');
    const result = await runHeadlessPrompt(
      'hi',
      {},
      {
        sessionsRoot: tmp('stream-model-sessions-'),
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
    const ws = tmp('stream-role-ws-');
    writeRoleDoc(ws, 'reader');
    const result = await runHeadlessPrompt(
      'hi',
      { role: 'reader' },
      {
        sessionsRoot: tmp('stream-role-sessions-'),
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
    const ws = tmp('stream-plain-ws-');
    const result = await runHeadlessPrompt(
      'hi',
      {},
      {
        sessionsRoot: tmp('stream-plain-sessions-'),
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
