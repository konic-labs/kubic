// An orchestrator worker's tool facts (issue #464): one redacted line per
// tool start and end, with an edit's or write's display diff — and never
// the raw arguments.
import { describe, expect, it } from 'vitest';
import type { WorkerToolActivity } from '../../../packages/core/src/presentation.js';
import { parseFactLine } from '../../../packages/worker/src/lifecycle/facts.js';
import { createWorkerToolFacts } from './worker-facts.js';

function sink() {
  const lines: string[] = [];
  let at = 0;
  const facts = createWorkerToolFacts(
    (line) => lines.push(line),
    () => {
      at += 1;
      return at;
    },
  );
  const parsed = (): WorkerToolActivity[] =>
    lines.map((line) => parseFactLine(line) as WorkerToolActivity);
  return { facts, lines, parsed };
}

const result = (details: unknown, text = 'ok'): unknown => ({
  model: [{ role: 'toolResult', content: [{ type: 'text', text }], details }],
});

describe('worker tool facts (issue #464)', () => {
  it('reports a start and an end with the summary the progress lines print', () => {
    const { facts, parsed } = sink();
    facts.toolStart({
      toolCallId: 'c1',
      toolName: 'read',
      args: { path: 'src/cart.js', offset: 10 },
    });
    facts.toolEnd({ toolCallId: 'c1', toolName: 'read', isError: false });
    expect(parsed()).toEqual([
      {
        id: 'c1',
        tool: 'read',
        target: 'src/cart.js',
        state: 'running',
        at: 1,
      },
      { id: 'c1', tool: 'read', target: 'src/cart.js', state: 'done', at: 2 },
    ]);
  });

  it('redacts secrets and never ships the raw arguments', () => {
    const { facts, lines, parsed } = sink();
    facts.toolStart({
      toolCallId: 'c1',
      toolName: 'bash',
      args: {
        command: 'curl -H "Authorization: Bearer abc123secret" https://x.dev',
        env: { HIDDEN_VALUE: 'never-seen-outside' },
      },
    });
    expect(parsed()[0]?.target).not.toContain('abc123secret');
    expect(parsed()[0]?.target).toContain('curl');
    expect(lines.join('\n')).not.toContain('never-seen-outside');
  });

  it('carries an edit display diff and its line count', () => {
    const { facts, parsed } = sink();
    facts.toolStart({
      toolCallId: 'e1',
      toolName: 'edit',
      args: { path: 'src/cart.js', oldText: 'q = 1', newText: 'q += 1' },
    });
    facts.toolEnd({
      toolCallId: 'e1',
      toolName: 'edit',
      isError: false,
      entry: result({
        ok: true,
        display: {
          kind: 'diff',
          text: ' 9 if (x) {\n-10 q = 1;\n+10 q += 1;',
          firstChangedLine: 10,
          added: 1,
          removed: 1,
          truncated: false,
        },
      }),
    });
    expect(parsed()[1]).toEqual({
      id: 'e1',
      tool: 'edit',
      target: 'src/cart.js',
      state: 'done',
      outcome: '+1 −1',
      diff: {
        text: ' 9 if (x) {\n-10 q = 1;\n+10 q += 1;',
        firstChangedLine: 10,
      },
      at: 2,
    });
  });

  it('shows a written file as added rows', () => {
    const { facts, parsed } = sink();
    facts.toolStart({
      toolCallId: 'w1',
      toolName: 'write',
      args: { path: 'notes.md', content: 'a\nb' },
    });
    facts.toolEnd({
      toolCallId: 'w1',
      toolName: 'write',
      isError: false,
      entry: result({
        ok: true,
        display: { kind: 'write', newFile: true, lines: 2, preview: 'a\nb' },
      }),
    });
    expect(parsed()[1]).toMatchObject({
      outcome: 'new file, 2 lines',
      diff: { text: '+1 a\n+2 b', firstChangedLine: 1 },
    });
  });

  it('marks a failed shell call as an error with its exit code', () => {
    const { facts, parsed } = sink();
    facts.toolStart({
      toolCallId: 'b1',
      toolName: 'bash',
      args: { command: 'npm test' },
    });
    facts.toolEnd({
      toolCallId: 'b1',
      toolName: 'bash',
      isError: false,
      entry: result(undefined, '[bash exit 1 (bash)]\nfailed'),
    });
    expect(parsed()[1]).toMatchObject({ state: 'error', outcome: 'exit 1' });
  });
});
