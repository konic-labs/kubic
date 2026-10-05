// A worker's free-text question (issue #154; §14.2), answered in the TUI's
// orchestrator mode: a capturing dialog naming the worker and its role, the
// question (sanitized — it is worker-authored), and Pi's single-line Input.
// Enter answers with the typed text (an empty line answers nothing); Esc
// declines. The view resolves exactly once.
import { sanitizeLaneText } from './lane-cells.js';
import { tuiTheme } from './theme.js';
import {
  type Component,
  type Focusable,
  Input,
  truncateToWidth,
  wrapTextWithAnsi,
} from './tui-boundary.js';

export interface WorkerQuestionLike {
  readonly question: string;
  readonly agentId: string;
  readonly role: string;
}

export const QUESTION_HINT = 'enter answers · esc declines';

export class QuestionView implements Component, Focusable {
  private readonly input = new Input({ prompt: '> ' });
  private readonly question: WorkerQuestionLike;
  private settled = false;
  onSettle: ((answer: string | undefined) => void) | undefined;

  constructor(question: WorkerQuestionLike) {
    this.question = question;
    this.input.onSubmit = (value: string): void => {
      this.settle(value.trim() === '' ? undefined : value.trim());
    };
    this.input.onEscape = (): void => {
      this.settle(undefined);
    };
  }

  get focused(): boolean {
    return this.input.focused;
  }

  set focused(value: boolean) {
    this.input.focused = value;
  }

  private settle(answer: string | undefined): void {
    if (this.settled) return;
    this.settled = true;
    this.onSettle?.(answer);
  }

  handleInput(data: string): void {
    this.input.handleInput(data);
  }

  render(width: number): string[] {
    const theme = tuiTheme();
    const w = Math.max(1, width);
    const header = `? worker '${sanitizeLaneText(this.question.agentId)}' (${sanitizeLaneText(this.question.role)}) asks`;
    return [
      truncateToWidth(theme.accentBold(header), w, '…'),
      ...wrapTextWithAnsi(sanitizeLaneText(this.question.question), w),
      ...this.input.render(w),
      truncateToWidth(theme.muted(QUESTION_HINT), w, '…'),
    ];
  }

  invalidate(): void {
    this.input.invalidate?.();
  }
}
