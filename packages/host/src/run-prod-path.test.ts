// Prod `kubic run -p` path (issue #28): drives the composition-root
// adapter (apps/kubic) against a real lane with faux models. This file
// lives in host because vitest only includes packages/* — it reaches
// across to the adapter purely as a black-box caller, never into lane
// internals. Faux provider only: zero network.
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runHeadlessPrompt } from '../../../apps/kubic/src/headless-run.js';
import { FakeExecutionEnv } from '../../exec/src/env.js';
import { createNodeFileBridge } from '../../exec/src/file-bridge.js';
import {
  attachSession,
  openSessionStore,
} from '../../worker/src/lane/session-store.js';
import {
  BACKGROUND_CONTEXT,
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  type MutableModels,
} from '../../worker/src/pi-boundary.js';

function tmpRoot(): string {
  return mkdtempSync(join(tmpdir(), 'run-prod-path-'));
}

function fauxModels(texts: string[]): MutableModels {
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  faux.setResponses(texts.map((text) => fauxAssistantMessage(text)));
  return models;
}

function entryTexts(entries: unknown): string[] {
  if (!Array.isArray(entries)) return [];
  const out: string[] = [];
  for (const entry of entries) {
    const message = (entry as { message?: unknown }).message as {
      content?: unknown;
    };
    if (!Array.isArray(message?.content)) continue;
    for (const part of message.content) {
      const text = (part as { type?: unknown; text?: unknown }).text;
      if (
        (part as { type?: unknown }).type === 'text' &&
        typeof text === 'string'
      )
        out.push(text);
    }
  }
  return out;
}

describe('prod run path, live lane (issue #28, E1)', () => {
  it('drives a faux lane to completed with the assistant summary', async () => {
    const root = tmpRoot();
    const store = openSessionStore(root, createNodeFileBridge(root));
    const result = await runHeadlessPrompt(
      'do it',
      {},
      {
        sessionsRoot: root,
        models: fauxModels(['all done']),
        env: new FakeExecutionEnv({}),
      },
    );
    expect(result.terminus).toBe('completed');
    expect(result.summary).toContain('all done');
    expect(result.sessionId).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(existsSync(join(root, result.sessionId, 'journal'))).toBe(true);
    const reopened = await attachSession(
      store,
      result.sessionId,
      BACKGROUND_CONTEXT,
    );
    try {
      const entries = await reopened.findEntries(undefined, BACKGROUND_CONTEXT);
      expect(entryTexts(entries).join('\n')).toMatch(/do it/);
    } finally {
      await reopened.close(BACKGROUND_CONTEXT);
    }
  });

  it('maps a starved lane drive to failed', async () => {
    const root = tmpRoot();
    const faux = fauxProvider();
    const models = createModels();
    models.setProvider(faux.provider);
    faux.setResponses([]);
    const result = await runHeadlessPrompt(
      'break it',
      {},
      { sessionsRoot: root, models, env: new FakeExecutionEnv({}) },
    );
    expect(result.terminus).toBe('failed');
  });

  it('maps an empty model registry to provider_probe_failed', async () => {
    const root = tmpRoot();
    const result = await runHeadlessPrompt(
      'hello',
      {},
      {
        sessionsRoot: root,
        models: createModels(),
        env: new FakeExecutionEnv({}),
      },
    );
    expect(result.terminus).toBe('provider_probe_failed');
    expect(result.sessionId).toMatch(/^[A-Za-z0-9_-]+$/);
  });
});

describe('prod run path, resume chain (issue #28, E4)', () => {
  it('links the resumed prompt to the tip with a collision-free id', async () => {
    const root = tmpRoot();
    const env = new FakeExecutionEnv({});
    const store = openSessionStore(root, createNodeFileBridge(root));
    const first = await runHeadlessPrompt(
      'first prompt',
      {},
      { sessionsRoot: root, models: fauxModels(['first done']), env },
    );
    expect(first.terminus).toBe('completed');
    const id = first.sessionId;
    const attached = await attachSession(store, id, BACKGROUND_CONTEXT);
    let tipAfterFirst = '';
    try {
      const entries = await attached.findEntries(undefined, BACKGROUND_CONTEXT);
      let bestSeq = -1;
      for (const entry of entries) {
        const seq = (entry as { seq?: unknown }).seq;
        if (typeof seq === 'number' && seq >= bestSeq) {
          bestSeq = seq;
          tipAfterFirst = entry.id;
        }
      }
    } finally {
      await attached.close(BACKGROUND_CONTEXT);
    }
    const second = await runHeadlessPrompt(
      'second prompt',
      { sessionId: id },
      { sessionsRoot: root, models: fauxModels(['second done']), env },
    );
    expect(second.terminus).toBe('completed');
    expect(second.sessionId).toBe(id);
    const reopened = await attachSession(store, id, BACKGROUND_CONTEXT);
    try {
      const entries = await reopened.findEntries(undefined, BACKGROUND_CONTEXT);
      const ids = entries.map((entry) => entry.id);
      expect(new Set(ids).size).toBe(ids.length);
      const byId = new Set(ids);
      for (const entry of entries) {
        if (entry.parentId === null) continue;
        expect(byId.has(entry.parentId)).toBe(true);
      }
      const linked = entries.filter(
        (entry) => entry.parentId === tipAfterFirst,
      );
      expect(linked.length).toBeGreaterThan(0);
      expect(linked[0]?.id).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
      );
      expect(entryTexts(entries).join('\n')).toMatch(/first prompt/);
      expect(entryTexts(entries).join('\n')).toMatch(/second prompt/);
    } finally {
      await reopened.close(BACKGROUND_CONTEXT);
    }
  });
});

describe('prod run path, store failures (issue #28, E2)', () => {
  it('maps an unknown --session attach to workspace_unavailable', async () => {
    const root = tmpRoot();
    const result = await runHeadlessPrompt(
      'hello',
      { sessionId: 'sess-nope' },
      {
        sessionsRoot: root,
        models: fauxModels(['unused']),
        env: new FakeExecutionEnv({}),
      },
    );
    expect(result.terminus).toBe('workspace_unavailable');
    expect(result.sessionId).toBe('sess-nope');
  });
});
