// Re-attach after a crash, prod paths (issue #147; §21). A process that died
// mid-turn leaves the lane's operation open; `kubic run --session` must
// settle it (resume, bounded by the run's guards) and then accept the new
// prompt instead of failing with LaneBusy, and `kubic sessions attach` must
// name the pending operation. Faux provider only; pid liveness is stubbed —
// no test signals a real process.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runHeadlessPrompt } from '../../../apps/kubic/src/headless-run.js';
import { FakeExecutionEnv } from '../../exec/src/env.js';
import { createNodeFileBridge } from '../../exec/src/file-bridge.js';
import {
  attachSession,
  createSession,
  openSessionStore,
} from '../../worker/src/lane/session-store.js';
import { bootSoloLane } from '../../worker/src/lane/solo.js';
import {
  BACKGROUND_CONTEXT,
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  type MutableModels,
} from '../../worker/src/pi-boundary.js';
import { runSessionsCommand } from './sessions-cli.js';

const made: string[] = [];

beforeEach(() => {
  vi.stubEnv('KUBIC_NO_NOTICE', '1');
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const dir of made.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

function tmpRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), 'kubic-pending-prod-'));
  made.push(dir);
  return dir;
}

function fauxModels(texts: string[]): MutableModels {
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  faux.setResponses(texts.map((text) => fauxAssistantMessage(text)));
  return models;
}

function stubDeadHolder(): void {
  vi.spyOn(process, 'kill').mockImplementation((() => {
    throw Object.assign(new Error('kill ESRCH'), { code: 'ESRCH' });
  }) as never);
}

// The dead process: accept a prompt, never drive, never close; its lock is
// left behind as a crashed holder.
async function crashAfterAccept(
  root: string,
  prompt: string,
): Promise<{ id: string; operationId: string }> {
  const store = openSessionStore(root, createNodeFileBridge(root));
  const session = await createSession(store, '/work', BACKGROUND_CONTEXT);
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  faux.setResponses([fauxAssistantMessage('never')]);
  const solo = await bootSoloLane({
    session,
    models,
    model: faux.getModel(),
    env: new FakeExecutionEnv({}),
    sessionId: session.metadata.id,
    agentId: 'root',
  });
  const admission = await solo.lane.accept(
    { kind: 'prompt', prompt },
    BACKGROUND_CONTEXT,
  );
  if (!admission.ok) throw new Error('accept failed');
  writeFileSync(
    join(root, session.metadata.id, 'lock.json'),
    JSON.stringify({ pid: 424242, startedAt: Date.now() }),
  );
  return { id: session.metadata.id, operationId: admission.value.operationId };
}

async function transcript(root: string, id: string): Promise<string> {
  const store = openSessionStore(root, createNodeFileBridge(root));
  const session = await attachSession(store, id, BACKGROUND_CONTEXT);
  try {
    return JSON.stringify(
      await session.findEntries(undefined, BACKGROUND_CONTEXT),
    );
  } finally {
    await session.close(BACKGROUND_CONTEXT);
  }
}

function count(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

describe('kubic run --session after a crash (issue #147)', () => {
  it('resumes the pending op, then accepts the new prompt without LaneBusy', async () => {
    const root = tmpRoot();
    const { id, operationId } = await crashAfterAccept(root, 'first task');
    stubDeadHolder();
    const notices: string[] = [];
    const result = await runHeadlessPrompt(
      'second task',
      { sessionId: id },
      {
        sessionsRoot: root,
        models: fauxModels(['resumed reply', 'second reply']),
        env: new FakeExecutionEnv({}),
        notice: (line) => notices.push(line),
      },
    );
    expect(result.error?.message ?? '').not.toContain('LaneBusy');
    expect(result.terminus).toBe('completed');
    expect(result.summary).toBe('second reply');
    expect(notices).toEqual([
      expect.stringMatching(
        new RegExp(
          `^pending operation ${operationId} \\(run, started .+\\) resumed after an interrupted run: completed$`,
        ),
      ),
    ]);
    vi.restoreAllMocks();
    const text = await transcript(root, id);
    expect(text).toContain('resumed reply');
    expect(text).toContain('second task');
    expect(text).toContain('second reply');
  });

  it('resumes instead of re-prompting when the new prompt is the pending one', async () => {
    const root = tmpRoot();
    const { id, operationId } = await crashAfterAccept(root, 'plan prompt');
    stubDeadHolder();
    const notices: string[] = [];
    const result = await runHeadlessPrompt(
      'plan prompt',
      { sessionId: id },
      {
        sessionsRoot: root,
        models: fauxModels(['resumed reply', 'duplicate reply']),
        env: new FakeExecutionEnv({}),
        notice: (line) => notices.push(line),
      },
    );
    expect(result.terminus).toBe('completed');
    expect(result.summary).toBe('resumed reply');
    expect(notices).toEqual([
      expect.stringContaining(
        `pending operation ${operationId} (run, started `,
      ),
    ]);
    expect(notices[0]).toContain(
      'carries this prompt: resuming it instead of re-prompting',
    );
    vi.restoreAllMocks();
    const text = await transcript(root, id);
    // Pi keeps the admitted prompt both as the queued entry and on the
    // branch, so the baseline is an uninterrupted run of the same prompt:
    // a resume must leave exactly as many copies, never one more.
    const clean = tmpRoot();
    const cleanStore = openSessionStore(clean, createNodeFileBridge(clean));
    const fresh = await createSession(cleanStore, '/work', BACKGROUND_CONTEXT);
    const freshId = fresh.metadata.id;
    await fresh.close(BACKGROUND_CONTEXT);
    await runHeadlessPrompt(
      'plan prompt',
      { sessionId: freshId },
      {
        sessionsRoot: clean,
        models: fauxModels(['resumed reply']),
        env: new FakeExecutionEnv({}),
        notice: () => undefined,
      },
    );
    const baseline = count(await transcript(clean, freshId), 'plan prompt');
    expect(baseline).toBeGreaterThan(0);
    expect(count(text, 'plan prompt')).toBe(baseline);
    expect(text).not.toContain('duplicate reply');
  });

  it('a session with no pending op runs exactly as before (no notice)', async () => {
    const root = tmpRoot();
    const store = openSessionStore(root, createNodeFileBridge(root));
    const session = await createSession(store, '/work', BACKGROUND_CONTEXT);
    const id = session.metadata.id;
    await session.close(BACKGROUND_CONTEXT);
    const notices: string[] = [];
    const result = await runHeadlessPrompt(
      'hello',
      { sessionId: id },
      {
        sessionsRoot: root,
        models: fauxModels(['hi']),
        env: new FakeExecutionEnv({}),
        notice: (line) => notices.push(line),
      },
    );
    expect(result.terminus).toBe('completed');
    expect(notices).toEqual([]);
  });
});

describe('kubic sessions attach with a pending op (issue #147)', () => {
  it('prints the pending operation line', async () => {
    const root = tmpRoot();
    const { id, operationId } = await crashAfterAccept(root, 'first task');
    stubDeadHolder();
    const lines: string[] = [];
    const code = await runSessionsCommand(
      { command: 'attach', id },
      {
        sessionsRoot: root,
        out: (line) => lines.push(line),
      },
    );
    expect(code).toBe(0);
    expect(lines).toContainEqual(
      expect.stringMatching(
        new RegExp(`^pending operation: ${operationId} \\(run, started .+\\)$`),
      ),
    );
  });

  it('prints no pending line for a settled session', async () => {
    const root = tmpRoot();
    const store = openSessionStore(root, createNodeFileBridge(root));
    const session = await createSession(store, '/work', BACKGROUND_CONTEXT);
    const id = session.metadata.id;
    await session.close(BACKGROUND_CONTEXT);
    const lines: string[] = [];
    const code = await runSessionsCommand(
      { command: 'attach', id },
      {
        sessionsRoot: root,
        out: (line) => lines.push(line),
      },
    );
    expect(code).toBe(0);
    expect(lines.some((line) => line.startsWith('pending operation'))).toBe(
      false,
    );
  });
});
