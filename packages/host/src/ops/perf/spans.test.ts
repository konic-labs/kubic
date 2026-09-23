// Dedicated worker.start span chain RED slice 2 (issue #55; §49.3):
// kubic.agent.run→pi.harness.hook→pi.tool.execute→kubic.worker.start→
// rpc.client→rpc.server, with startup in its own span separable from
// tool ms. Fails until spans.js lands.
import { describe, expect, it, vi } from 'vitest';
import { SpanRecorder } from '../../spans.js';
import {
  closeWorkerStartChain,
  openWorkerStartChain,
  WORKER_START_CHAIN,
} from './spans.js';

describe('dedicated worker.start span chain (§49.3)', () => {
  it('opens the full chain in order with parent linkage', () => {
    const recorder = new SpanRecorder(() => 0);
    const ids = openWorkerStartChain(recorder);
    const names = recorder.trace().map((span) => span.name);
    expect(names).toEqual([...WORKER_START_CHAIN]);
    const trace = recorder.trace();
    for (let index = 1; index < trace.length; index++) {
      expect(trace[index]?.parentId).toBe(trace[index - 1]?.id);
    }
    closeWorkerStartChain(recorder, ids);
    expect(recorder.trace().every((span) => span.endMs !== null)).toBe(true);
  });

  it('keeps startup in its own span, separable from tool ms (fixture)', () => {
    const now = vi.fn();
    const ticks = [0, 100, 110, 130, 130, 150, 150, 160];
    now.mockImplementation(() => ticks.shift() ?? 999);
    const recorder = new SpanRecorder(now);
    const startup = recorder.start('kubic.worker.startup');
    recorder.end(startup);
    const ids = openWorkerStartChain(recorder);
    closeWorkerStartChain(recorder, ids);
    expect(recorder.startupMs()).toBe(100);
    expect(recorder.toolMsTotal()).toBeGreaterThanOrEqual(0);
    const startupSpan = recorder
      .trace()
      .find((span) => span.name === 'kubic.worker.startup');
    const toolSpans = recorder
      .trace()
      .filter((span) => span.name === 'pi.tool.execute');
    expect(startupSpan).toBeDefined();
    expect(toolSpans.length).toBe(1);
    expect(toolSpans[0]?.id).not.toBe(startupSpan?.id);
  });
});
