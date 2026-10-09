// The turn on its own, over a booted faux lane: a completed turn reports its
// text, an interrupt before the turn drives nothing, and `--max-turns` stops
// a tool loop as a guard stop that abandons the live turn.
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { killLaneProcesses } from '@kubic/agent/lane/abort';
import type { Lane } from '@kubic/agent/lane/boot';
import {
  entriesToTranscript,
  readConversationEntries,
} from '@kubic/agent/lane/transcript';
import {
  BACKGROUND_CONTEXT,
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from '@kubic/agent/pi-boundary';
import { NodeExecutionEnv } from '@kubic/exec/env';
import { afterEach, describe, expect, it } from 'vitest';
import { bootLane, createRunBoot } from './boot.js';
import { closeRun } from './close.js';
import { RunGuard } from './guard.js';
import type { HeadlessRunOptions } from './options.js';
import { RunState } from './state.js';
import { runTurn } from './turn.js';

const made: string[] = [];
afterEach(() => {
  for (const dir of made.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

function tmp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  made.push(dir);
  return dir;
}

type Responses = Parameters<ReturnType<typeof fauxProvider>['setResponses']>[0];

async function bootedRun(
  responses: Responses,
  options: HeadlessRunOptions = {},
) {
  const workspace = tmp('run-turn-ws-');
  writeFileSync(join(workspace, 'a.txt'), 'spin\n');
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  faux.setResponses(responses);
  const signals = new EventEmitter();
  const notices: string[] = [];
  const state = new RunState('hello', options, {
    sessionsRoot: tmp('run-turn-sessions-'),
    env: new NodeExecutionEnv(workspace),
    models,
    modelsCwd: workspace,
    roles: { cwd: workspace },
    skills: { cwd: workspace, homeDir: tmp('run-turn-home-'), trusted: false },
    signals,
    notice: (line) => notices.push(line),
    warn: (line) => notices.push(line),
  });
  const guard = new RunGuard(state.context, signals, options.maxTurns);
  const boot = createRunBoot(state, guard);
  expect(await boot.open()).toBeUndefined();
  state.attach(boot);
  guard.start(60_000, () => killLaneProcesses(boot.lane));
  expect(await bootLane(state, boot)).toBeUndefined();
  return {
    state,
    guard,
    boot,
    signals,
    lane: boot.lane as Lane,
    close: () => closeRun(state, boot, guard),
  };
}

function toolRound() {
  return fauxAssistantMessage([fauxToolCall('read', { path: 'a.txt' })], {
    stopReason: 'toolUse',
  });
}

describe('runTurn', () => {
  it('reports a completed turn with its final assistant text', async () => {
    const run = await bootedRun([fauxAssistantMessage('the answer')]);
    try {
      expect(await runTurn(run.state, run.boot, run.guard)).toEqual({
        kind: 'completed',
        summary: 'the answer',
      });
      expect(run.state.capture.lane).toBeDefined();
      expect(run.state.abandoned).toBe(false);
    } finally {
      await run.close();
    }
  });

  it('reports an interrupt that arrived before the turn without driving the prompt', async () => {
    const run = await bootedRun([fauxAssistantMessage('never sent')]);
    try {
      run.signals.emit('SIGINT', 'SIGINT');
      expect(await runTurn(run.state, run.boot, run.guard)).toEqual({
        kind: 'interrupted',
        signal: 'SIGINT',
      });
      const items = entriesToTranscript(
        await readConversationEntries(
          run.lane.conversation,
          BACKGROUND_CONTEXT,
        ),
      );
      expect(items.some((item) => item.kind === 'assistant')).toBe(false);
      expect(run.state.abandoned).toBe(false);
    } finally {
      await run.close();
    }
  });

  it('stops a tool loop past --max-turns as the turn bound and abandons the live turn', async () => {
    const run = await bootedRun(
      [toolRound(), toolRound(), toolRound(), fauxAssistantMessage('done')],
      { maxTurns: 1 },
    );
    try {
      expect(await runTurn(run.state, run.boot, run.guard)).toEqual({
        kind: 'turn-limit',
        turns: 1,
      });
      expect(run.state.abandoned).toBe(true);
    } finally {
      await run.close();
    }
  });
});
