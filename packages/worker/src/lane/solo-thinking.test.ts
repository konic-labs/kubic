// The lane boots at the resolved thinking level (issue #225; §38.3):
// override > the session's stored level > role > config, clamped to the
// effective model. Faux provider only: zero network, zero paid tokens.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createNodeFileBridge } from '../../../exec/src/file-bridge.js';
import { BACKGROUND_CONTEXT } from '../pi-boundary.js';
import { attachSession, openSessionStore } from './session-store.js';
import {
  bootFauxLane,
  type FauxLane,
  type FauxLaneOptions,
} from './test-harness.js';

const dirs: string[] = [];
const lanes: FauxLane[] = [];

afterEach(async () => {
  for (const lane of lanes.splice(0)) await lane.cleanup();
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), 'kubic-solo-thinking-'));
  dirs.push(dir);
  return dir;
}

function reasoning() {
  return {
    models: [{ id: 'deep', reasoning: true }] as const,
    model: 'deep',
  };
}

async function agentThinking(lane: FauxLane): Promise<unknown> {
  return (await lane.solo.conversation.agent(BACKGROUND_CONTEXT)).thinkingLevel;
}

describe('lane thinking resolution (issue #225)', () => {
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
    const root = scratch();
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
});
