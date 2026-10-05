// A worker's free-text question in the TUI (issue #154; §14.2): the dialog's
// headless render, and the app seat — Enter answers with the typed text, Esc
// declines, an abort withdraws the dialog, and a second question waits for
// the first.
import { describe, expect, it } from 'vitest';
import { QuestionView } from './question-view.js';
import { createTuiApp } from './tui-app.js';

const question = {
  question: 'which file should I edit?',
  agentId: 'alpha',
  role: 'implementer',
};

function appWithOverlays() {
  const app = createTuiApp({
    sessionId: 'sess',
    model: 'faux/m',
    mode: 'orchestrator',
    approvalsSkipped: false,
  });
  const overlays: Array<{ render: (w: number) => string[]; hidden: boolean }> =
    [];
  app.attachApprovalOverlay({
    terminal: { columns: 100, rows: 30 },
    showOverlay: (component) => {
      const entry = {
        render: (w: number) =>
          (component as { render: (width: number) => string[] }).render(w),
        hidden: false,
      };
      overlays.push(entry);
      return {
        unfocus: () => {},
        hide: () => {
          entry.hidden = true;
        },
      };
    },
  });
  const frame = (): string =>
    overlays
      .filter((overlay) => !overlay.hidden)
      .flatMap((overlay) => overlay.render(80))
      .join('\n');
  const type = (text: string): void => {
    for (const ch of text) app.handleInput(ch);
  };
  return { app, frame, type };
}

describe('the worker question dialog (issue #154)', () => {
  it('renders the worker, the question, the input line and the hint (headless snapshot)', () => {
    // Pi's Input pads its line to the width and styles the cursor cell; the
    // snapshot reads the text.
    const esc = String.fromCharCode(27);
    const plain = (line: string): string =>
      line
        .replace(new RegExp(`${esc}\\[[0-9;?]*[A-Za-z]`, 'g'), '')
        .replace(new RegExp(`${esc}_[^${esc}]*${esc}\\\\`, 'g'), '')
        .trimEnd();
    expect(
      new QuestionView(question).render(60).map(plain),
    ).toMatchInlineSnapshot(`
      [
        "? worker 'alpha' (implementer) asks",
        "which file should I edit?",
        ">",
        "enter answers · esc declines",
      ]
    `);
  });

  it('Enter answers with the typed text', async () => {
    const { app, frame, type } = appWithOverlays();
    const answer = app.askQuestion(question);
    expect(frame()).toContain('which file should I edit?');
    type('a.ts');
    app.handleInput('\r');
    await expect(answer).resolves.toBe('a.ts');
    expect(frame()).toBe('');
  });

  it('Esc declines, and an abort withdraws the dialog', async () => {
    const { app, frame } = appWithOverlays();
    const declined = app.askQuestion(question);
    app.handleInput('\x1b');
    await expect(declined).resolves.toBeUndefined();
    const controller = new AbortController();
    const withdrawn = app.askQuestion(question, controller.signal);
    expect(frame()).toContain('asks');
    controller.abort();
    await expect(withdrawn).resolves.toBeUndefined();
    expect(frame()).toBe('');
  });

  it('a second question waits for the first', async () => {
    const { app, frame, type } = appWithOverlays();
    const first = app.askQuestion(question);
    const second = app.askQuestion({ ...question, question: 'and the test?' });
    expect(frame()).not.toContain('and the test?');
    type('a.ts');
    app.handleInput('\r');
    await expect(first).resolves.toBe('a.ts');
    expect(frame()).toContain('and the test?');
    type('a.test.ts');
    app.handleInput('\r');
    await expect(second).resolves.toBe('a.test.ts');
  });
});
