// The approval contract the TUI shares: the
// request and decision shapes, the decision keys (defaults, overrides,
// conflict and hygiene checks, the arming timings of), the overlay
// options the question and confirm dialogs use, and the memoOnce /
// timeout→deny helpers. The approval itself renders as the inline card
// (approval-card.ts).
// Presentation only: mirrors the host decider semantics
// (packages/host/src/approvals.ts) structurally without importing it —
// dep-lint forbids tui → host. Pi is touched ONLY through
// ./tui-boundary.js. No node:fs in prod src (I/O confinement).

import type { CellDisplay } from './transcript.js';
import type { Component } from './tui-boundary.js';
import { matchesKey } from './tui-boundary.js';

// `comment` denies with the operator's words, `edit` rewrites a
// command before allowing it, `allow-edits` approves the turn's edits.
export type ApprovalAction =
  | 'allow-once'
  | 'allow-session'
  | 'deny'
  | 'comment'
  | 'edit'
  | 'allow-edits';

// Structural request: the fields the dialog renders. The host owns the
// trigger/policy truth; the view never classifies, only presents.
export interface ApprovalViewRequest {
  readonly key: string;
  readonly capability: string;
  readonly toolName: string;
  readonly command?: string;
  readonly paths?: ReadonlyArray<string>;
  readonly justification?: string;
  readonly summary?: string;
  // An edit or write ask's change, as the inline diff the card
  // shows (the host computes it against the file on disk).
  readonly preview?: CellDisplay;
  // The host's word on which steering answers this ask takes.
  readonly editable?: boolean;
  readonly batchable?: boolean;
}

export type ApprovalDecision =
  | { approved: true; by: string; edited?: { command: string } }
  | { approved: false; reason: string };

// Overlay geometry: centered 70% width / 60% height, visible at
// 80+ columns. Approvals are an inline card now; the question
// and confirm dialogs still use this overlay.
export const APPROVAL_MIN_WIDTH = 80;

// Structural overlay options mirroring Pi's OverlayOptions without
// importing Pi past the seam: OverlayOptions is not a boundary export and
// the boundary is kept frozen here. Field-for-field compatible with
// Pi's OverlayOptions (width/maxHeight accept numbers or "N%" strings).
export interface ApprovalOverlayOptions {
  readonly width?: number | `${number}%`;
  readonly maxHeight?: number | `${number}%`;
  readonly anchor?:
    | 'center'
    | 'top-left'
    | 'top-right'
    | 'bottom-left'
    | 'bottom-right'
    | 'top-center'
    | 'bottom-center'
    | 'left-center'
    | 'right-center';
  readonly visible?: (termWidth: number, termHeight: number) => boolean;
  readonly nonCapturing?: boolean;
}

// The overlay's size caps, as percentages of the terminal.
const APPROVAL_OVERLAY_WIDTH_PERCENT = 70;
const APPROVAL_OVERLAY_HEIGHT_PERCENT = 60;

export function approvalOverlayOptions(): ApprovalOverlayOptions {
  return {
    width: `${APPROVAL_OVERLAY_WIDTH_PERCENT}%`,
    maxHeight: `${APPROVAL_OVERLAY_HEIGHT_PERCENT}%`,
    anchor: 'center',
    // Capturing by design: the modal takes focus on show (nonCapturing
    // is never set). Narrow terminals skip the overlay via visible.
    visible: (termWidth: number): boolean => termWidth >= APPROVAL_MIN_WIDTH,
  };
}

export interface ApprovalOverlayBounds {
  readonly width: number;
  readonly height: number;
  readonly row: number;
  readonly col: number;
}

// NOTE (max-extent estimate — Pi is the layout authority at runtime):
// Pi's compositeOverlays (pi-tui/dist/tui.js) renders the component at the
// resolved width and uses content height (overlayLines.length clamped to
// maxHeight) centered via resolveOverlayLayout — it never sizes the box to
// termHeight * 60%. This helper returns the 70%-wide / 60%-tall centered
// max extent for headless estimates and tests only.
export function approvalOverlayBounds(
  termWidth: number,
  termHeight: number,
): ApprovalOverlayBounds {
  const width = Math.floor(termWidth * 0.7);
  const height = Math.floor(termHeight * 0.6);
  return {
    width,
    height,
    row: Math.max(0, Math.floor((termHeight - height) / 2)),
    col: Math.max(0, Math.floor((termWidth - width) / 2)),
  };
}

// The key that pages a long command (or opens an edit's whole
// diff) on the approval card. It never decides.
export const APPROVAL_PAGE_KEY = 'v';

// Keybinding registry. Defaults live here (not in Pi's
// global KeybindingsManager — the tui seam exposes no registry writer),
// matched exclusively through matchesKey: no hardcoded key strings on
// the input path.
type ApprovalKeyId = Parameters<typeof matchesKey>[1];

export const APPROVAL_DEFAULT_KEYS: Record<
  ApprovalAction,
  readonly ApprovalKeyId[]
> = {
  // An approval is consent to run code with the operator's
  // authority, so type-ahead meant for the editor must never produce one.
  // allow-once and deny keep a letter but act only after the arming delay
  // below; allow-session (consent for the whole session) is Ctrl-S, which
  // prose cannot produce; Esc is the one immediate key, and it only denies.
  'allow-once': ['a'],
  'allow-session': ['ctrl+s'],
  deny: ['d', 'escape'],
  // Plain letters like allow-once — each acts only after the
  // arming delay, and `c`/`e` only open an input the operator must send.
  comment: ['c'],
  edit: ['e'],
  'allow-edits': ['shift+a'],
};

// Decision keys are ignored for this long after a request
// appears (and again for each queued request), so a keystroke typed into the
// editor a moment before the ask arrived cannot answer it.
export const APPROVAL_ARMING_MS = 400;

// After ANY key the modal swallows the unlock needs this much
// quiet, not just the first arming delay. A thinking pause in the middle of
// prose is ~0.5 s, so 400 ms after the last typed key would let the next bare
// `a` answer a request the operator never looked at; 1.5 s is a pause long
// enough to be a decision to stop typing.
export const APPROVAL_QUIET_MS = 1500;

// A decision key that arrives within this long of the SAME key is
// a terminal auto-repeat, not a press. Terminals that do not report key events
// (Terminal.app, VTE, tmux) send a held `a` as plain repeated bytes after an
// OS repeat delay of up to ~0.6 s, with nothing to tell it from typing.
export const APPROVAL_REPEAT_MS = 700;

// The one binding honoured during the arming window: Esc, and only as deny.
export const APPROVAL_IMMEDIATE_KEY = 'escape';

export type ApprovalKeyOverrides = Partial<
  Record<ApprovalAction, readonly ApprovalKeyId[]>
>;

// Deny wins: a key claimed by both an allow binding and deny resolves to
// deny. approvalKeyConflicts still reports the overlap for registry hygiene.
const ACTION_ORDER: ReadonlyArray<ApprovalAction> = [
  'deny',
  'allow-once',
  'allow-session',
  'comment',
  'edit',
  'allow-edits',
];

function resolvedBindings(
  overrides?: ApprovalKeyOverrides,
): Record<ApprovalAction, readonly ApprovalKeyId[]> {
  return {
    'allow-once':
      overrides?.['allow-once'] ?? APPROVAL_DEFAULT_KEYS['allow-once'],
    'allow-session':
      overrides?.['allow-session'] ?? APPROVAL_DEFAULT_KEYS['allow-session'],
    deny: overrides?.deny ?? APPROVAL_DEFAULT_KEYS.deny,
    comment: overrides?.comment ?? APPROVAL_DEFAULT_KEYS.comment,
    edit: overrides?.edit ?? APPROVAL_DEFAULT_KEYS.edit,
    'allow-edits':
      overrides?.['allow-edits'] ?? APPROVAL_DEFAULT_KEYS['allow-edits'],
  };
}

export function resolveApprovalAction(
  data: string,
  overrides?: ApprovalKeyOverrides,
): ApprovalAction | undefined {
  return resolveApprovalKey(data, overrides)?.action;
}

// The action AND the binding that matched: the arming window lets only the
// immediate deny key through, so the caller needs to know which key it was.
export function resolveApprovalKey(
  data: string,
  overrides?: ApprovalKeyOverrides,
): { action: ApprovalAction; key: string } | undefined {
  const bindings = resolvedBindings(overrides);
  for (const action of ACTION_ORDER) {
    for (const key of bindings[action]) {
      if (matchesKey(data, key)) return { action, key };
    }
  }
  return undefined;
}

// A key ordinary typing can produce — a bare character, space,
// or a shifted character (an upper-case letter or a symbol).
function isProseKey(key: string): boolean {
  return key.length === 1 || key === 'space' || /^shift\+.$/.test(key);
}

// Registry hygiene beyond action overlaps. allow-session
// may never be a prose key, and no approval key may shadow one of the loop's
// own global keys (`reserved`, supplied by the app; Esc is exempt — its deny
// is intentional). One message per problem.
export function approvalKeyProblems(
  overrides?: ApprovalKeyOverrides,
  reserved: ReadonlyArray<string> = [],
): string[] {
  const bindings = resolvedBindings(overrides);
  const problems: string[] = [];
  for (const key of bindings['allow-session']) {
    if (isProseKey(key))
      problems.push(
        `allow-session key ${key} can be typed as prose (bind a modified key)`,
      );
  }
  for (const action of ACTION_ORDER) {
    for (const key of bindings[action]) {
      if (key !== APPROVAL_IMMEDIATE_KEY && reserved.includes(key))
        problems.push(`approval key conflict: ${key} is a global TUI key`);
    }
  }
  return problems;
}

export interface ApprovalKeyConflict {
  readonly key: string;
  readonly actions: ReadonlyArray<ApprovalAction>;
}

export function approvalKeyConflicts(
  overrides?: ApprovalKeyOverrides,
): ApprovalKeyConflict[] {
  const bindings = resolvedBindings(overrides);
  const owners = new Map<string, ApprovalAction[]>();
  for (const action of ACTION_ORDER) {
    for (const key of bindings[action]) {
      const list = owners.get(key);
      if (list === undefined) {
        owners.set(key, [action]);
      } else if (!list.includes(action)) {
        list.push(action);
      }
    }
  }
  const conflicts: ApprovalKeyConflict[] = [];
  for (const [key, actions] of owners) {
    if (actions.length > 1) conflicts.push({ key, actions });
  }
  return conflicts;
}

// Focus capture + explicit unfocus. The handle types mirror Pi's
// OverlayHandle structurally so tests inject a fake TUI without touching
// Pi internals through the seam.
export interface ApprovalOverlayHandle {
  unfocus(options?: { target: Component | null }): void;
  hide(): void;
}

export interface ApprovalOverlayTui {
  showOverlay(
    component: Component,
    options?: ApprovalOverlayOptions,
  ): ApprovalOverlayHandle;
  // A lane-arrived ask is not caused by an input event, so the
  // app must be able to request a frame itself. Optional because the overlay
  // tests drive a fake host that only implements showOverlay; the live
  // TuiAltScreen always provides it.
  requestRender?: (force?: boolean) => void;
  // The terminal the overlay is composited on (Pi's TUI exposes
  // it). Optional — a host without it keeps the fixed command page size.
  readonly terminal?: {
    readonly rows: number;
    readonly columns: number;
  };
  // A filter over the base frame before the overlays are
  // composited (the dimmed background behind the palette); the live screen
  // honours it, a fake host simply keeps it.
  baseFilter?: ((lines: string[]) => string[]) | undefined;
}

// memoOnce decisions: first answer wins, persisted through the
// injected store so a restart/rerender never re-asks. The store is
// memory by default — file backing (like the host's approvals.json) is
// composed by the caller, never by this module (I/O confinement).
export interface ApprovalDecisionStore {
  load(): Record<string, ApprovalDecision>;
  save(decisions: Record<string, ApprovalDecision>): void;
}

class MemoryApprovalDecisionStore implements ApprovalDecisionStore {
  private decisions: Record<string, ApprovalDecision> = {};

  load(): Record<string, ApprovalDecision> {
    return { ...this.decisions };
  }

  save(decisions: Record<string, ApprovalDecision>): void {
    this.decisions = { ...decisions };
  }
}

export interface ApprovalMemo {
  decided(key: string): ApprovalDecision | undefined;
  submit(key: string, verdict: ApprovalDecision): ApprovalDecision;
}

export function createApprovalMemo(
  store?: ApprovalDecisionStore,
): ApprovalMemo {
  const backing = store ?? new MemoryApprovalDecisionStore();
  const decisions = new Map<string, ApprovalDecision>(
    Object.entries(backing.load()),
  );
  return {
    decided: (key: string): ApprovalDecision | undefined => decisions.get(key),
    submit: (key: string, verdict: ApprovalDecision): ApprovalDecision => {
      const existing = decisions.get(key);
      if (existing !== undefined) return existing;
      decisions.set(key, verdict);
      backing.save(Object.fromEntries(decisions));
      return verdict;
    },
  };
}

export interface ApprovalWaitOptions {
  readonly memo: ApprovalMemo;
  readonly maxPendingMs: number;
  readonly awaitAnswer?: (key: string) => Promise<ApprovalDecision | undefined>;
}

// Timeout→deny: every wait is bounded by maxPendingMs, so headless
// (-p) runs settle without a user. Late answers lose to the memo latch.
// A rejected awaitAnswer resolves deny (never propagates); the timer is
// always cleared via .finally.
export function waitForApproval(
  key: string,
  options: ApprovalWaitOptions,
): Promise<ApprovalDecision> {
  if (!Number.isFinite(options.maxPendingMs) || options.maxPendingMs < 0) {
    throw new RangeError(
      `maxPendingMs must be a finite non-negative number, got ${options.maxPendingMs}`,
    );
  }
  const settled = options.memo.decided(key);
  if (settled !== undefined) return Promise.resolve(settled);
  const reason = `approval timed out after ${options.maxPendingMs}ms`;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<ApprovalDecision>((resolve) => {
    timer = setTimeout(() => {
      resolve(options.memo.submit(key, { approved: false, reason }));
    }, options.maxPendingMs);
    timer.unref?.();
  });
  const answer = options.awaitAnswer?.(key);
  if (answer === undefined) {
    return timeout.finally(() => {
      if (timer !== undefined) clearTimeout(timer);
    });
  }
  const raced = Promise.race([
    answer.then(
      (verdict) =>
        verdict === undefined
          ? timeout
          : Promise.resolve(options.memo.submit(key, verdict)),
      (failure: unknown) =>
        Promise.resolve(
          options.memo.submit(key, {
            approved: false,
            reason: `approval await failed: ${failure instanceof Error ? failure.message : String(failure)}`,
          }),
        ),
    ),
    timeout,
  ]);
  return raced.finally(() => {
    if (timer !== undefined) clearTimeout(timer);
  });
}
