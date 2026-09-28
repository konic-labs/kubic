// Run-span emission (issue #98; §49.3, §50, §61): RED first — run-spans.ts
// lands after this file. The recorder is the §29 SpanRecorder; this module
// only maps live lane/tool events onto it and serializes the result.
// Faux-only: injected clock, no I/O, no network.
import { describe, expect, it } from 'vitest';
import {
  attachToolSpans,
  RUN_SPAN_NAMES,
  RunSpans,
  serializeSpanArtifact,
} from './run-spans.js';

function ticks(values: number[]): () => number {
  const queue = [...values];
  return () => queue.shift() ?? values[values.length - 1] ?? 0;
}

// Minimal stand-in for the harness hook registry: same shape as the Pi
// `Hooks.on` seam (register → unsubscribe), no Pi import in the test.
function hookRegistry() {
  const before: Array<(event: unknown) => unknown> = [];
  const after: Array<(event: unknown) => unknown> = [];
  return {
    hooks: {
      on: (name: string, handler: (event: never) => unknown): (() => void) => {
        const list = name === 'before_tool' ? before : after;
        list.push(handler as (event: unknown) => unknown);
        return () => {
          const at = list.indexOf(handler as (event: unknown) => unknown);
          if (at !== -1) list.splice(at, 1);
        };
      },
    },
    fireBefore: (event: unknown) => Promise.all(before.map((h) => h(event))),
    fireAfter: (event: unknown) => Promise.all(after.map((h) => h(event))),
    beforeCount: () => before.length,
    afterCount: () => after.length,
  };
}

describe('RunSpans lane/tool trace (issue #98)', () => {
  it('nests run → accept → drive → tool in the recorded order', () => {
    const spans = new RunSpans(ticks([0, 1, 2, 3, 4, 5, 6, 7]));
    const run = spans.startRun();
    const accept = spans.startLane('accept');
    spans.endLane(accept);
    const drive = spans.startLane('drive');
    spans.startTool('call-1', 'read');
    spans.endTool('call-1');
    spans.endLane(drive);
    spans.endRun(run);
    const trace = spans.trace();
    expect(trace.map((span) => span.name)).toEqual([
      RUN_SPAN_NAMES.run,
      RUN_SPAN_NAMES.accept,
      RUN_SPAN_NAMES.drive,
      RUN_SPAN_NAMES.tool,
    ]);
    expect(trace.map((span) => span.parentId)).toEqual([null, run, run, drive]);
    expect(trace[3]?.endMs).not.toBeNull();
  });

  it('records the tool name and duration on the tool span', () => {
    const spans = new RunSpans(ticks([10, 10, 42]));
    const run = spans.startRun();
    spans.startTool('call-9', 'write');
    spans.endTool('call-9');
    spans.endRun(run);
    const tool = spans
      .trace()
      .find((span) => span.name === RUN_SPAN_NAMES.tool);
    expect(tool?.toolName).toBe('write');
    expect(tool?.endMs).toBe(42);
  });

  it('marks a failed tool call with its error', () => {
    const spans = new RunSpans(ticks([0, 0, 5]));
    const run = spans.startRun();
    spans.startTool('call-2', 'bash');
    spans.endTool('call-2', 'exit 1');
    spans.endRun(run);
    const tool = spans
      .trace()
      .find((span) => span.name === RUN_SPAN_NAMES.tool);
    expect(tool?.error).toBe('exit 1');
  });

  it('ignores a repeated end for the same tool call instead of throwing', () => {
    const spans = new RunSpans(ticks([0, 1, 2, 3]));
    const run = spans.startRun();
    spans.startTool('call-3', 'ls');
    spans.endTool('call-3');
    expect(() => spans.endTool('call-3')).not.toThrow();
    expect(() => spans.endTool('never-started')).not.toThrow();
    spans.endRun(run);
    expect(
      spans.trace().filter((span) => span.name === RUN_SPAN_NAMES.tool),
    ).toHaveLength(1);
  });

  it('leaves a tool span open (endMs null) when its call never settles', () => {
    const spans = new RunSpans(ticks([0, 0]));
    const run = spans.startRun();
    spans.startTool('call-4', 'read');
    spans.endRun(run);
    const tool = spans
      .trace()
      .find((span) => span.name === RUN_SPAN_NAMES.tool);
    expect(tool?.endMs).toBeNull();
  });
});

describe('RunSpans §50 debug lines (issue #98)', () => {
  it('emits in/out lines with the tool name and duration only', () => {
    const spans = new RunSpans(ticks([0, 0, 7, 9]));
    const run = spans.startRun();
    spans.startTool('call-5', 'grep');
    spans.endTool('call-5');
    spans.endRun(run);
    const lines = spans.debugLines();
    expect(lines).toContain('[tool] in grep call=call-5');
    expect(lines).toContain('[tool] out grep call=call-5 ms=7 status=ok');
  });

  it('reports a failed tool call on the out line', () => {
    const spans = new RunSpans(ticks([0, 0, 3]));
    const run = spans.startRun();
    spans.startTool('call-6', 'bash');
    spans.endTool('call-6', 'boom');
    spans.endRun(run);
    expect(spans.debugLines()).toContain(
      '[tool] out bash call=call-6 ms=3 status=error error=boom',
    );
  });

  it('never emits a debug class outside the §50 nine', () => {
    const spans = new RunSpans(ticks([0, 0, 1, 2, 3, 4, 5, 6]));
    const run = spans.startRun();
    const drive = spans.startLane('drive');
    spans.startTool('call-7', 'read');
    spans.endTool('call-7');
    spans.endLane(drive);
    spans.endRun(run);
    const lines = spans.debugLines();
    // Non-vacuous: the run, lane and tool all produced lines to check.
    expect(lines.some((line) => line.startsWith('[agent]'))).toBe(true);
    expect(lines.some((line) => line.startsWith('[tool]'))).toBe(true);
    for (const line of lines) {
      expect(line).toMatch(
        /^\[(policy|worker|session|tool|model|agent|exit|handles)\]/,
      );
    }
  });
});

describe('span artifact serialization (issue #98)', () => {
  it('writes one JSON object per span, tagged with the run id', () => {
    const spans = new RunSpans(ticks([0, 1, 2, 3, 4, 5]));
    const run = spans.startRun();
    spans.startTool('call-8', 'read');
    spans.endTool('call-8');
    spans.endRun(run);
    const jsonl = serializeSpanArtifact(spans.trace(), run, 'sess-1');
    const lines = jsonl.trim().split('\n');
    expect(lines).toHaveLength(2);
    const parsed = lines.map(
      (line) => JSON.parse(line) as Record<string, unknown>,
    );
    expect(parsed.map((record) => record.name)).toEqual([
      RUN_SPAN_NAMES.run,
      RUN_SPAN_NAMES.tool,
    ]);
    for (const record of parsed) {
      expect(record.run).toBe(run);
      expect(record.sessionId).toBe('sess-1');
      expect(typeof record.startMs).toBe('number');
    }
    expect(jsonl.endsWith('\n')).toBe(true);
  });
});

describe('attachToolSpans (issue #98)', () => {
  it('opens a tool span on before_tool and closes it on after_tool', async () => {
    const spans = new RunSpans(ticks([0, 0, 4]));
    const run = spans.startRun();
    const registry = hookRegistry();
    const detach = attachToolSpans(registry.hooks, spans);
    await registry.fireBefore({
      toolCallId: 'c1',
      toolName: 'read',
      args: { path: 'a.txt' },
    });
    await registry.fireAfter({
      toolCallId: 'c1',
      toolName: 'read',
      isError: false,
    });
    spans.endRun(run);
    const tool = spans
      .trace()
      .find((span) => span.name === RUN_SPAN_NAMES.tool);
    expect(tool?.toolName).toBe('read');
    expect(tool?.endMs).toBe(4);
    detach();
    expect(registry.beforeCount()).toBe(0);
    expect(registry.afterCount()).toBe(0);
  });

  it('records the error when the harness reports an errored call', async () => {
    const spans = new RunSpans(ticks([0, 0, 2]));
    const run = spans.startRun();
    const registry = hookRegistry();
    attachToolSpans(registry.hooks, spans);
    await registry.fireBefore({ toolCallId: 'c2', toolName: 'bash', args: {} });
    await registry.fireAfter({
      toolCallId: 'c2',
      toolName: 'bash',
      isError: true,
    });
    spans.endRun(run);
    const tool = spans
      .trace()
      .find((span) => span.name === RUN_SPAN_NAMES.tool);
    expect(tool?.error).toBe('tool reported an error');
  });

  it('never blocks a tool call: handlers resolve undefined', async () => {
    const spans = new RunSpans(ticks([0, 0, 1]));
    const registry = hookRegistry();
    attachToolSpans(registry.hooks, spans);
    const results = await registry.fireBefore({
      toolCallId: 'c3',
      toolName: 'read',
      args: {},
    });
    expect(results).toEqual([undefined]);
    const after = await registry.fireAfter({
      toolCallId: 'c3',
      toolName: 'read',
      isError: false,
    });
    expect(after).toEqual([undefined]);
  });

  it('does not throw when an after_tool event has no matching start', async () => {
    const spans = new RunSpans(ticks([0]));
    const registry = hookRegistry();
    attachToolSpans(registry.hooks, spans);
    await expect(
      registry.fireAfter({
        toolCallId: 'ghost',
        toolName: 'read',
        isError: false,
      }),
    ).resolves.toEqual([undefined]);
  });
});
