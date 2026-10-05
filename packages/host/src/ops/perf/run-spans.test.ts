// Run-span emission (issue #98; §49.3, §50, §61): RED first — run-spans.ts
// lands after this file. The recorder is the §29 SpanRecorder; this module
// only maps live lane/tool events onto it and serializes the result.
// Faux-only: injected clock, no I/O, no network.
import { describe, expect, it, vi } from 'vitest';
import {
  BACKGROUND_CONTEXT,
  createModels,
  createRegistry,
  defineExtension,
  defineTool,
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
  Harness,
  MemoryStorage,
  Type,
} from '../../../../worker/src/pi-boundary.js';
import { SpanRecorder } from '../../spans.js';
import {
  RUN_SPAN_NAMES,
  RunSpans,
  runSpanHooks,
  serializeSpanArtifact,
} from './run-spans.js';

function ticks(values: number[]): () => number {
  const queue = [...values];
  return () => queue.shift() ?? values[values.length - 1] ?? 0;
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

  it('closes a tool span its call never settled when the run ends', () => {
    const spans = new RunSpans(ticks([0, 0, 3]));
    const run = spans.startRun();
    spans.startTool('call-4', 'read');
    spans.endRun(run);
    const tool = spans
      .trace()
      .find((span) => span.name === RUN_SPAN_NAMES.tool);
    // No dangling span: endRun closes it and names why it never settled.
    expect(tool?.endMs).not.toBeNull();
    expect(tool?.error).toBe('run ended before the call settled');
    expect(spans.debugLines()).toContain(
      '[tool] out read call=call-4 ms=3 status=error ' +
        'error=run ended before the call settled',
    );
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

describe('runSpanHooks (issue #98, #397)', () => {
  it('records one before/after pair per tool call on a real harness', async () => {
    const spans = new RunSpans();
    const run = spans.startRun();
    const faux = fauxProvider();
    const models = createModels();
    models.setProvider(faux.provider);
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall('probe', { value: 'a' }), {
        stopReason: 'toolUse',
      }),
      fauxAssistantMessage('done'),
    ]);
    const registry = createRegistry();
    registry.install(
      defineExtension({ name: 'kubic.spans', hooks: runSpanHooks(spans) }),
    );
    registry.install(
      defineExtension({
        name: 'kubic',
        tools: [
          defineTool({
            name: 'probe',
            description: 'returns after doing nothing',
            parameters: Type.Object({ value: Type.String() }),
            execute: async () => ({
              content: [{ type: 'text', text: 'probed' }],
            }),
          }),
        ],
      }),
    );
    const harness = await Harness.open(
      new MemoryStorage(),
      { models, registry },
      BACKGROUND_CONTEXT,
    );
    try {
      const model = faux.getModel();
      const root = await harness.root(BACKGROUND_CONTEXT, {
        agent: { model: { provider: model.provider, modelId: model.id } },
      });
      const submission = await root.submit(
        { type: 'input', content: 'go' },
        BACKGROUND_CONTEXT,
      );
      expect((await submission.wait(BACKGROUND_CONTEXT)).status).toBe('done');
      spans.endRun(run);
      const tools = spans
        .trace()
        .filter((span) => span.name === RUN_SPAN_NAMES.tool);
      expect(tools).toHaveLength(1);
      expect(tools[0]?.toolName).toBe('probe');
      expect(tools[0]?.endMs).not.toBeNull();
      expect(
        spans.debugLines().some((line) => line.startsWith('[tool] in probe')),
      ).toBe(true);
      expect(
        spans
          .debugLines()
          .some(
            (line) =>
              line.startsWith('[tool] out probe') && line.includes('ok'),
          ),
      ).toBe(true);
    } finally {
      await harness.close(BACKGROUND_CONTEXT);
    }
  });

  it('marks an errored tool result on the span', async () => {
    const spans = new RunSpans();
    const run = spans.startRun();
    const faux = fauxProvider();
    const models = createModels();
    models.setProvider(faux.provider);
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall('failing', {}), {
        stopReason: 'toolUse',
      }),
      fauxAssistantMessage('done'),
    ]);
    const registry = createRegistry();
    registry.install(
      defineExtension({ name: 'kubic.spans', hooks: runSpanHooks(spans) }),
    );
    registry.install(
      defineExtension({
        name: 'kubic',
        tools: [
          defineTool({
            name: 'failing',
            description: 'fails on purpose',
            parameters: Type.Object({}),
            execute: async () => ({
              content: [{ type: 'text', text: 'boom' }],
              isError: true,
            }),
          }),
        ],
      }),
    );
    const harness = await Harness.open(
      new MemoryStorage(),
      { models, registry },
      BACKGROUND_CONTEXT,
    );
    try {
      const model = faux.getModel();
      const root = await harness.root(BACKGROUND_CONTEXT, {
        agent: { model: { provider: model.provider, modelId: model.id } },
      });
      const submission = await root.submit(
        { type: 'input', content: 'go' },
        BACKGROUND_CONTEXT,
      );
      await submission.wait(BACKGROUND_CONTEXT);
      spans.endRun(run);
      const tool = spans
        .trace()
        .find((span) => span.name === RUN_SPAN_NAMES.tool);
      expect(tool?.error).toBe('tool reported an error');
    } finally {
      await harness.close(BACKGROUND_CONTEXT);
    }
  });

  it('never blocks a call and returns the afterTool result unchanged', async () => {
    const spans = new RunSpans(ticks([0, 0, 1]));
    const registration = runSpanHooks(spans)[0];
    const handlers = registration?.handlers as {
      beforeTool?: (
        call: { id: string; name: string },
        api: unknown,
        context: unknown,
      ) => unknown;
      afterTool?: (
        call: { id: string; name: string },
        result: unknown,
        api: unknown,
        context: unknown,
      ) => unknown;
    };
    expect(
      await handlers.beforeTool?.({ id: 'c1', name: 'read' }, {}, {}),
    ).toBe(undefined);
    const result = {
      content: [{ type: 'text' as const, text: 'x' }],
      isError: false,
    };
    expect(
      await handlers.afterTool?.({ id: 'c1', name: 'read' }, result, {}, {}),
    ).toBe(result);
  });
});

describe('RunSpans per-span cost (issue #243)', () => {
  it('opens and closes 1,000 tool spans without copying the trace', () => {
    const spans = new RunSpans(() => 0);
    const run = spans.startRun();
    const seen = vi.spyOn(SpanRecorder.prototype, 'trace');
    try {
      seen.mockClear();
      for (let index = 0; index < 1000; index += 1) {
        const call = `call-${String(index)}`;
        spans.startTool(call, 'read');
        spans.endTool(call);
      }
      // Opening or closing one span must never map-copy every span:
      // the hot path stays O(1) per tool call, not O(n^2) per run.
      expect(seen).not.toHaveBeenCalled();
    } finally {
      seen.mockRestore();
    }
    spans.endRun(run);
    expect(spans.trace()).toHaveLength(1001);
  });
});
