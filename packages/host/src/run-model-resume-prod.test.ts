// `--session` resume model identity, prod paths (issue #148; §21, §26.1).
// The rule, identical in `run` and `tui`: an explicit model pin switches a
// resumed session whose stored model differs (with a notice); without a pin
// the session keeps its own model. Either way the result/envelope, the
// status bar and the usage rows name the model the lane actually runs, and
// a stored model that is no longer available fails closed by name.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runHeadlessPrompt } from '../../../apps/kubic/src/headless-run.js';
import { bootTuiLane } from '../../../apps/kubic/src/tui-run.js';
import { FakeExecutionEnv } from '../../exec/src/env.js';
import { createNodeFileBridge } from '../../exec/src/file-bridge.js';
import {
  attachSession,
  createSession,
  openSessionStore,
} from '../../worker/src/lane/session-store.js';
import {
  entriesToTranscript,
  readSessionEntries,
} from '../../worker/src/lane/transcript.js';
import {
  BACKGROUND_CONTEXT,
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  type MutableModels,
} from '../../worker/src/pi-boundary.js';
import { buildRunEnvelope, mapTerminusToExitCode } from './run-cli.js';

const made: string[] = [];

beforeEach(() => {
  vi.stubEnv('KUBIC_NO_NOTICE', '1');
  vi.stubEnv('KUBIC_PROVIDER', '');
});

afterEach(() => {
  vi.unstubAllEnvs();
  for (const dir of made.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

function tmpRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), 'kubic-model-resume-'));
  made.push(dir);
  return dir;
}

// Two faux models; the default (unpinned) pick is the first, `big`.
function catalog(texts: string[], provider = 'faux'): MutableModels {
  const faux = fauxProvider({
    provider,
    models: [
      { id: 'big', contextWindow: 200000 },
      { id: 'small', contextWindow: 120000 },
    ],
  });
  const models = createModels();
  models.setProvider(faux.provider);
  faux.setResponses(texts.map((text) => fauxAssistantMessage(text)));
  return models;
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

// A session whose lane was created on faux/small (pinned first run).
async function sessionOnSmall(root: string): Promise<string> {
  const id = await newSession(root);
  const first = await runHeadlessPrompt(
    'first',
    { sessionId: id },
    {
      sessionsRoot: root,
      models: catalog(['one']),
      model: { provider: 'faux', id: 'small' },
      env: new FakeExecutionEnv({}),
      notice: () => undefined,
    },
  );
  expect(first.error?.message ?? 'ok').toBe('ok');
  expect(first.terminus).toBe('completed');
  expect(first.model).toBe('faux/small');
  return id;
}

async function lastAssistantModel(root: string, id: string): Promise<string> {
  const store = openSessionStore(root, createNodeFileBridge(root));
  const session = await attachSession(store, id, BACKGROUND_CONTEXT);
  try {
    // The durable reader (#400): the session storage directly, no harness.
    const items = entriesToTranscript(
      await readSessionEntries(session.storage, BACKGROUND_CONTEXT),
    );
    const assistant = items
      .filter((item) => item.kind === 'assistant')
      .map((item) => `${item.provider}/${item.model}`);
    return assistant.at(-1) ?? '';
  } finally {
    await session.release(BACKGROUND_CONTEXT);
  }
}

describe('kubic run --session model identity (issue #148)', () => {
  it('an explicit pin switches the resumed session, says so, and reports the live model', async () => {
    const root = tmpRoot();
    const id = await sessionOnSmall(root);
    const notices: string[] = [];
    const result = await runHeadlessPrompt(
      'second',
      { sessionId: id },
      {
        sessionsRoot: root,
        models: catalog(['two']),
        model: { provider: 'faux', id: 'big' },
        env: new FakeExecutionEnv({}),
        notice: (line) => notices.push(line),
      },
    );
    expect(result.terminus).toBe('completed');
    expect(result.model).toBe('faux/big');
    expect(buildRunEnvelope(result, 0).model).toBe('faux/big');
    expect(notices).toContain(
      "model: session model 'faux/small' switched to 'faux/big' (explicit selection)",
    );
    // The usage source (the assistant message) ran on the reported model.
    expect(await lastAssistantModel(root, id)).toBe('faux/big');
  });

  it('without a pin the session keeps its model and every report names it', async () => {
    const root = tmpRoot();
    const id = await sessionOnSmall(root);
    const notices: string[] = [];
    const result = await runHeadlessPrompt(
      'second',
      { sessionId: id },
      {
        sessionsRoot: root,
        models: catalog(['two']),
        env: new FakeExecutionEnv({}),
        notice: (line) => notices.push(line),
      },
    );
    expect(result.terminus).toBe('completed');
    expect(result.model).toBe('faux/small');
    expect(buildRunEnvelope(result, 0).model).toBe('faux/small');
    expect(notices).toContain(
      "model: session keeps its own model 'faux/small' (selected default 'faux/big' not applied; pin a model to switch)",
    );
    expect(await lastAssistantModel(root, id)).toBe('faux/small');
  });

  it('a stored model whose provider is gone fails closed with a named error (exit 6)', async () => {
    const root = tmpRoot();
    const id = await sessionOnSmall(root);
    const result = await runHeadlessPrompt(
      'second',
      { sessionId: id },
      {
        sessionsRoot: root,
        models: catalog(['two'], 'other'),
        env: new FakeExecutionEnv({}),
        notice: () => undefined,
      },
    );
    expect(result.terminus).toBe('provider_probe_failed');
    expect(mapTerminusToExitCode(result.terminus)).toBe(6);
    expect(result.error?.message).toBe(
      "session model 'faux/small' is unavailable: provider 'faux' is not registered (pin a model to switch this session)",
    );
  });

  it('the envelope omits model when no lane booted', async () => {
    const result = await runHeadlessPrompt(
      'x',
      { sessionId: 'no-such-session' },
      { sessionsRoot: tmpRoot(), models: catalog([]) },
    );
    expect(result.model).toBeUndefined();
    expect('model' in buildRunEnvelope(result, 5)).toBe(false);
  });
});

describe('kubic tui --session model identity (issue #148)', () => {
  it('boots on the session model and reports it to the status bar', async () => {
    const root = tmpRoot();
    const id = await sessionOnSmall(root);
    const boot = await bootTuiLane(id, {
      sessionsRoot: root,
      models: catalog(['two']),
      env: new FakeExecutionEnv({}),
    });
    try {
      expect(boot.model).toBe('faux/small');
      expect(boot.modelNotice).toBe(
        "model: session keeps its own model 'faux/small' (selected default 'faux/big' not applied; pin a model to switch)",
      );
    } finally {
      await boot.close?.();
    }
  });
});
