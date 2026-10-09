// `kubic run` over a Pi built-in provider: with the provider's
// env key set and a `[model]` pin naming it, the run selects the BUILT-IN
// (its catalog entry, its auth from the env key). Zero network: the built-in
// keeps its id, catalog and auth, and only its stream is swapped for Pi's
// faux stream, so the model call is answered locally.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fauxAssistantMessage, fauxProvider } from '@kubic/agent/pi-boundary';
import { FakeExecutionEnv } from '@kubic/exec/test-support/fake-env';
import { assembleModels } from '@kubic/host/models';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runHeadlessPrompt } from '../../src/run/command.js';

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

describe('kubic run on a built-in provider', () => {
  it('selects the pinned built-in anthropic model when its key is set', async () => {
    const assembled = await assembleModels(
      tmpRoot('builtin-cwd-'),
      { ANTHROPIC_API_KEY: 'x' },
      { home: tmpRoot('builtin-home-') },
    );
    const builtin = assembled.models.getProvider('anthropic');
    if (builtin === undefined) throw new Error('anthropic not registered');
    const faux = fauxProvider({ provider: 'anthropic' });
    faux.setResponses([fauxAssistantMessage('built-in answered')]);
    assembled.models.setProvider({
      id: builtin.id,
      name: builtin.name,
      auth: builtin.auth,
      getModels: () => builtin.getModels(),
      stream: faux.provider.stream,
      streamSimple: faux.provider.streamSimple,
    });
    const result = await runHeadlessPrompt(
      'hello',
      {},
      {
        sessionsRoot: tmpRoot('builtin-root-'),
        env: new FakeExecutionEnv({}),
        models: assembled.models,
        // The `[model] provider="anthropic"` pin runtimeModelPin projects.
        model: { provider: 'anthropic', id: 'claude-sonnet-4-6' },
      },
    );
    expect(result.terminus).toBe('completed');
    expect(result.summary).toContain('built-in answered');
    expect(faux.state.callCount).toBe(1);
  });
});
