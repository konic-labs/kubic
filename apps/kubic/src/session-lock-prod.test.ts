// Session locking + repo-level overlap warning, prod paths.
// Lives in host because vitest only includes packages/*: it reaches the
// composition root (apps/kubic) and the operator CLIs as a black-box
// caller, exactly as run-prod-path.test.ts does. Faux provider only.
// Hermetic by rule: pid liveness is stubbed (`process.kill`), fake pid
// numbers only — no test here ever signals a real process.
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createSession,
  openSessionStore,
} from '@kubic/agent/lane/session-store';
import {
  BACKGROUND_CONTEXT,
  createModels,
  createRegistry,
  fauxAssistantMessage,
  fauxProvider,
  Harness,
  type MutableModels,
  UserEntry,
} from '@kubic/agent/pi-boundary';
import { NodeExecutionEnv } from '@kubic/exec/env';
import { createNodeFileBridge } from '@kubic/exec/file-bridge';
import { FakeExecutionEnv } from '@kubic/exec/test-support/fake-env';
import { collectDoctorChecks } from '@kubic/host/doctor';
import { mapTerminusToExitCode } from '@kubic/host/run';
import { runSessionsCommand } from '@kubic/host/sessions';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runHeadlessPrompt } from './run/command.js';

const FAKE_PID = 424242;

const made: string[] = [];

function tmpRoot(prefix = 'lock-prod-'): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  made.push(dir);
  return dir;
}

beforeEach(() => {
  // The no-isolation notice is not under test here (no-isolation-notice-prod.test.ts owns
  // it); the documented opt-out keeps it off the test runner's stderr.
  vi.stubEnv('KUBIC_NO_NOTICE', '1');
});

afterEach(() => {
  vi.unstubAllEnvs();
  for (const dir of made.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

function fauxModels(texts: string[]): MutableModels {
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  faux.setResponses(texts.map((text) => fauxAssistantMessage(text)));
  return models;
}

function stubKill(alive: boolean): ReturnType<typeof vi.spyOn> {
  return vi.spyOn(process, 'kill').mockImplementation((() => {
    if (!alive) {
      throw Object.assign(new Error('kill ESRCH'), { code: 'ESRCH' });
    }
    return 0;
  }) as never);
}

// A closed session with one transcript entry, so "no transcript read" is
// observable on the CLI output.
async function closedSessionWithEntry(root: string): Promise<string> {
  const store = openSessionStore(root, createNodeFileBridge(root));
  const session = await createSession(
    store,
    { cwd: '/work' },
    BACKGROUND_CONTEXT,
  );
  const id = session.id;
  const harness = await Harness.open(
    session.adopt(),
    { models: createModels(), registry: createRegistry() },
    BACKGROUND_CONTEXT,
  );
  try {
    const conversation = await harness.root(BACKGROUND_CONTEXT);
    await conversation.commit(async (tx) => {
      await tx.appendEntry(UserEntry, conversation.id, {
        model: [
          {
            role: 'user',
            content: 'transcript-marker',
            timestamp: Date.now(),
          },
        ],
      });
    }, BACKGROUND_CONTEXT);
  } finally {
    await harness.close(BACKGROUND_CONTEXT);
  }
  await session.release(BACKGROUND_CONTEXT);
  return id;
}

describe('session lock, prod paths', () => {
  it('maps a live lock refusal to workspace_unavailable (exit 5), naming the holder', async () => {
    const root = tmpRoot();
    const id = await closedSessionWithEntry(root);
    writeFileSync(
      join(root, id, 'lock.json'),
      JSON.stringify({ pid: FAKE_PID, startedAt: Date.now() }),
    );
    const kill = stubKill(true);
    try {
      const result = await runHeadlessPrompt(
        'hello',
        { sessionId: id },
        {
          sessionsRoot: root,
          models: fauxModels(['unused']),
          env: new FakeExecutionEnv({}),
        },
      );
      expect(result.terminus).toBe('workspace_unavailable');
      expect(mapTerminusToExitCode(result.terminus)).toBe(5);
      expect(result.error?.message).toContain(String(FAKE_PID));
      expect(result.error?.message).toContain(`session '${id}'`);
    } finally {
      kill.mockRestore();
    }
  });

  it('kubic sessions attach prints the lock refusal, exits 1, reads no transcript', async () => {
    const root = tmpRoot();
    const id = await closedSessionWithEntry(root);
    writeFileSync(
      join(root, id, 'lock.json'),
      JSON.stringify({ pid: FAKE_PID, startedAt: Date.now() }),
    );
    const kill = stubKill(true);
    try {
      const lines: string[] = [];
      const code = (
        await runSessionsCommand(
          { command: 'attach', id: id },
          {
            sessionsRoot: root,
            out: (line) => lines.push(line),
          },
        )
      ).exitCode;
      expect(code).toBe(1);
      const text = lines.join('\n');
      expect(text).toContain(String(FAKE_PID));
      expect(text).toContain('refusing a second live attachment');
      expect(text).not.toContain('transcript-marker');
    } finally {
      kill.mockRestore();
    }
  });

  it('a settled run leaves no lock.json behind in its session dir', async () => {
    const root = tmpRoot();
    const workspace = tmpRoot('ws-');
    const result = await runHeadlessPrompt(
      'hello',
      {},
      {
        sessionsRoot: root,
        models: fauxModels(['all done']),
        env: new NodeExecutionEnv(workspace),
      },
    );
    expect(result.terminus).toBe('completed');
    // Close released the lock: the lock file exists only while
    // a session is actually attached.
    expect(existsSync(join(root, result.sessionId, 'lock.json'))).toBe(false);
  });
});

describe('repo-level overlap warning', () => {
  it('emits the overlap warning on the debug channel when another session touches the workspace', async () => {
    const root = tmpRoot();
    const workspace = tmpRoot('ws-');
    const store = openSessionStore(root, createNodeFileBridge(root));
    const sibling = await createSession(
      store,
      { cwd: workspace },
      BACKGROUND_CONTEXT,
    );
    await sibling.release(BACKGROUND_CONTEXT);
    const debugLines: string[] = [];
    const result = await runHeadlessPrompt(
      'hello',
      {},
      {
        sessionsRoot: root,
        models: fauxModels(['all done']),
        env: new NodeExecutionEnv(workspace),
        debug: (line) => debugLines.push(line),
      },
    );
    // Warning only: concurrent different-session runs stay legal.
    expect(result.terminus).toBe('completed');
    expect(
      debugLines.some((line) =>
        line.includes('another run may be live in this workspace'),
      ),
    ).toBe(true);
  });

  it('reaches the --debug sink when the caller wired no separate debug dep (the prod `kubic run` shape)', async () => {
    const root = tmpRoot();
    const workspace = tmpRoot('ws-');
    const store = openSessionStore(root, createNodeFileBridge(root));
    const sibling = await createSession(
      store,
      { cwd: workspace },
      BACKGROUND_CONTEXT,
    );
    await sibling.release(BACKGROUND_CONTEXT);
    const sinkLines: string[] = [];
    const result = await runHeadlessPrompt(
      'hello',
      { debug: true },
      {
        sessionsRoot: root,
        models: fauxModels(['all done']),
        env: new NodeExecutionEnv(workspace),
        debugSink: (line) => sinkLines.push(line),
      },
    );
    expect(result.terminus).toBe('completed');
    expect(
      sinkLines.some((line) =>
        line.includes('another run may be live in this workspace'),
      ),
    ).toBe(true);
  });

  it('stays silent when the only other session touches a different workspace', async () => {
    const root = tmpRoot();
    const workspace = tmpRoot('ws-');
    const store = openSessionStore(root, createNodeFileBridge(root));
    const sibling = await createSession(
      store,
      { cwd: tmpRoot('elsewhere-') },
      BACKGROUND_CONTEXT,
    );
    await sibling.release(BACKGROUND_CONTEXT);
    const debugLines: string[] = [];
    const result = await runHeadlessPrompt(
      'hello',
      {},
      {
        sessionsRoot: root,
        models: fauxModels(['all done']),
        env: new NodeExecutionEnv(workspace),
        debug: (line) => debugLines.push(line),
      },
    );
    expect(result.terminus).toBe('completed');
    expect(
      debugLines.some((line) =>
        line.includes('another run may be live in this workspace'),
      ),
    ).toBe(false);
  });

  it('reports the overlap as a doctor warn note when two sessions touch one repo', () => {
    const checks = collectDoctorChecks(
      {
        out: () => undefined,
        probeProviders: () => [],
        checkDeps: () => [],
        loadPolicy: () => ({ route: 'ask-user', autoApprove: [] }),
        probeSessionOverlap: () => ({
          workspace: '/repo',
          sessionIds: ['sess-a', 'sess-b'],
        }),
      },
      [],
    );
    const check = checks.find((entry) => entry.id === 'session:overlap');
    expect(check?.status).toBe('warn');
    expect(check?.detail).toContain('/repo');
  });

  it('reports a clean doctor note when one session touches the repo', () => {
    const checks = collectDoctorChecks(
      {
        out: () => undefined,
        probeProviders: () => [],
        checkDeps: () => [],
        loadPolicy: () => ({ route: 'ask-user', autoApprove: [] }),
        probeSessionOverlap: () => ({
          workspace: '/repo',
          sessionIds: ['sess-a'],
        }),
      },
      [],
    );
    const check = checks.find((entry) => entry.id === 'session:overlap');
    expect(check?.status).toBe('pass');
  });
});
