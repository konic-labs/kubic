// Slice B: allowlisting on the solo lane (issue #15).
import { afterAll, describe, expect, it } from 'vitest';
import { SOLO_DEFAULTS } from '../../../agents/src/policy.js';
import { FakeExecutionEnv } from '../../../exec/src/env.js';
import {
  BACKGROUND_CONTEXT,
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  MemorySessionRepo,
  type Session,
} from '../pi-boundary.js';
import { applyToolPolicy } from './policy.js';
import { bootSoloLane } from './solo.js';

const sessions: Session[] = [];
afterAll(async () => {
  for (const session of sessions) {
    try {
      await session.close(BACKGROUND_CONTEXT);
    } catch {
      // Best-effort teardown.
    }
  }
});

async function booted() {
  const env = new FakeExecutionEnv({});
  const repo = new MemorySessionRepo();
  const session = await repo.create({}, BACKGROUND_CONTEXT);
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  faux.setResponses([fauxAssistantMessage('hi')]);
  const bootedLane = await bootSoloLane({
    session,
    models,
    model: faux.getModel(),
    env,
    sessionId: session.metadata.id,
    agentId: 'root',
  });
  sessions.push(session);
  return bootedLane;
}

describe('tool policy allowlisting (issue #15, slice B)', () => {
  it('boots with all seven tools active under solo defaults', async () => {
    const { harness, lane } = await booted();
    const allowed = await applyToolPolicy(
      harness,
      lane,
      SOLO_DEFAULTS,
      BACKGROUND_CONTEXT,
    );
    expect(allowed.sort()).toEqual(
      ['bash', 'edit', 'find', 'grep', 'ls', 'read', 'write'].sort(),
    );
    expect(await lane.getActiveTools(BACKGROUND_CONTEXT)).toEqual(
      expect.arrayContaining(['read', 'bash']),
    );
  });

  it('allowlist removes tools outside the classes', async () => {
    const { harness, lane } = await booted();
    await applyToolPolicy(
      harness,
      lane,
      { ...SOLO_DEFAULTS, filesystem: 'none', shell: false },
      BACKGROUND_CONTEXT,
    );
    expect(await lane.getActiveTools(BACKGROUND_CONTEXT)).toEqual([]);
  });

  it('derives the allowlist the lane actually enforces', async () => {
    const { harness, lane } = await booted();
    const classes = {
      ...SOLO_DEFAULTS,
      filesystem: 'read' as const,
      shell: false as const,
    };
    const allowed = await applyToolPolicy(
      harness,
      lane,
      classes,
      BACKGROUND_CONTEXT,
    );
    expect(allowed.sort()).toEqual(['find', 'grep', 'ls', 'read'].sort());
    expect(await lane.getActiveTools(BACKGROUND_CONTEXT)).toEqual(
      expect.arrayContaining(['read']),
    );
    expect(await lane.getActiveTools(BACKGROUND_CONTEXT)).not.toContain('bash');
  });
});
