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
  | { readonly kind: 'diff'; readonly workerId: string };

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

function printable(data: string): boolean {
  return [...data].length === 1 && data >= ' ' && data !== '\u007f';
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

  /** One key on the dashboard (no overlay or card above it). */
  handleKey(key: DashboardKey, model: DashboardModel): DashboardIntent {
    const render = { kind: 'render' } as const;
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
