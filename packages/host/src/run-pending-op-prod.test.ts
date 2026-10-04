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
import { readSessionEntries } from '../../worker/src/lane/transcript.js';
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

// The dead process: admit a prompt durably, never wait, never close — its
// lock is left behind as a crashed holder, and the model request it started
// never settles (the hanging faux factory consumes no scripted response).
async function crashAfterAccept(
  root: string,
  prompt: string,
): Promise<{ id: string; submissionId: string }> {
  const store = openSessionStore(root, createNodeFileBridge(root));
  const session = await createSession(
    store,
    { cwd: '/work' },
    BACKGROUND_CONTEXT,
  );
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  faux.setResponses([() => new Promise<never>(() => undefined)]);
  const solo = await bootSoloLane({
    session,
    models,
    model: faux.getModel(),
    env: new FakeExecutionEnv({}),
    sessionId: session.id,
    agentId: 'root',
  });
  const submission = await solo.conversation.submit(
    { type: 'input', content: prompt, requestId: 'crashed-run' },
    BACKGROUND_CONTEXT,
  );
  // The process is gone: its storage is closed (commits flushed, no live
  // writer left) and the lock file is rewritten as the dead holder. The
  // handle's own release() cannot stand in for the death any more — the
  // lane adopted the storage (D8.1), so release only gives the lock back
  // and would leave a live writer on the file.
  await session.storage.close(BACKGROUND_CONTEXT);
  writeFileSync(
    join(root, session.id, 'lock.json'),
    JSON.stringify({ pid: 424242, startedAt: Date.now() }),
  );
  return { id: session.id, submissionId: String(submission.id) };
}

async function transcript(root: string, id: string): Promise<string> {
  const store = openSessionStore(root, createNodeFileBridge(root));
  const session = await attachSession(store, id, BACKGROUND_CONTEXT);
  try {
    return JSON.stringify(
      await readSessionEntries(session.storage, BACKGROUND_CONTEXT),
    );
  } finally {
    await session.release(BACKGROUND_CONTEXT);
  }
}

function count(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

describe('kubic run --session after a crash (issue #147)', () => {
  it('resumes the pending op, then accepts the new prompt without LaneBusy', async () => {
    const root = tmpRoot();
    const { id, submissionId } = await crashAfterAccept(root, 'first task');
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
    expect(result.error?.message ?? '').not.toContain('busy');
    expect(result.terminus).toBe('completed');
    expect(result.summary).toBe('second reply');
    // The report names the durable work: the generation task behind the
    // placed submission, then the submission itself.
    expect(notices).toEqual([
      expect.stringMatching(
        new RegExp(
          `^pending work: pi\\.generation \\d+ \\(ready\\), submission ${submissionId} \\(placed\\) resumed after an interrupted run: done$`,
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
    const { id, submissionId } = await crashAfterAccept(root, 'plan prompt');
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
    expect(notices).toHaveLength(1);
    expect(notices[0]).toContain(
      `submission ${submissionId} (placed) carries this prompt: resuming it instead of re-prompting`,
    );
    vi.restoreAllMocks();
    const text = await transcript(root, id);
    // Pi keeps the admitted prompt both as the queued entry and on the
    // branch, so the baseline is an uninterrupted run of the same prompt:
    // a resume must leave exactly as many copies, never one more.
    const clean = tmpRoot();
    const cleanStore = openSessionStore(clean, createNodeFileBridge(clean));
    const fresh = await createSession(
      cleanStore,
      { cwd: '/work' },
      BACKGROUND_CONTEXT,
    );
    const freshId = fresh.id;
    await fresh.release(BACKGROUND_CONTEXT);
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
    const session = await createSession(
      store,
      { cwd: '/work' },
      BACKGROUND_CONTEXT,
    );
    const id = session.id;
    await session.release(BACKGROUND_CONTEXT);
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
    const { id, submissionId } = await crashAfterAccept(root, 'first task');
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
    expect(
      lines.some((line) =>
        line.includes(`submission ${submissionId} (placed)`),
      ),
    ).toBe(true);
    expect(lines.some((line) => line.startsWith('pending work'))).toBe(true);
  });

  it('prints no pending line for a settled session', async () => {
    const root = tmpRoot();
    const store = openSessionStore(root, createNodeFileBridge(root));
    const session = await createSession(
      store,
      { cwd: '/work' },
      BACKGROUND_CONTEXT,
    );
    const id = session.id;
    await session.release(BACKGROUND_CONTEXT);
    const lines: string[] = [];
    const code = await runSessionsCommand(
      { command: 'attach', id },
      {
        sessionsRoot: root,
        out: (line) => lines.push(line),
      },
    );
    expect(code).toBe(0);
    expect(lines.some((line) => line.startsWith('pending work'))).toBe(false);
  });
});
