// Hook/handler-error + [model] lines on the headless debug channel: a faulted
// harness task (pi-durable task_failed — Pi 1.0 has no handler_error event) and
// each committed response's token counts surface through laneActivityDebugLine,
// which the run's event sink forwards to debug. Faux rows only: no lane, no
// network.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { KubicLaneEvent } from '@kubic/agent/lane/events';
import type { MutableModels } from '@kubic/agent/pi-boundary';
import {
  createModels,
  fauxAssistantMessage,
  fauxProvider,
} from '@kubic/agent/pi-boundary';
import { NodeExecutionEnv } from '@kubic/exec/env';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { laneActivityDebugLine, runHeadlessPrompt } from './headless-run.js';

function usageEvent(): KubicLaneEvent {
  return {
    type: 'usage',
    row: {
      model: 'faux-1',
      provider: 'test',
      usage: {
        input: 120,
        output: 45,
        cacheRead: 30,
        cacheWrite: 0,
        totalTokens: 165,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
    },
    entry: {},
  } as unknown as KubicLaneEvent;
}

describe('laneActivityDebugLine', () => {
  it('maps a lane fault to the handler_error line', () => {
    expect(
      laneActivityDebugLine({
        type: 'fault',
        code: 'tool',
        message: 'task exploded',
      }),
    ).toBe('handler_error hook=tool error=task exploded verdict=deny');
  });

  it('maps a committed response to the [model] token line', () => {
    expect(laneActivityDebugLine(usageEvent())).toBe(
      '[model] in=120 out=45 cached=30 test/faux-1',
    );
  });

  it('still ignores unrelated events', () => {
    expect(
      laneActivityDebugLine({ type: 'run-end', inputs: [] }) as never,
    ).toBe(undefined);
  });
});

describe('headless --debug order', () => {
  const made: string[] = [];

  function tmp(prefix: string): string {
    const dir = mkdtempSync(join(tmpdir(), prefix));
    made.push(dir);
    return dir;
  }

  beforeEach(() => {
    vi.stubEnv('KUBIC_NO_NOTICE', '1');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    for (const dir of made.splice(0))
      rmSync(dir, { recursive: true, force: true });
  });

  function models(): MutableModels {
    const faux = fauxProvider({
      provider: 'faux',
      models: [{ id: 'small', contextWindow: 120000 }],
    });
    faux.setResponses([fauxAssistantMessage('nothing to change')]);
    const registry = createModels();
    registry.setProvider(faux.provider);
    return registry;
  }

  it('a stock faux run emits [policy], [session], [model], [agent] in order', async () => {
    const debugLines: string[] = [];
    const stdout: string[] = [];
    const spy = vi
      .spyOn(process.stdout, 'write')
      .mockImplementation((chunk: unknown) => {
        stdout.push(String(chunk));
        return true;
      });
    try {
      const result = await runHeadlessPrompt(
        'hi',
        { debug: true },
        {
          sessionsRoot: tmp('debug-order-sessions-'),
          models: models(),
          env: new NodeExecutionEnv(tmp('debug-order-cwd-')),
          debug: (line: string) => debugLines.push(line),
          // The flag routes the span lines here instead of the real
          // stderr; the diagnostics channel rides `debug` above.
          debugSink: (line: string) => debugLines.push(line),
        },
      );
      expect(result.terminus).toBe('completed');
    } finally {
      spy.mockRestore();
    }
    const first = (cls: string): number =>
      debugLines.findIndex((line) => line.includes(cls));
    // The stock run resolves no role document but still names its
    // default role.
    expect(debugLines).toContain('[policy] role=default (default)');
    expect(debugLines.some((line) => line.startsWith('[session] id='))).toBe(
      true,
    );
    for (const cls of ['[policy]', '[session]', '[model]', '[agent]']) {
      expect(first(cls)).toBeGreaterThanOrEqual(0);
    }
    // Boot sequence: the session is created before the role resolves,
    // and both precede the first committed response; the run span opens
    // first and closes last.
    expect(first('[session]')).toBeLessThan(first('[policy]'));
    expect(first('[policy]')).toBeLessThan(first('[model]'));
    expect(first('[agent]')).toBeLessThan(first('[model]'));
    const last = (cls: string): number => {
      const indices = debugLines
        .map((line, index) => (line.includes(cls) ? index : -1))
        .filter((index) => index >= 0);
      return indices[indices.length - 1] ?? -1;
    };
    expect(last('[agent]')).toBeGreaterThan(first('[model]'));
    // The debug channel never touches stdout.
    expect(
      stdout.filter((line) =>
        ['[policy]', '[session]', '[model]', '[agent]'].some((cls) =>
          line.includes(cls),
        ),
      ),
    ).toEqual([]);
  }, 60_000);
});
