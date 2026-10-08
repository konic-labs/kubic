// `kubic run --role x` with a prompt-less role document fails
// closed with the named refusal instead of booting an instruction-less
// role. Full headless run on the faux provider (zero network, zero paid
// tokens); temp dirs and env restored in afterEach.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createModels, fauxProvider } from '@kubic/agent/pi-boundary';
import { NodeExecutionEnv } from '@kubic/exec/env';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runHeadlessPrompt } from './headless-run.js';

const made: string[] = [];

function tmp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  made.push(dir);
  return dir;
}

beforeEach(() => {
  vi.stubEnv('KUBIC_NO_NOTICE', '1');
  vi.stubEnv('KUBIC_PROVIDER', 'faux');
});

afterEach(() => {
  vi.unstubAllEnvs();
  for (const dir of made.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

function models(): ReturnType<typeof createModels> {
  const catalog = createModels();
  const faux = fauxProvider({
    provider: 'faux',
    models: [{ id: 'echo', contextWindow: 100000 }],
  });
  catalog.setProvider(faux.provider);
  return catalog;
}

describe('run --role with a prompt-less document', () => {
  it('exits failed with the named refusal, never booting the lane', async () => {
    const sessionsRoot = tmp('kubic-role-prompt-sessions-');
    const ws = tmp('kubic-role-prompt-ws-');
    mkdirSync(join(ws, '.kubic', 'roles'), { recursive: true });
    writeFileSync(
      join(ws, '.kubic', 'roles', 'promptless.md'),
      '---\nrole: promptless\ntools: [read, ls, find, grep]\nfilesystem: read\nshell: false\nnetwork: none\ngit: false\ncredentials: none\n---\n\n# promptless\n\nJust prose, no prompt heading.\n',
    );
    const result = await runHeadlessPrompt(
      'do the thing',
      { role: 'promptless' },
      {
        sessionsRoot,
        env: new NodeExecutionEnv(ws),
        modelsCwd: ws,
        models: models(),
        model: { provider: 'faux', id: 'echo' },
        warn: () => undefined,
        roles: { cwd: ws, trusted: true },
      },
    );
    expect(result.terminus).toBe('failed');
    expect(result.summary).toContain(
      "role 'promptless' has no '## Prompt' section",
    );
  });
});
