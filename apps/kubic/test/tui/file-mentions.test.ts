// The `@` mention source on the real boot path — the workspace's
// files from the gitignore-aware walk (gitignored files are never offered),
// workspace-relative, cached for a short window. Faux provider; temp dirs
// cleaned up in afterEach.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createModels,
  fauxAssistantMessage,
  fauxProvider,
} from '@kubic/agent/pi-boundary';
import { NodeExecutionEnv } from '@kubic/exec/env';
import { afterEach, describe, expect, it } from 'vitest';
import {
  bootTuiLane,
  FILE_LIST_TTL_MS,
  workspaceFileLister,
} from '../../src/tui/boot.js';

const made: string[] = [];

function tmpRoot(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  made.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of made.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

function workspace(): string {
  const root = tmpRoot('tui-file-mentions-ws-');
  mkdirSync(join(root, 'src'));
  mkdirSync(join(root, 'dist'));
  writeFileSync(join(root, 'src', 'main.ts'), 'main\n');
  writeFileSync(join(root, 'src', 'map.ts'), 'map\n');
  writeFileSync(join(root, 'dist', 'out.js'), 'built\n');
  writeFileSync(join(root, '.gitignore'), 'dist/\n');
  return root;
}

describe('@ mention file source', () => {
  it('the booted lane lists workspace files and never a gitignored one', async () => {
    const root = workspace();
    const models = createModels();
    const faux = fauxProvider();
    faux.setResponses([fauxAssistantMessage('hi')]);
    models.setProvider(faux.provider);
    const boot = await bootTuiLane(undefined, {
      sessionsRoot: tmpRoot('tui-file-mentions-sessions-'),
      models,
      env: new NodeExecutionEnv(root),
    });
    try {
      const files = boot.listFiles?.() ?? [];
      expect(files).toContain('src/main.ts');
      expect(files).toContain('src/map.ts');
      expect(files).not.toContain('dist/out.js');
    } finally {
      await boot.close?.();
    }
  });

  it('walks once per window, then sees new files', () => {
    const root = workspace();
    let now = 1_000;
    const list = workspaceFileLister(new NodeExecutionEnv(root), () => now);
    expect(list()).not.toContain('src/new.ts');
    writeFileSync(join(root, 'src', 'new.ts'), 'new\n');
    expect(list()).not.toContain('src/new.ts');
    now += FILE_LIST_TTL_MS;
    expect(list()).toContain('src/new.ts');
  });
});
