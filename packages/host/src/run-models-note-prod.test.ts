// `kubic run` over a broken models.json: the config refusal must reach the
// user on stderr (not only under --debug) instead of silently falling back
// to "no providers". Faux-free: the run ends at model selection, no network.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runHeadlessPrompt } from '../../../apps/kubic/src/headless-run.js';
import { FakeExecutionEnv } from '../../exec/src/env.js';

const made: string[] = [];

function tmpRoot(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  made.push(dir);
  return dir;
}

beforeEach(() => {
  vi.stubEnv('KUBIC_NO_NOTICE', '1');
});

afterEach(() => {
  vi.unstubAllEnvs();
  for (const dir of made.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

describe('kubic run surfaces the models.json note', () => {
  it('writes "models.json ignored: …" to the warning channel without --debug', async () => {
    const cwd = tmpRoot('models-note-');
    writeFileSync(join(cwd, 'models.json'), '{ not json');
    const warnings: string[] = [];
    const result = await runHeadlessPrompt(
      'hello',
      {},
      {
        sessionsRoot: tmpRoot('models-note-root-'),
        env: new FakeExecutionEnv({}),
        modelsCwd: cwd,
        warn: (line) => warnings.push(line),
      },
    );
    expect(result.terminus).toBe('provider_probe_failed');
    expect(
      warnings.some((line) => line.startsWith('models.json ignored:')),
    ).toBe(true);
  });

  it('keeps a successful load quiet without --debug', async () => {
    const cwd = tmpRoot('models-note-ok-');
    writeFileSync(
      join(cwd, 'models.json'),
      JSON.stringify({
        providers: [
          {
            id: 'fake',
            baseUrl: 'http://127.0.0.1:1/v1',
            api: 'openai-completions',
            models: [{ id: 'm' }],
          },
        ],
      }),
    );
    const warnings: string[] = [];
    await runHeadlessPrompt(
      'hello',
      { timeoutMs: 1 },
      {
        sessionsRoot: tmpRoot('models-note-root-'),
        env: new FakeExecutionEnv({}),
        modelsCwd: cwd,
        warn: (line) => warnings.push(line),
      },
    );
    expect(warnings.filter((line) => line.includes('models.json'))).toEqual([]);
  });
});
