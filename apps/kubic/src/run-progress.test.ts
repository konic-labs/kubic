// `kubic run` live progress on an interactive terminal.
import { stripVTControlCharacters } from 'node:util';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createCliTheme } from '../../../packages/core/src/cli/theme.js';
import type { HeadlessRunResult } from '../../../packages/host/src/run-cli.js';
import { countDiffLines, createRunProgress } from './run-progress.js';

// What a terminal ends up showing: the settled lines (each `\n`-terminated
// segment after its last carriage return), escape sequences removed.
function settledLines(chunks: readonly string[]): string[] {
  const text = chunks.join('');
  const segments = text.split('\n');
  segments.pop();
  return segments.map((segment) =>
    stripVTControlCharacters(segment.slice(segment.lastIndexOf('\r') + 1)),
  );
}

function bashResult(exit: number): unknown {
  return {
    model: [
      {
        role: 'toolResult',
        content: [{ type: 'text', text: `[bash exit ${exit} (bash)]\nok` }],
      },
    ],
  };
}

function editResult(diff: string): unknown {
  return {
    model: [
      {
        role: 'toolResult',
        content: [{ type: 'text', text: 'Successfully replaced text' }],
        details: { diff, firstChangedLine: 10 },
      },
    ],
  };
}

const RESULT: HeadlessRunResult = {
  terminus: 'completed',
  summary: 'Fixed addItem.',
  sessionId: 'sess-1',
  journalRef: 'journal:sess-1',
  usageRef: 'usage:sess-1',
  trajectoryRef: 'trajectory:sess-1',
  usage: {
    input: 9200,
    output: 640,
    cacheRead: 0,
    cacheWrite: 0,
    costUsd: 0.031,
    toolCalls: 4,
  },
};

describe('run progress', () => {
  let clock = 0;
  beforeEach(() => {
    vi.useFakeTimers();
    clock = 1_000_000;
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  function rig() {
    const chunks: string[] = [];
    const stream = {
      isTTY: true,
      columns: 100,
      write: (chunk: string) => chunks.push(chunk),
    };
    const progress = createRunProgress(stream, createCliTheme('none'), {
      cwd: '/home/me/project',
      home: '/home/me',
      now: () => clock,
      spinner: { onExit: () => () => {} },
    });
    return { chunks, progress };
  }

  it('prints the heading, the notice and one settled line per tool', () => {
    const { chunks, progress } = rig();
    progress.begin({ model: 'anthropic/claude', notice: true });
    progress.toolStart({
      toolCallId: 'a',
      toolName: 'bash',
      args: { command: 'npm test' },
    });
    clock += 410;
    progress.toolEnd({
      toolCallId: 'a',
      toolName: 'bash',
      isError: false,
      entry: bashResult(1),
    });
    progress.toolStart({
      toolCallId: 'b',
      toolName: 'read',
      args: { path: 'src/cart.js' },
    });
    clock += 3;
    progress.toolEnd({ toolCallId: 'b', toolName: 'read', isError: false });
    progress.toolStart({
      toolCallId: 'c',
      toolName: 'edit',
      args: { path: 'src/cart.js', oldText: 'a', newText: 'b' },
    });
    clock += 9;
    progress.toolEnd({
      toolCallId: 'c',
      toolName: 'edit',
      isError: false,
      entry: editResult(' 9   if (x) {\n-10   q = 1;\n+10   q += 1;\n 11 }'),
    });
    progress.settle();
    expect(settledLines(chunks)).toEqual([
      '■ kubic run · solo · anthropic/claude · ~/project',
      '○ solo has no isolation — approvals + journal are the controls · details: kubic doctor',
      '',
      '✕ bash    npm test  exit 1  0.4s',
      '✓ read    src/cart.js  0.0s',
      '✓ edit    src/cart.js  +1 −1  0.0s',
    ]);
  });

  // Kubic's own edit tool reports its change as a display record
  // (tools-adapter.ts), not Pi's `details.diff`: the stat must
  // come from it, or a real run never shows `+a −r`.
  it("counts an edit from Kubic's display record", () => {
    const { chunks, progress } = rig();
    progress.begin({ model: 'faux/m', notice: false });
    progress.toolStart({
      toolCallId: 'e',
      toolName: 'edit',
      args: { path: 'src/cart.js', oldText: 'a', newText: 'b' },
    });
    progress.toolEnd({
      toolCallId: 'e',
      toolName: 'edit',
      isError: false,
      entry: {
        model: [
          {
            role: 'toolResult',
            content: [{ type: 'text', text: 'ok' }],
            details: {
              ok: true,
              toolCallId: 'e',
              invocationId: 'i',
              display: {
                kind: 'diff',
                text: '-10 q = 1;\n+10 q += 1;\n+11 r();',
                firstChangedLine: 10,
                added: 2,
                removed: 1,
                truncated: false,
              },
            },
          },
        ],
      },
    });
    progress.settle();
    expect(settledLines(chunks).at(-1)).toBe(
      '✓ edit    src/cart.js  +2 −1  0.0s',
    );
  });

  it('keeps a long path to its last two segments', () => {
    const chunks: string[] = [];
    const progress = createRunProgress(
      {
        isTTY: true,
        columns: 50,
        write: (chunk: string) => chunks.push(chunk),
      },
      createCliTheme('none'),
      {
        cwd: '/very/long/path/to/some/deeply/nested/project',
        now: () => clock,
        spinner: { onExit: () => () => {} },
      },
    );
    progress.begin({ model: 'faux/echo', notice: false });
    progress.settle();
    expect(settledLines(chunks)[0]).toBe(
      '■ kubic run · solo · faux/echo · …/nested/project',
    );
  });

  it('omits the notice when the run opted out', () => {
    const { chunks, progress } = rig();
    progress.begin({ notice: false });
    progress.settle();
    expect(settledLines(chunks)).toEqual([
      '■ kubic run · solo · ~/project',
      '',
    ]);
  });

  it('counts written files and prints the receipt with next steps', () => {
    const { chunks, progress } = rig();
    progress.begin({ notice: false });
    progress.toolStart({
      toolCallId: 'w',
      toolName: 'write',
      args: { path: 'src/new.ts', content: 'a\nb\nc\n' },
    });
    progress.toolEnd({ toolCallId: 'w', toolName: 'write', isError: false });
    clock += 18_400;
    progress.settle();
    progress.receipt(RESULT, 0);
    const lines = settledLines(chunks);
    expect(lines.at(-2)).toBe(
      '✓ done 18.4s · 4 tools · 1 file +3 −0 · ↑ 9.2k ↓ 640 tok · $0.031',
    );
    expect(lines.at(-1)).toBe(
      '  review kubic diff   revert kubic undo   continue kubic resume sess-1',
    );
  });

  it('names the failure in the receipt', () => {
    const { chunks, progress } = rig();
    progress.begin({ notice: false });
    progress.settle();
    progress.receipt(
      {
        ...RESULT,
        terminus: 'timeout',
        usage: undefined,
        sessionId: 'unassigned',
      },
      4,
    );
    const lines = settledLines(chunks);
    expect(lines.at(-1)).toMatch(/^✕ failed \d+\.\ds · timeout · 0 tools$/);
  });

  it('refreshes the elapsed time while the model works', () => {
    const { chunks, progress } = rig();
    progress.begin({ notice: false });
    clock += 3000;
    vi.advanceTimersByTime(500);
    expect(chunks.join('')).toContain('thinking · 0:03');
    progress.settle();
    const count = chunks.length;
    vi.advanceTimersByTime(2000);
    expect(chunks).toHaveLength(count);
  });
});

describe('countDiffLines', () => {
  it('counts Pi diff additions and removals, not context or gaps', () => {
    expect(countDiffLines(' 1 a\n-2 b\n+2 c\n+3 d\n    ...\n 9 e')).toEqual({
      added: 2,
      removed: 1,
    });
  });
});
