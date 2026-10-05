// Span recorder (§49.3): nested trace with startup isolated from tool ms.
import { describe, expect, it, vi } from 'vitest';
import {
  createTranscriptSink,
  DebugLog,
  makeWriteLogSink,
  runHook,
  SpanRecorder,
} from './spans.js';

describe('SpanRecorder (§49.3 order + startup isolation)', () => {
  it('nests kubic.agent.run→pi.harness.hook→pi.tool.execute→kubic.worker.start→rpc in order', () => {
    const now = vi.fn();
    const ticks = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11];
    now.mockImplementation(() => ticks.shift() ?? 99);
    const recorder = new SpanRecorder(now);
    const run = recorder.start('kubic.agent.run');
    const hook = recorder.start('pi.harness.hook', run);
    const tool = recorder.start('pi.tool.execute', hook);
    const start = recorder.start('kubic.worker.start', tool);
    const rpc = recorder.start('rpc', start);
    recorder.end(rpc);
    recorder.end(start);
    recorder.end(tool);
    recorder.end(hook);
    recorder.end(run);
    const names = recorder.trace().map((span) => span.name);
    expect(names).toEqual([
      'kubic.agent.run',
      'pi.harness.hook',
      'pi.tool.execute',
      'kubic.worker.start',
      'rpc',
    ]);
    const rpcSpan = recorder.trace().find((span) => span.name === 'rpc');
    expect(rpcSpan?.parentId).toBe(start);
  });

  it('isolates kubic.worker.startup from tool ms', () => {
    const now = vi.fn();
    const ticks = [0, 100, 110, 130, 130, 150];
    now.mockImplementation(() => ticks.shift() ?? 999);
    const recorder = new SpanRecorder(now);
    const startup = recorder.start('kubic.worker.startup');
    recorder.end(startup);
    const tool = recorder.start('pi.tool.execute');
    recorder.end(tool);
    expect(recorder.startupMs()).toBe(100);
    expect(recorder.toolMsTotal()).toBe(20);
  });
});

describe('DebugLog (§50 --debug vocabulary, 9 classes)', () => {
  it('emits all 9 classes with in/out/cached + exited cleanly (0 leaked handles)', () => {
    const lines: string[] = [];
    const debug = new DebugLog((line: string) => lines.push(line));
    debug.policy('route=ask-user tool=bash');
    debug.worker('spawned pid=4242');
    debug.session('attached abc123');
    debug.tool('in', 'bash command="ls"');
    debug.tool('out', 'bash status=0');
    debug.tool('cached', 'bash memo-hit');
    debug.model(120, 45, 30, 'llama3');
    debug.agent('turn=3 done');
    debug.hookError('onToolEnd', new Error('boom'));
    debug.exit(0);
    debug.handles(0);
    const joined = lines.join('\n');
    for (const cls of [
      '[policy]',
      '[worker]',
      '[session]',
      '[tool]',
      '[model]',
      '[agent]',
      '[exit]',
      '[handles]',
      'handler_error',
    ]) {
      expect(joined).toContain(cls);
    }
    expect(joined).toContain('in=120 out=45 cached=30');
    expect(joined).toContain('exited cleanly');
    expect(joined).toContain('0 leaked handles');
  });
});

describe('runHook (failing hook → handler_error, fails closed)', () => {
  it('denies closed, surfaces handler_error in output and trace', async () => {
    const lines: string[] = [];
    const debug = new DebugLog((line: string) => lines.push(line));
    const recorder = new SpanRecorder(() => 0);
    const result = await runHook(
      'onToolEnd',
      () => {
        throw new Error('boom');
      },
      { debug, recorder },
    );
    expect(result.ok).toBe(false);
    expect(result.denied).toBe(true);
    expect(lines.join('\n')).toContain('handler_error');
    const hookSpan = recorder
      .trace()
      .find((span) => span.name === 'pi.harness.hook');
    expect(hookSpan?.error).toContain('handler_error');
  });
});

describe('debug transcript (headless transcript + PI_TUI_WRITE_LOG ANSI path)', () => {
  it('headless transcript contains [policy] and [worker] exited lines', () => {
    const transcript = createTranscriptSink();
    const debug = new DebugLog(transcript.sink);
    debug.policy('route=ask-user tool=bash');
    debug.worker('task done');
    debug.exit(0);
    const joined = transcript.lines.join('\n');
    expect(joined).toContain('[policy]');
    expect(joined).toContain('[worker]');
    expect(joined).toContain('exited');
  });

  it('routes lines to PI_TUI_WRITE_LOG when set, null otherwise', () => {
    const appended: Array<{ path: string; text: string }> = [];
    const sink = makeWriteLogSink(
      { PI_TUI_WRITE_LOG: '/tmp/kubic-tui.log' },
      (path: string, text: string) => appended.push({ path, text }),
    );
    expect(sink).not.toBeNull();
    sink?.('[policy] route=ask-user');
    sink?.('[worker] task done exited');
    const joined = appended.map((entry) => entry.text).join('');
    expect(appended[0]?.path).toBe('/tmp/kubic-tui.log');
    expect(joined).toContain('[policy]');
    expect(joined).toContain('[worker]');
    expect(makeWriteLogSink({}, () => undefined)).toBeNull();
  });
});

describe('SpanRecorder keyed lookup (issue #243)', () => {
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
    const id = recorder.start('rpc');
    const read = recorder.get(id);
    expect(read).not.toBeUndefined();
    if (read !== undefined) read.endMs = 999;
    expect(recorder.get(id)?.endMs).toBeNull();
  });
});
