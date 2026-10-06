// Lane text must not carry terminal control sequences into the frame
// (issue #88, reviewer finding 1). The loop is what FEEDS lane content
// (assistant text, tool results) into the transcript for the first time, so
// a model or a tool can otherwise drive the terminal directly: clearing the
// screen ('\x1b[2J'), repainting colour, ringing the bell, or — on a
// terminal that honours them — moving the cursor over the status bar.
//
// RED before the fix: entriesToCells passed text through verbatim and the
// assertion below failed with `has raw ESC: true` (verified by dumping the
// rendered frame: 'HI\u001b[2J\u001b[31mRED\u001b[0m\u0007END').
import { describe, expect, it } from 'vitest';
import type {
  KubicPresentationState,
  LaneSnapshot,
} from '../../core/src/presentation.js';
import { createTuiApp } from './tui-app.js';

const ESC = '\u001b';
const BEL = '\u0007';

function frameWith(text: string): string {
  const app = createTuiApp({
    sessionId: 's',
    model: 'm',
    mode: 'solo',
    approvalsSkipped: false,
  });
  app.applyLaneEntries([
    {
      id: 'e1',
      seq: 1,
      type: 'message',
      message: { role: 'assistant', content: [{ type: 'text', text }] },
    },
  ]);
  return app.render(60).join('\n');
}

// Issue #333: the app renders replicated state, so a test builds the state a
// projector would produce (the projector itself lives in host).
function presentation(
  over: Partial<LaneSnapshot> = {},
): KubicPresentationState {
  return {
    session: { sessionId: 's', mode: 'solo', approvalsSkipped: false },
    agents: new Map(),
    lanes: new Map([
      [
        's',
        {
          laneId: 's',
          agentId: 'root',
          status: 'running',
          tools: [],
          queued: [],
          compacting: false,
          ...over,
        },
      ],
    ]),
    workers: new Map(),
    approvals: [],
    usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 },
    connection: { status: 'connected' },
  };
}

describe('terminal control sequences from lane content (issue #88)', () => {
  it('does not let assistant text emit raw escapes or the bell', () => {
    const frame = frameWith(`HI${ESC}[2J${ESC}[31mRED${ESC}[0m${BEL}END`);
    // The words survive (the operator still reads what the model said)...
    expect(frame).toContain('HI');
    expect(frame).toContain('RED');
    expect(frame).toContain('END');
    // ...but no control byte from lane content reaches the terminal. The
    // renderer's own styling is untouched — this is about CONTENT only.
    expect(frame).not.toContain(`${ESC}[2J`);
    expect(frame).not.toContain(`${ESC}[31m`);
    expect(frame).not.toContain(BEL);
  });

  it('does not let tool-result text emit raw escapes either', () => {
    const app = createTuiApp({
      sessionId: 's',
      model: 'm',
      mode: 'solo',
      approvalsSkipped: false,
    });
    app.applyLaneEntries([
      {
        id: 'e2',
        seq: 2,
        type: 'message',
        message: {
          role: 'toolResult',
          content: [{ type: 'text', text: `ok${ESC}[2Jgone` }],
        },
      },
    ]);
    const frame = app.render(60).join('\n');
    expect(frame).not.toContain(`${ESC}[2J`);
  });

  it('renders coloured tool output as clean text, not parameter noise (#299)', () => {
    // FORCE_COLOR test runners, `git color.ui=always` and npm progress bars
    // emit real SGR sequences even without a TTY. Stripping only the ESC
    // byte left `[31m` visible in every output block; the whole sequence
    // must go, and the words must stay.
    const app = createTuiApp({
      sessionId: 's',
      model: 'm',
      mode: 'solo',
      approvalsSkipped: false,
    });
    app.applyLaneEntries([
      {
        id: 'e9',
        seq: 9,
        type: 'message',
        message: {
          role: 'toolResult',
          content: [
            { type: 'text', text: `${ESC}[31mFAIL${ESC}[0m src/x.ts\n` },
          ],
        },
      },
    ]);
    const frame = app.render(60).join('\n');
    // The renderer's OWN SGR (glyph colours, resets) is not content: strip it
    // and assert what the operator reads.
    const plain = frame.replace(new RegExp(`${ESC}\\[[0-9;]*m`, 'g'), '');
    expect(plain).toContain('FAIL src/x.ts');
    expect(plain).not.toContain('[31m');
    expect(plain).not.toContain('[0m');
  });

  it('does not let a tool NAME emit raw escapes (second-pass finding)', () => {
    // The first pass sanitized text content but not the tool-call name, so a
    // model emitting a call named `evil\x1b[2Jname` still rendered the
    // clear-screen sequence. Names are model-supplied, so they are the same
    // class of untrusted input.
    const app = createTuiApp({
      sessionId: 's',
      model: 'm',
      mode: 'solo',
      approvalsSkipped: false,
    });
    app.applyLaneEntries([
      {
        id: 'e3',
        seq: 3,
        type: 'message',
        message: {
          role: 'assistant',
          content: [{ type: 'toolCall', id: 'tc1', name: `evil${ESC}[2Jname` }],
        },
      },
    ]);
    const frame = app.render(60).join('\n');
    expect(frame).toContain('evil');
    expect(frame).not.toContain(`${ESC}[2J`);
  });

  it('does not let a TREE toolName emit raw escapes (third-pass finding)', () => {
    // The second pass sanitized the transcript's toolCall cell, but the TREE
    // path takes the lane event's `toolName` verbatim into AgentTreeState
    // (tree.ts). Both come from the same model-supplied name, so the tree is
    // the same class of untrusted input and was still a live leak.
    const app = createTuiApp({
      sessionId: 's',
      model: 'm',
      mode: 'solo',
      approvalsSkipped: false,
    });
    app.applyPresentation(
      presentation({
        tools: [
          {
            toolCallId: 'tc-tree',
            toolName: `ZZ${ESC}[2J${ESC}[31m${BEL}`,
            status: 'running',
            isError: false,
          },
        ],
      }),
    );
    // Issue #453: the solo tree row is opened on demand (Ctrl-T).
    app.handleInput('\x14');
    const frame = app.render(100).join('\n');
    expect(frame).toContain('ZZ');
    expect(frame).not.toContain(`${ESC}[2J`);
    expect(frame).not.toContain(`${ESC}[31m`);
    expect(frame).not.toContain(BEL);
  });

  it('does not let the cancel-failure footer emit raw escapes', () => {
    // The refusal path renders the lane's own error text into the footer;
    // that text is JSON.stringify of whatever the lane threw, so it can
    // carry controls like any other lane content. Measured: pi-tui's editor
    // row already filters its own footer text (the only ESC bytes left in
    // the frame are its focus styling, `\x1b[7m`/`\x1b[0m`), so this stays
    // green as a regression pin rather than a new defence.
    const app = createTuiApp({
      sessionId: 's',
      model: 'm',
      mode: 'solo',
      approvalsSkipped: false,
    });
    app.setEditorFooter(
      `cancel failed: ${JSON.stringify({ message: `zap${ESC}[2J${BEL}` })}`,
    );
    const frame = app.render(60).join('\n');
    expect(frame).not.toContain(`${ESC}[2J`);
    expect(frame).not.toContain(BEL);
  });
});
