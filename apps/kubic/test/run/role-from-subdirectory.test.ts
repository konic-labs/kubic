// `kubic run --role` from a subdirectory: the role resolves at the project
// root, so the run boots the root's `<root>/.kubic/roles/*.md` instead of
// failing unknown-role. Live headless run with the faux provider (zero network,
// zero paid tokens) over real temp dirs — the prod path resolves through the
// real FileBridge, so a fake bridge would not prove it.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  createModels,
  fauxAssistantMessage,
  fauxProvider,
} from '@kubic/agent/pi-boundary';
import { NodeExecutionEnv } from '@kubic/exec/env';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { tempDir } from '../../../../test/temp-dir.js';
import { runHeadlessPrompt } from '../../src/run/command.js';

beforeEach(() => {
  vi.stubEnv('KUBIC_NO_NOTICE', '1');
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('run --role resolves at the project root', () => {
  it('boots a root role document from a nested cwd', async () => {
    const home = tempDir('roles-subdir-home-');
    const root = tempDir('roles-subdir-repo-');
    // A repository: the walk stops here, so the nested cwd below still
    // resolves the root's documents.
    mkdirSync(join(root, '.git'), { recursive: true });
    mkdirSync(join(root, '.kubic', 'roles'), { recursive: true });
    writeFileSync(
      join(root, '.kubic', 'roles', 'scout.md'),
      '---\nrole: scout\ntools: [read, ls, find, grep]\nfilesystem: read\nshell: false\nnetwork: none\ngit: false\ncredentials: none\n---\n\n# scout\n\n## Prompt\n\nScout the objective.\n',
    );
    const sub = join(root, 'a', 'b');
    mkdirSync(sub, { recursive: true });
    const sessionsRoot = tempDir('roles-subdir-sessions-');
    const faux = fauxProvider();
    const models = createModels();
    models.setProvider(faux.provider);
    faux.setResponses([fauxAssistantMessage('scouted')]);
    const debug: string[] = [];
    const result = await runHeadlessPrompt(
      'scout it',
      { role: 'scout' },
      {
        sessionsRoot,
        models,
        env: new NodeExecutionEnv(sub),
        debug: (line: string) => debug.push(line),
        roles: { cwd: sub, trusted: true },
        skills: { homeDir: home, cwd: sub, trusted: false },
      },
    );
    expect(result.terminus).toBe('completed');
    expect(debug.join('\n')).toContain('[policy] role=scout');
  });
});
