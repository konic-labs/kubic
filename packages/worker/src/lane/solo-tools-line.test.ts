// Issue #143 (§40.3, §12.1): the model must be told the truth about its own
// tool set. The prompt's `tools:` line and the lane's registered set are one
// intersection — base tools, narrowed by the permission classes when declared
// and by the role allowlist when declared — in every combination, including
// the classes-only one the pre-fix code advertised in full.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SOLO_DEFAULTS } from '../../../agents/src/policy.js';
import { FakeExecutionEnv } from '../../../exec/src/env.js';
import {
  AgentHarness,
  BACKGROUND_CONTEXT,
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  MemorySessionRepo,
  type Session,
} from '../pi-boundary.js';
import { bootSoloLane, type SoloBootOptions } from './solo.js';
import { kubicToolsToPiTools } from './tools-adapter.js';

const sessions: Session[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  for (const session of sessions.splice(0)) {
    await session.close(BACKGROUND_CONTEXT);
  }
});

const READ_ONLY_CLASSES = {
  ...SOLO_DEFAULTS,
  filesystem: 'read' as const,
  shell: false as const,
  git: false as const,
};

// Boots a solo lane and returns what the model is told (`tools:` line of the
// assembled system prompt) next to what the lane actually registered.
async function boot(
  extra: Pick<SoloBootOptions, 'policy' | 'toolAllowlist'>,
): Promise<{ advertised: string[]; active: string[] }> {
  const createSpy = vi.spyOn(AgentHarness, 'create');
  const repo = new MemorySessionRepo();
  const session = await repo.create({}, BACKGROUND_CONTEXT);
  sessions.push(session);
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  faux.setResponses([fauxAssistantMessage('hi')]);
  const { lane } = await bootSoloLane({
    session,
    models,
    model: faux.getModel(),
    env: new FakeExecutionEnv({}),
    sessionId: session.metadata.id,
    agentId: 'root',
    ...extra,
  });
  const options = createSpy.mock.calls[0]?.[0] as unknown as {
    systemPrompt: string;
  };
  const line = /^tools: (.*)$/m.exec(options.systemPrompt)?.[1] ?? '';
  return {
    advertised: line
      .split(',')
      .map((name) => name.trim())
      .filter((name) => name !== '')
      .sort(),
    active: [...(await lane.getActiveTools(BACKGROUND_CONTEXT))].sort(),
  };
}

describe('the prompt tools line is the same intersection the lane registers (issue #143)', () => {
  it('neither classes nor allowlist: every base tool is advertised', async () => {
    const all = kubicToolsToPiTools()
      .map((tool) => tool.name)
      .sort();
    const { advertised, active } = await boot({});
    expect(advertised).toEqual(all);
    expect(active).toEqual(all);
  });

  it('classes only: a read-only session never advertises write, edit, bash or git', async () => {
    const { advertised } = await boot({
      policy: { classes: READ_ONLY_CLASSES },
    });
    expect(advertised).toEqual(['find', 'grep', 'ls', 'read']);
  });

  it('allowlist only: the role set is advertised and registered, nothing more', async () => {
    const { advertised, active } = await boot({
      toolAllowlist: ['read', 'write', 'grep'],
    });
    expect(advertised).toEqual(['grep', 'read', 'write']);
    expect(active).toEqual(['grep', 'read', 'write']);
  });

  it('classes and allowlist: the narrower of the two, so a role never widens the classes', async () => {
    const { advertised, active } = await boot({
      policy: { classes: READ_ONLY_CLASSES },
      toolAllowlist: ['read', 'write', 'grep', 'bash'],
    });
    expect(advertised).toEqual(['grep', 'read']);
    expect(active).toEqual(['grep', 'read']);
  });
});
