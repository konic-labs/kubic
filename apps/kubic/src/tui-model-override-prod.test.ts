// `kubic tui` honours the configured model.
// Before the interactive TUI — what bare `kubic` opens on a TTY —
// called selectModel without the runtime pin, so it ran the first
// registered provider while `kubic run` in the same directory ran the
// configured model. These tests drive the PROD boot (bootTuiLane) over the
// real config load with two faux providers: zero network, zero paid tokens.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createSession,
  openSessionStore,
} from '@kubic/agent/lane/session-store';
import {
  BACKGROUND_CONTEXT,
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  type MutableModels,
} from '@kubic/agent/pi-boundary';
import { FakeExecutionEnv } from '@kubic/exec/env';
import { createNodeFileBridge } from '@kubic/exec/file-bridge';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadCliConfig, runtimeModelPin } from './config-runtime.js';
import { bootTuiLane } from './tui-run.js';

const made: string[] = [];

function tmpRoot(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  made.push(dir);
  return dir;
}

beforeEach(() => {
  vi.stubEnv('KUBIC_NO_NOTICE', '1');
  vi.stubEnv('KUBIC_PROVIDER', '');
});

afterEach(() => {
  vi.unstubAllEnvs();
  for (const dir of made.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

// Two faux providers: the default (unpinned) pick is the first registered
// (`faux/big`), and `alt/m1` only answers when a pin selects it.
function twoProviders(): MutableModels {
  const models = createModels();
  const faux = fauxProvider({
    provider: 'faux',
    models: [
      { id: 'big', contextWindow: 200000 },
      { id: 'small', contextWindow: 120000 },
    ],
  });
  faux.setResponses([fauxAssistantMessage('from faux')]);
  models.setProvider(faux.provider);
  const alt = fauxProvider({
    provider: 'alt',
    models: [{ id: 'm1', contextWindow: 100000 }],
  });
  alt.setResponses([fauxAssistantMessage('from alt')]);
  models.setProvider(alt.provider);
  return models;
}

// A workspace whose committed config pins `alt/m1`.
function pinnedWorkspace(): { cwd: string; home: string } {
  const cwd = tmpRoot('tui-model-override-cwd-');
  const home = tmpRoot('tui-model-override-home-');
  mkdirSync(join(cwd, '.kubic'), { recursive: true });
  writeFileSync(
    join(cwd, '.kubic', 'config.toml'),
    '[model]\nprovider = "alt"\nid = "m1"\n',
  );
  return { cwd, home };
}

async function newSession(root: string): Promise<string> {
  const store = openSessionStore(root, createNodeFileBridge(root));
  const session = await createSession(
    store,
    { cwd: '/work' },
    BACKGROUND_CONTEXT,
  );
  const id = session.id;
  await session.release(BACKGROUND_CONTEXT);
  return id;
}

describe('kubic tui model selection', () => {
  it('a config [model] pin selects the pinned model, not the first provider', async () => {
    const sessionsRoot = tmpRoot('tui-model-override-sessions-');
    const { cwd, home } = pinnedWorkspace();
    const config = loadCliConfig({
      cwd,
      home,
      env: {},
      projectTrusted: true,
    });
    expect(runtimeModelPin(config)).toEqual({ provider: 'alt', id: 'm1' });

    const boot = await bootTuiLane(undefined, {
      sessionsRoot,
      models: twoProviders(),
      env: new FakeExecutionEnv({}),
      model: runtimeModelPin(config),
    });
    try {
      expect(boot.model).toBe('alt/m1');
    } finally {
      await boot.close?.();
    }
  });

  it('KUBIC_MODEL overrides the config pin, exactly as it does for kubic run', async () => {
    const sessionsRoot = tmpRoot('tui-model-override-sessions2-');
    const { cwd, home } = pinnedWorkspace();
    const config = loadCliConfig({
      cwd,
      home,
      env: { KUBIC_MODEL: 'faux/small' },
      projectTrusted: true,
    });
    expect(runtimeModelPin(config)).toEqual({ provider: 'faux', id: 'small' });

    const boot = await bootTuiLane(undefined, {
      sessionsRoot,
      models: twoProviders(),
      env: new FakeExecutionEnv({}),
      model: runtimeModelPin(config),
    });
    try {
      expect(boot.model).toBe('faux/small');
    } finally {
      await boot.close?.();
    }
  });

  it('without a pin the first usable provider still answers', async () => {
    const sessionsRoot = tmpRoot('tui-model-override-sessions3-');
    const boot = await bootTuiLane(undefined, {
      sessionsRoot,
      models: twoProviders(),
      env: new FakeExecutionEnv({}),
    });
    try {
      expect(boot.model).toBe('faux/big');
    } finally {
      await boot.close?.();
    }
  });

  it('a pin switches a resumed session whose stored model differs', async () => {
    const sessionsRoot = tmpRoot('tui-model-override-sessions4-');
    const id = await newSession(sessionsRoot);
    // First boot stored faux/small (an explicit pin on a fresh session).
    const first = await bootTuiLane(id, {
      sessionsRoot,
      models: twoProviders(),
      env: new FakeExecutionEnv({}),
      model: { provider: 'faux', id: 'small' },
    });
    expect(first.model).toBe('faux/small');
    await first.close?.();

    // Second boot pins alt/m1; the resumed session switches and says so.
    const second = await bootTuiLane(id, {
      sessionsRoot,
      models: twoProviders(),
      env: new FakeExecutionEnv({}),
      model: { provider: 'alt', id: 'm1' },
    });
    try {
      expect(second.model).toBe('alt/m1');
      expect(second.modelNotice).toContain(
        "model: session model 'faux/small' switched to 'alt/m1' (explicit selection)",
      );
    } finally {
      await second.close?.();
    }
    // The switch is durable: a third boot with no pin reads the committed
    // `pi.agent` document and keeps the session's own model (the stored
    // rule) — never the default pick.
    const third = await bootTuiLane(id, {
      sessionsRoot,
      models: twoProviders(),
      env: new FakeExecutionEnv({}),
    });
    try {
      expect(third.model).toBe('alt/m1');
    } finally {
      await third.close?.();
    }
  });
});
