// The orchestrator dashboard's view state and keys (EPIC N, issue #465;
// docs/ui 04-C, 04-E keys row). Which view orchestrator mode shows (the
// dashboard or the manager transcript), the selected worker, the filter,
// and whether the approval card is open over the dashboard. A key becomes
// an intent the app carries out — the view never reaches the run itself.

import type { KubicPresentationState } from '../../../core/src/presentation.js';
import {
  type DashboardLimits,
  type DashboardModel,
  dashboardModel,
  moveSelection,
  resolveSelection,
} from './state.js';

export type OrchestratorView = 'dashboard' | 'manager';

export type DashboardIntent =
  /** The key changed the view: draw a frame. */
  | { readonly kind: 'render' }
  /** The key is not the dashboard's: the app handles it as usual. */
  | { readonly kind: 'pass' }
  /** Swallowed with a word on the footer (a key that does nothing here). */
  | { readonly kind: 'hint'; readonly text: string }
  | { readonly kind: 'open'; readonly workerId: string }
  | { readonly kind: 'answer' }
  | { readonly kind: 'stop'; readonly workerId: string }
  | { readonly kind: 'retry'; readonly workerId: string }
  | { readonly kind: 'diff'; readonly workerId: string }
  // Issue #466: the dispatch box sent its text — to the selected worker, or
  // as the task of a new worker of a role.
  | {
      readonly kind: 'message';
      readonly workerId: string;
      readonly text: string;
    }
  | { readonly kind: 'dispatch'; readonly text: string; readonly role: string };

/** Issue #466: what the dispatch box sends its text as. */
export type DispatchMode = 'message' | 'new';

export interface DashboardKey {
  readonly data: string;
  /** Pi's parsed key id (`up`, `enter`, `tab`, `backspace`, …). */
  readonly keyId?: string;
  /** The key registry's global action for the key, when it has one. */
  readonly action?: string;
}

const EMPTY_STATE: KubicPresentationState = {
  session: { sessionId: '', mode: 'orchestrator', approvalsSkipped: false },
  agents: new Map(),
  lanes: new Map(),
  workers: new Map(),
  approvals: [],
  usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 },
  connection: { status: 'connected' },
};

// Text a key (or a burst of typing, delivered as one chunk) inserts: no
// control character anywhere in it.
function printable(data: string): boolean {
  return data !== '' && [...data].every((ch) => ch >= ' ' && ch !== '\u007f');
}

/** A run's objective as its header shows it: the first line that says something. */
export function runTaskTitle(prompt: string): string {
  return (
    prompt
      .split('\n')
      .map((line) => line.replace(/\s+/g, ' ').trim())
      .find((line) => line !== '') ?? ''
  );
}

export class DashboardView {
  view: OrchestratorView = 'manager';
  selected: string | undefined;
  filter = '';
  /** `/` was pressed: printable keys edit the filter. */
  filtering = false;
  /** `a` opened the approval card over the dashboard. */
  answering = false;
  runTask: string | undefined;
  /** A run has started in this session (the dashboard has something). */
  hasRun = false;
  /** Issue #466: the dispatch box — its mode, its draft, whether it types. */
  dispatchMode: DispatchMode = 'message';
  dispatchText = '';
  dispatchFocused = false;
  /** The roles `tab` cycles a new worker through, and the current one. */
  roles: readonly string[] = ['implementer'];
  roleIndex = 0;

  get role(): string {
    return (
      this.roles[this.roleIndex % Math.max(1, this.roles.length)] ??
      'implementer'
    );
  }

  /** The dispatch box's text went out: the next one starts empty, as a
   *  message. */
  dispatchSent(): void {
    this.dispatchText = '';
    this.dispatchFocused = false;
    this.dispatchMode = 'message';
  }

  /** A new objective went to the manager: its run is what the dashboard shows. */
  startRun(prompt: string): void {
    const title = runTaskTitle(prompt);
    this.runTask = title === '' ? undefined : title;
    this.hasRun = true;
    this.view = 'dashboard';
    this.selected = undefined;
    this.filter = '';
    this.filtering = false;
  }

  reset(): void {
    this.view = 'manager';
    this.selected = undefined;
    this.filter = '';
    this.filtering = false;
    this.answering = false;
    this.runTask = undefined;
    this.hasRun = false;
    this.dispatchMode = 'message';
    this.dispatchText = '';
    this.dispatchFocused = false;
  }

  model(
    state: KubicPresentationState | undefined,
    input: {
      readonly now: number;
      readonly branch?: string;
      readonly limits?: DashboardLimits;
    },
  ): DashboardModel {
    return dashboardModel(state ?? EMPTY_STATE, {
      now: input.now,
      filter: this.filter,
      ...(this.runTask === undefined ? {} : { task: this.runTask }),
      ...(input.branch === undefined ? {} : { branch: input.branch }),
      ...(input.limits === undefined ? {} : { limits: input.limits }),
    });
  }

  // Issue #466: one key while the dispatch box types.
  private dispatchKey(
    key: DashboardKey,
    model: DashboardModel,
  ): DashboardIntent {
    const render = { kind: 'render' } as const;
    const selected = resolveSelection(model, this.selected);
    if (key.action === 'app.cancel') {
      this.dispatchFocused = false;
      return render;
    }
    if (key.keyId === 'enter') {
      const text = this.dispatchText.trim();
      if (text === '') {
        this.dispatchFocused = false;
        return selected === undefined
          ? { kind: 'hint', text: 'no worker selected' }
          : { kind: 'open', workerId: selected };
      }
      if (this.dispatchMode === 'new') {
        return { kind: 'dispatch', text, role: this.role };
      }
      return selected === undefined
        ? {
            kind: 'hint',
            text: 'no worker to message — ^N dispatches a new one',
          }
        : { kind: 'message', workerId: selected, text };
    }
    if (key.keyId === 'backspace') {
      this.dispatchText = [...this.dispatchText].slice(0, -1).join('');
      return render;
    }
    if (key.keyId === 'ctrl+u') {
      this.dispatchText = '';
      return render;
    }
    if (key.keyId === 'ctrl+n') {
      this.dispatchMode = this.dispatchMode === 'new' ? 'message' : 'new';
      return render;
    }
    if (key.keyId === 'tab') {
      if (this.dispatchMode === 'new') {
        this.roleIndex = (this.roleIndex + 1) % Math.max(1, this.roles.length);
      }
      return render;
    }
    if (key.keyId === 'up' || key.keyId === 'down') {
      this.selected = moveSelection(
        model,
        selected,
        key.keyId === 'up' ? -1 : 1,
      );
      return render;
    }
    if (key.action === undefined && printable(key.data)) {
      this.dispatchText += key.data;
      return render;
    }
    return { kind: 'pass' };
  }

  /** One key on the dashboard (no overlay or card above it). */
  handleKey(key: DashboardKey, model: DashboardModel): DashboardIntent {
    const render = { kind: 'render' } as const;
    if (this.dispatchFocused) return this.dispatchKey(key, model);
    if (this.filtering) {
      if (key.action === 'app.cancel') {
        this.filtering = false;
        this.filter = '';
        return render;
      }
      if (key.keyId === 'enter') {
        this.filtering = false;
        return render;
      }
      if (key.keyId === 'backspace') {
        this.filter = this.filter.slice(0, -1);
        return render;
      }
      if (key.action === undefined && printable(key.data)) {
        this.filter += key.data;
        return render;
      }
      return { kind: 'pass' };
    }
    // Issue #466: `m` types a message to the selected worker, `^N` the
    // task of a new one.
    if (key.data === 'm' || key.keyId === 'ctrl+n') {
      this.dispatchMode = key.data === 'm' ? 'message' : 'new';
      this.dispatchFocused = true;
      return render;
    }
    const selected = resolveSelection(model, this.selected);
    if (key.keyId === 'up' || key.data === 'k') {
      this.selected = moveSelection(model, selected, -1);
      return render;
    }
    if (key.keyId === 'down' || key.data === 'j') {
      this.selected = moveSelection(model, selected, 1);
      return render;
    }
    if (key.keyId === 'tab') {
      this.view = 'manager';
      return render;
    }
    if (key.data === '/') {
      this.filtering = true;
      return render;
    }
    if (key.action === 'app.cancel') {
      if (this.filter === '') return { kind: 'hint', text: '' };
      this.filter = '';
      return render;
    }
    if (key.data === 'a') return { kind: 'answer' };
    const workerKey =
      key.keyId === 'enter'
        ? 'open'
        : key.data === 'x'
          ? 'stop'
          : key.data === 'r'
            ? 'retry'
            : key.action === 'panel.diff'
              ? 'diff'
              : undefined;
    if (workerKey !== undefined) {
      const row = model.workers.find(
        (entry) => entry.worker.workerId === selected,
      );
      if (selected === undefined || row === undefined) {
        return { kind: 'hint', text: 'no worker selected' };
      }
      this.selected = selected;
      // Only a live worker stops, and only a failed one retries.
      if (
        workerKey === 'stop' &&
        row.group !== 'working' &&
        row.group !== 'awaiting'
      ) {
        return { kind: 'hint', text: `stop: ${selected} is not running` };
      }
      if (workerKey === 'retry' && !row.failed) {
        return { kind: 'hint', text: `retry: ${selected} did not fail` };
      }
      return { kind: workerKey, workerId: selected };
    }
    if (key.action !== undefined) return { kind: 'pass' };
    return {
      kind: 'hint',
      text: printable(key.data) ? 'tab: talk to the manager' : '',
    };
  }
}
