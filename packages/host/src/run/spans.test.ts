// Span recorder: nested trace with per-tool time.
import { describe, expect, it, vi } from 'vitest';
import { DebugLog, SpanRecorder } from './spans.js';

describe('SpanRecorder (order + per-tool time)', () => {
  it('nests kubic.agent.run→pi.harness.hook→pi.tool.execute in order', () => {
    const now = vi.fn();
    const ticks = [0, 1, 2, 3, 4, 5, 6, 7];
    now.mockImplementation(() => ticks.shift() ?? 99);
    const recorder = new SpanRecorder(now);
    const run = recorder.start('kubic.agent.run');
    const hook = recorder.start('pi.harness.hook', run);
    const tool = recorder.start('pi.tool.execute', hook);
    recorder.end(tool);
    recorder.end(hook);
    recorder.end(run);
    const names = recorder.trace().map((span) => span.name);
    expect(names).toEqual([
      'kubic.agent.run',
      'pi.harness.hook',
      'pi.tool.execute',
    ]);
    const toolSpan = recorder
      .trace()
      .find((span) => span.name === 'pi.tool.execute');
    expect(toolSpan?.parentId).toBe(hook);
  });

  it('counts only pi.tool.execute spans as tool time', () => {
    const now = vi.fn();
    const ticks = [0, 100, 110, 130];
    now.mockImplementation(() => ticks.shift() ?? 999);
    const recorder = new SpanRecorder(now);
    const run = recorder.start('kubic.agent.run');
    recorder.end(run);
    const tool = recorder.start('pi.tool.execute');
    recorder.end(tool);
    expect(recorder.toolMsTotal()).toBe(20);
  });
});

describe('DebugLog (--debug vocabulary, 7 classes)', () => {
  it('emits all 7 classes with in/out/cached + exited cleanly', () => {
    const lines: string[] = [];
    const debug = new DebugLog((line: string) => lines.push(line));
    debug.policy('route=ask-user tool=bash');
    debug.session('attached abc123');
    debug.tool('in', 'bash command="ls"');
    debug.tool('out', 'bash status=0');
    debug.tool('cached', 'bash memo-hit');
    debug.model(120, 45, 30, 'llama3');
    debug.agent('turn=3 done');
    debug.hookError('onToolEnd', new Error('boom'));
    debug.exit(0);
    // No leak line — nothing ever measured a leak count.
    expect(lines.join('\n')).not.toContain('leaked handles');
    const joined = lines.join('\n');
    for (const cls of [
      '[policy]',
      '[session]',
      '[tool]',
      '[model]',
      '[agent]',
      '[exit]',
      'handler_error',
    ]) {
      expect(joined).toContain(cls);
    }
    expect(joined).toContain('in=120 out=45 cached=30');
    expect(joined).toContain('exited cleanly');
  });
});

// A collector for the lines a debug sink writes.
const transcriptSink = () => {
  const lines: string[] = [];
  return { sink: (line: string) => lines.push(line), lines };
};

describe('debug transcript (headless transcript + PI_TUI_WRITE_LOG ANSI path)', () => {
  it('headless transcript contains the [policy] and exit lines', () => {
    const transcript = transcriptSink();
    const debug = new DebugLog(transcript.sink);
    debug.policy('route=ask-user tool=bash');
    debug.exit(0);
    const joined = transcript.lines.join('\n');
    expect(joined).toContain('[policy]');
    expect(joined).toContain('exited');
  });
});

describe('SpanRecorder keyed lookup', () => {
  it('reads one span by id without copying the trace', () => {
    const recorder = new SpanRecorder(() => 7);
    const first = recorder.start('kubic.agent.run');
    const second = recorder.start('pi.tool.execute', first);
    recorder.end(second, 'boom');
    expect(recorder.get(first)).toMatchObject({ id: first, endMs: null });
    expect(recorder.get(second)).toMatchObject({
      id: second,
      name: 'pi.tool.execute',
      error: 'boom',
    });
    expect(recorder.get('span-404')).toBeUndefined();
  });

  it('hands out a copy, so a reader cannot rewrite the record', () => {
    const recorder = new SpanRecorder(() => 0);
    const id = recorder.start('pi.tool.execute');
    const read = recorder.get(id);
    expect(read).not.toBeUndefined();
    if (read !== undefined) read.endMs = 999;
    expect(recorder.get(id)?.endMs).toBeNull();
  });
});
