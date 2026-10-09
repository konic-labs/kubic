// The lane boots at the resolved thinking level:
// override > the session's stored level > role > config, clamped to the
// effective model. Faux provider only: zero network, zero paid tokens.
import { createNodeFileBridge } from '@kubic/exec/file-bridge';
import { afterEach, describe, expect, it } from 'vitest';
import { tempDir } from '../../../../test/temp-dir.js';
import { BACKGROUND_CONTEXT, fauxAssistantMessage } from '../pi-boundary.js';
import {
  bootFauxLane,
  type FauxLane,
  type FauxLaneOptions,
  runPrompt,
} from '../test-support/lane-harness.js';
import { attachSession, openSessionStore } from './session-store/index.js';

const lanes: FauxLane[] = [];

afterEach(async () => {
  for (const lane of lanes.splice(0)) await lane.cleanup();
});

function reasoning() {
  return {
    models: [{ id: 'deep', reasoning: true }] as const,
    model: 'deep',
  };
}

async function agentThinking(lane: FauxLane): Promise<unknown> {
  return (await lane.lane.conversation.agent(BACKGROUND_CONTEXT)).thinkingLevel;
}

describe('lane thinking resolution', () => {
  it('boots a reasoning model at the config default', async () => {
    const lane = await bootFauxLane({
      ...reasoning(),
      thinking: { config: { level: 'high', source: 'project' } },
    });
    lanes.push(lane);
    expect(await agentThinking(lane)).toBe('high');
  });

  it('clamps an unsupported level with a named notice', async () => {
    const notices: string[] = [];
    const lane = await bootFauxLane({
      onThinkingNotice: (line) => notices.push(line),
      thinking: { config: { level: 'high', source: 'project' } },
    });
    lanes.push(lane);
    expect(await agentThinking(lane)).toBe('off');
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatch(/thinking 'high'.*clamped to 'off'/);
  });

  it('orders override > session > role > config across attach', async () => {
    const root = tempDir('kubic-lane-thinking-');
    const first = await bootFauxLane({
      storage: 'jsonl',
      root,
      sessionId: 'think',
      ...reasoning(),
      thinking: { override: { level: 'high', source: 'cli' } },
    });
    expect(await agentThinking(first)).toBe('high');
    await first.cleanup();

    const reopen = async (
      extra: Partial<FauxLaneOptions>,
    ): Promise<FauxLane> => {
      const store = openSessionStore(root, createNodeFileBridge(root));
      const handle = await attachSession(store, 'think', BACKGROUND_CONTEXT);
      return bootFauxLane({ ...reasoning(), ...extra, handle });
    };

    // No override: the stored level beats the role and config defaults.
    const second = await reopen({
      thinking: { role: 'low', config: { level: 'medium', source: 'project' } },
    });
    lanes.push(second);
    expect(await agentThinking(second)).toBe('high');
    await second.cleanup();

    // An override beats the stored level, even on attach.
    const third = await reopen({
      thinking: { override: { level: 'low', source: 'env' } },
    });
    lanes.push(third);
    expect(await agentThinking(third)).toBe('low');
  });

  it('refuses an unknown level by name instead of booting', async () => {
    await expect(
      bootFauxLane({
        ...reasoning(),
        thinking: { override: { level: 'banana', source: '--thinking' } },
      }),
    ).rejects.toThrow(/banana.*--thinking/);
  });

  // The committed doc is not the claim — the next provider
  // request must carry the booted level. The factory observes the exact
  // options the harness hands the provider (`reasoning`, pi-ai's
  // SimpleStreamOptions), so this pins the agent-doc → request path, not
  // just the doc the boot wrote.
  it('carries the booted level on the next provider request', async () => {
    const seen: Array<string | undefined> = [];
    const lane = await bootFauxLane({
      ...reasoning(),
      thinking: { config: { level: 'high', source: 'project' } },
      responses: [
        (_context, options) => {
          seen.push(options?.reasoning);
          return fauxAssistantMessage('ok');
        },
      ],
    });
    lanes.push(lane);
    const result = await runPrompt(lane.lane, 'hello', { requestId: 'u1' });
    expect(result.status).toBe('completed');
    expect(seen).toEqual(['high']);
  });
});
