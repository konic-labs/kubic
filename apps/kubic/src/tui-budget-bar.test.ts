// The TUI budget bar's production wiring (issue #285; §71): tool-start
// events feed the bar's attempt count through TuiTurnRunner — including a
// gate-refused call (the slot goes running before the §71 gate's wrap
// executes, so the loop sees the attempt the gate counted). Faux provider
// only; temp dirs cleaned after.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NodeExecutionEnv } from '../../../packages/exec/src/env.js';
import { createTuiApp } from '../../../packages/tui/src/tui-app.js';
import type { KubicLaneEvent } from '../../../packages/worker/src/lane/events.js';
import { fauxToolUse } from '../../../packages/worker/src/lane/test-harness.js';
import { entriesToTranscript } from '../../../packages/worker/src/lane/transcript.js';
import {
  BACKGROUND_CONTEXT,
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from '../../../packages/worker/src/pi-boundary.js';
import {
  loadExtensionStartup,
  prodExtensionStartupOptions,
} from './extension-startup.js';
import type { TuiLaneLoop } from './tui-run.js';
import { bootTuiLane, TuiTurnRunner } from './tui-run.js';

const made: string[] = [];

function tmpRoot(prefix = 'kubic-tui-budgetbar-'): string {
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

function stubLoop(events: KubicLaneEvent[]): TuiLaneLoop {
  return {
    subscribe: async (sink: (event: KubicLaneEvent) => void) => {
      sink({
        type: 'snapshot',
        entries: [],
        tools: [],
        compactions: [],
        usage: { models: {}, tools: {} },
      });
      for (const event of events) sink(event);
      return async () => {};
    },
    runTurn: async () => ({ kind: 'completed' }),
    entries: async () => [],
    forgetKills: () => {},
  } as unknown as TuiLaneLoop;
}

function toolStart(id: string): KubicLaneEvent {
  return { type: 'tool-start', toolCallId: id, toolName: 'read', args: {} };
}

describe('tui budget bar wiring (issue #285)', () => {
  it('counts tool attempts into the bar through the runner', async () => {
    const app = createTuiApp({
      sessionId: 's1',
      model: 'fx/a',
      mode: 'solo',
      approvalsSkipped: false,
      budgetLimits: { maxToolCalls: 10 },
    });
    const runner = new TuiTurnRunner(
      app,
      stubLoop([toolStart('c1'), toolStart('c2')]),
      'fx/a',
    );
    await runner.run('hi');
    expect(app.status.getState().budget?.toolCalls).toBe(2);
    expect(app.render(120).join('\n')).toContain('budget tools 2/10');
  });

  it('counts a gate-refused call: the bar mirrors the gate', async () => {
    const workspace = tmpRoot('kubic-tui-budgetbar-ws-');
    const target = join(workspace, 'note.txt');
    writeFileSync(target, 'hello\n');
    const cwd = tmpRoot('kubic-tui-budgetbar-cwd-');
    const extensions = await loadExtensionStartup('tui', cwd, {
      options: prodExtensionStartupOptions(cwd, { maxToolCalls: 1 }),
    });
    const faux = fauxProvider({ provider: 'fx', models: [{ id: 'a' }] });
    faux.setResponses([
      fauxToolUse([
        fauxToolCall('read', { path: target }),
        fauxToolCall('read', { path: target }),
      ]),
      fauxAssistantMessage('done'),
    ]);
    const models = createModels();
    models.setProvider(faux.provider);
    const boot = await bootTuiLane(undefined, {
      sessionsRoot: tmpRoot(),
      models,
      env: new NodeExecutionEnv(workspace),
      extensions,
    });
    const loop = boot.loop;
    if (loop === undefined) throw new Error('the prod boot returned no loop');
    const app = createTuiApp({
      sessionId: 's1',
      model: 'fx/a',
      mode: 'solo',
      approvalsSkipped: false,
      budgetLimits: { maxToolCalls: 1 },
    });
    const runner = new TuiTurnRunner(app, loop, 'fx/a');
    try {
      await runner.run('read it twice');
      // Two attempts reached the gate; the second was refused — the bar
      // shows the gate's count (2), past the bound (1).
      expect(app.status.getState().budget?.toolCalls).toBe(2);
      expect(app.render(120).join('\n')).toContain('budget tools 2/1');
    } finally {
      await boot.close?.();
    }
  });
});

describe('a resumed TUI session keeps its tool-call count (issue #440)', () => {
  it('the boot reads the committed calls, the gate refuses past the cap and the bar continues', async () => {
    const workspace = tmpRoot('kubic-tui-budget-resume-ws-');
    const target = join(workspace, 'note.txt');
    writeFileSync(target, 'hello\n');
    const cwd = tmpRoot('kubic-tui-budget-resume-cwd-');
    const sessionsRoot = tmpRoot();
    const extensions = await loadExtensionStartup('tui', cwd, {
      options: prodExtensionStartupOptions(cwd, { maxToolCalls: 3 }),
    });
    const bootWith = (sessionId: string | undefined, reads: number) => {
      const faux = fauxProvider({ provider: 'fx', models: [{ id: 'a' }] });
      faux.setResponses([
        ...Array.from({ length: reads }, () =>
          fauxToolUse([fauxToolCall('read', { path: target })]),
        ),
        fauxAssistantMessage('done'),
      ]);
      const models = createModels();
      models.setProvider(faux.provider);
      return bootTuiLane(sessionId, {
        sessionsRoot,
        models,
        env: new NodeExecutionEnv(workspace),
        extensions,
      });
    };
    const appFor = () =>
      createTuiApp({
        sessionId: 's1',
        model: 'fx/a',
        mode: 'solo',
        approvalsSkipped: false,
        budgetLimits: { maxToolCalls: 3 },
      });
    // The first boot spends two of the three calls.
    const first = await bootWith(undefined, 2);
    try {
      if (first.loop === undefined) throw new Error('no loop');
      await new TuiTurnRunner(appFor(), first.loop, 'fx/a').run('read twice');
    } finally {
      await first.close?.();
    }
    const resumed = await bootWith(first.sessionId, 2);
    try {
      const loop = resumed.loop;
      if (loop === undefined) throw new Error('no loop');
      expect(resumed.toolCalls).toBe(2);
      const app = appFor();
      const runner = new TuiTurnRunner(
        app,
        loop,
        'fx/a',
        undefined,
        undefined,
        [],
        undefined,
        undefined,
        resumed.toolCalls,
      );
      await runner.run('read twice more');
      // The third call overall ran; the fourth reached the gate and was
      // refused, and the bar counts on from the session's two.
      const results = entriesToTranscript(
        await loop.entries(BACKGROUND_CONTEXT),
      ).filter((item) => item.kind === 'tool-result');
      expect(results.map((item) => item.isError)).toEqual([
        false,
        false,
        false,
        true,
      ]);
      expect(app.status.getState().budget?.toolCalls).toBe(4);
    } finally {
      await resumed.close?.();
    }
  });
});
