// Issue #364: an orchestrated worker child's journal entries carry its
// orchestrator-assigned identity (KUBIC_WORKER_ID), not 'root'. Full
// headless runs on the faux provider with a scripted write-tool round;
// temp sessions root and workspace, env restored after each test.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NodeExecutionEnv } from '../../../packages/exec/src/env.js';
import { createNodeFileBridge } from '../../../packages/exec/src/file-bridge.js';
import { FileJournalStore } from '../../../packages/exec/src/journal.js';
import { runJournalCommand } from '../../../packages/host/src/journal-cli.js';
import {
  createSession,
  openSessionStore,
} from '../../../packages/worker/src/lane/session-store.js';
import {
  BACKGROUND_CONTEXT,
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from '../../../packages/worker/src/pi-boundary.js';
import { resolveRunAgentId, runHeadlessPrompt } from './headless-run.js';

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

function scriptedModels(): ReturnType<typeof createModels> {
  const models = createModels();
  const faux = fauxProvider({
    provider: 'faux',
    models: [{ id: 'echo', contextWindow: 100000 }],
  });
  faux.setResponses([
    fauxAssistantMessage(
      [fauxToolCall('write', { path: 'n.txt', content: 'hi\n' })],
      { stopReason: 'toolUse' },
    ),
    fauxAssistantMessage('wrote it'),
  ]);
  models.setProvider(faux.provider);
  return models;
}

async function run(
  sessionsRoot: string,
  ws: string,
  extra: { workerId?: string; agentId?: string } = {},
): Promise<string> {
  if (extra.workerId !== undefined)
    vi.stubEnv('KUBIC_WORKER_ID', extra.workerId);
  else vi.stubEnv('KUBIC_WORKER_ID', '');
  const result = await runHeadlessPrompt(
    'write the file',
    {},
    {
      sessionsRoot,
      env: new NodeExecutionEnv(ws),
      modelsCwd: ws,
      models: scriptedModels(),
      model: { provider: 'faux', id: 'echo' },
      warn: () => undefined,
      ...(extra.agentId === undefined ? {} : { agentId: extra.agentId }),
    },
  );
  expect(result.terminus).toBe('completed');
  return result.sessionId;
}

function journalAgentIds(sessionsRoot: string, sessionId: string): string[] {
  const store = new FileJournalStore(join(sessionsRoot, sessionId, 'journal'));
  const entries = store.entries();
  expect(entries.length).toBeGreaterThan(0);
  return entries.map((e) => e.agentId);
}

describe('resolveRunAgentId (issue #364)', () => {
  it('prefers a non-empty KUBIC_WORKER_ID over the configured name', () => {
    expect(resolveRunAgentId('alice', { KUBIC_WORKER_ID: 'worker-1' })).toBe(
      'worker-1',
    );
  });

  it('treats a blank worker id as absent, then falls back to config and root', () => {
    expect(resolveRunAgentId('alice', { KUBIC_WORKER_ID: '' })).toBe('alice');
    expect(resolveRunAgentId('alice', {})).toBe('alice');
    expect(resolveRunAgentId(undefined, {})).toBe('root');
  });
});

describe('headless worker journal attribution (issue #364)', () => {
  it("tags the worker's journal entries worker-1, not root", async () => {
    const root = tmp('hworker-root-');
    const ws = tmp('hworker-ws-');
    const sessionId = await run(root, ws, { workerId: 'worker-1' });
    expect(journalAgentIds(root, sessionId)).toEqual(['worker-1']);
  });

  it('keeps config agent.name then root when no worker id is set', async () => {
    const root = tmp('hworker-cfg-');
    const ws = tmp('hworker-cfg-ws-');
    const configured = await run(root, ws, { agentId: 'alice' });
    expect(journalAgentIds(root, configured)).toEqual(['alice']);
    const plainRoot = tmp('hworker-plain-');
    const plain = await run(plainRoot, tmp('hworker-plain-ws-'));
    expect(journalAgentIds(plainRoot, plain)).toEqual(['root']);
  });
});

describe('two-worker orchestration end to end (issue #364)', () => {
  it('tags each worker journal and aggregates diff/log over the orchestration', async () => {
    const sessionsRoot = tmp('hpair-sessions-');
    const ws1 = tmp('hpair-ws1-');
    const ws2 = tmp('hpair-ws2-');
    // The orchestration creates each worker session before the child
    // attaches (`kubic run --session` only attaches) — mirror that here.
    const store = openSessionStore(
      sessionsRoot,
      createNodeFileBridge(sessionsRoot),
    );
    for (const [id, ws] of [
      ['orch-worker-1', ws1],
      ['orch-worker-2', ws2],
    ] as const) {
      const session = await createSession(
        store,
        { id, cwd: ws, workspace: ws },
        BACKGROUND_CONTEXT,
      );
      await session.release(BACKGROUND_CONTEXT);
    }
    const invoke = async (
      sessionId: string,
      ws: string,
      workerId: string,
      file: string,
    ): Promise<void> => {
      vi.stubEnv('KUBIC_WORKER_ID', workerId);
      const models = createModels();
      const faux = fauxProvider({
        provider: 'faux',
        models: [{ id: 'echo', contextWindow: 100000 }],
      });
      faux.setResponses([
        fauxAssistantMessage(
          [fauxToolCall('write', { path: file, content: `${workerId}\n` })],
          { stopReason: 'toolUse' },
        ),
        fauxAssistantMessage('wrote it'),
      ]);
      models.setProvider(faux.provider);
      const result = await runHeadlessPrompt(
        'write the file',
        { sessionId },
        {
          sessionsRoot,
          env: new NodeExecutionEnv(ws),
          modelsCwd: ws,
          models,
          model: { provider: 'faux', id: 'echo' },
          warn: () => undefined,
        },
      );
      expect(result.terminus).toBe('completed');
      expect(result.sessionId).toBe(sessionId);
    };
    await invoke('orch-worker-1', ws1, 'worker-1', 'one.txt');
    await invoke('orch-worker-2', ws2, 'worker-2', 'two.txt');
    vi.stubEnv('KUBIC_WORKER_ID', '');

    // Each worker's session journal carries its own agent id.
    expect(journalAgentIds(sessionsRoot, 'orch-worker-1')).toEqual([
      'worker-1',
    ]);
    expect(journalAgentIds(sessionsRoot, 'orch-worker-2')).toEqual([
      'worker-2',
    ]);

    // `diff --session orch --agent worker-2` covers that worker's changes.
    const diff: string[] = [];
    expect(
      await runJournalCommand(
        { command: 'diff', session: 'orch', agent: 'worker-2' },
        {
          sessionsRoot,
          root: ws1,
          out: (l: string) => diff.push(l),
        },
      ),
    ).toBe(0);
    const diffText = diff.join('\n');
    expect(diffText).toContain('two.txt');
    expect(diffText).not.toContain('one.txt');

    // `log --session orch` interleaves both workers with agent tags.
    const log: string[] = [];
    expect(
      await runJournalCommand(
        { command: 'log', session: 'orch' },
        {
          sessionsRoot,
          root: ws1,
          out: (l: string) => log.push(l),
        },
      ),
    ).toBe(0);
    const logText = log.join('\n');
    expect(logText).toContain('worker-1');
    expect(logText).toContain('worker-2');
    expect(logText).toContain('one.txt');
    expect(logText).toContain('two.txt');
  });
});
