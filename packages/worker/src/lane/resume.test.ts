// Crash recovery through the durable session store. A process that dies
// mid-turn leaves its placed input durably recorded; the next attach reopens
// the same JSONL session and `settlePending`'s `resume` drives that work to
// completion. The durable submission IS the pending work.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { createNodeFileBridge } from '../../../exec/src/file-bridge.js';
import { BACKGROUND_CONTEXT, fauxAssistantMessage } from '../pi-boundary.js';
import { settlePending } from './pending.js';
import { attachSession, openSessionStore } from './session-store.js';
import { bootFauxLane, type FauxLane } from './test-harness.js';

const openLanes: FauxLane[] = [];
const scratchDirs: string[] = [];

afterAll(async () => {
  for (const lane of openLanes.splice(0)) {
    await lane.cleanup().catch(() => undefined);
  }
  for (const dir of scratchDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function scratch(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  scratchDirs.push(dir);
  return dir;
}

describe('session resume', () => {
  it('resumes the work a killed process left and completes it after attach', async () => {
    const root = scratch('resume-');
    const sessionId = 'sess-resume-1';

    // First "process": boot the real session (JSONL storage + lock), admit
    // one prompt, then die without driving or closing it — the answer never
    // arrives, so the generation task stays durably pending.
    const dying = await bootFauxLane({
      storage: 'jsonl',
      root,
      sessionId,
      // A provider that never answers: the killed process cannot commit a
      // reply, exactly like a crash between admission and the response.
      responses: [() => new Promise<never>(() => undefined)],
    });
    await dying.solo.conversation.submit(
      { type: 'input', content: 'finish this' },
      BACKGROUND_CONTEXT,
    );

    // Second "process": attach the same session. The first process died
    // holding its session lock (it never closed), so the fixture rewrites
    // lock.json as that crashed holder: a fake pid with liveness stubbed
    // dead (hermetic — no real process is ever signalled). A
    // live holder would refuse this attach, correctly.
    writeFileSync(
      join(root, sessionId, 'lock.json'),
      JSON.stringify({ pid: 424242, startedAt: Date.now() }),
    );
    const store = openSessionStore(root, createNodeFileBridge(root));
    const kill = vi.spyOn(process, 'kill').mockImplementation((() => {
      throw Object.assign(new Error('kill ESRCH'), { code: 'ESRCH' });
    }) as never);
    const attached = await attachSession(
      store,
      sessionId,
      BACKGROUND_CONTEXT,
    ).finally(() => kill.mockRestore());

    const resumed = await bootFauxLane({
      handle: attached,
      responses: [fauxAssistantMessage('done')],
    });
    openLanes.push(resumed);
    const settlement = await settlePending(resumed.solo, 'resume', {
      context: BACKGROUND_CONTEXT,
      kills: resumed.solo.kills,
    });
    expect(settlement.outcome).toBe('resumed');
    // The durable settlement is the answer the resumed run produced.
    expect(settlement.settled).toBe('done');

    const transcript = JSON.stringify(await resumed.entries());
    // The prompt was persisted by the dead process; the reply can only
    // come from the resumed lane driving the pending work to completion.
    expect(transcript).toContain('finish this');
    expect(transcript).toContain('done');
  });
});
