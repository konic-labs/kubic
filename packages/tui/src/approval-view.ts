// ApprovalView: centered modal approval dialog (issue #26).
// §41 triggers/policy/explicit autoApprove/timeout→deny/memoOnce +
// session-scoped skip; §16.4 showOverlay centered 70%/60% + visible +
// focus/unfocus + capturing (nonCapturing never set); §16.6 matchesKey /
// Focusable / CURSOR_MARKER / registry; §16.9 keybindings.
// Presentation only: mirrors the host decider semantics
// (packages/host/src/approvals.ts) structurally without importing it —
// dep-lint forbids tui → host. Pi is touched ONLY through
// ./tui-boundary.js. No node:fs in prod src (I/O confinement).

import type { Component, Focusable } from './tui-boundary.js';
import { CURSOR_MARKER, matchesKey, visibleWidth } from './tui-boundary.js';

export type ApprovalAction = 'allow-once' | 'allow-session' | 'deny';

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
}

export type ApprovalDecision =
  | { approved: true; by: string }
  | { approved: false; reason: string };

// Overlay geometry (§16.4): centered 70% width / 60% height, visible at
// 80+ columns, inline fallback below.
export const APPROVAL_MIN_WIDTH = 80;

export function shouldUseInlineFallback(width: number): boolean {
  return width < APPROVAL_MIN_WIDTH;
}

// Structural overlay options mirroring Pi's OverlayOptions (§16.4) without
// importing Pi past the seam: OverlayOptions is not a boundary export and
// the boundary is frozen for this issue. Field-for-field compatible with
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

// The overlay's size caps, as percentages of the terminal (§16.4).
const APPROVAL_OVERLAY_WIDTH_PERCENT = 70;
const APPROVAL_OVERLAY_HEIGHT_PERCENT = 60;

// Issue #316: the columns Pi gives the overlay (its own percentage rule: floor
// of the share, at least one column).
export function approvalOverlayWidth(terminalColumns: number): number {
  return Math.max(
    1,
    Math.floor((terminalColumns * APPROVAL_OVERLAY_WIDTH_PERCENT) / 100),
  );
}

// Issue #316: how many rows Pi leaves the overlay — its own percentage rule
// (floor of the share, at least one row) on the terminal's row count. Pi cuts
// what does not fit from the bottom, so the dialog fits itself to this.
export function approvalOverlayRows(terminalRows: number): number {
  return Math.max(
    1,
    Math.floor((terminalRows * APPROVAL_OVERLAY_HEIGHT_PERCENT) / 100),
  );
}

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

const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

// Issue #316: cut by terminal COLUMNS, not UTF-16 length — a row of wide
// characters is twice as wide as it is long, and the overlay compositor would
// otherwise cut it again, silently, past its own marker. The cut lands on a
// grapheme boundary and the `…` takes the last column.
function truncateLine(line: string, width: number): string {
  if (width <= 0) return '';
  if (visibleWidth(line) <= width) return line;
  const budget = width - 1;
  let kept = '';
  let used = 0;
  for (const { segment } of graphemes.segment(line)) {
    const cells = visibleWidth(segment);
    if (used + cells > budget) break;
    kept += segment;
    used += cells;
  }
  return `${kept}…`;
}

// Issue #315: how the key hints read. `armed: false` is the arming window —
// decision keys are ignored, only Esc (deny) acts — so the hint says so
// instead of advertising keys that do nothing yet. Absent means armed.
export interface ApprovalRenderOptions {
  readonly armed?: boolean;
  readonly keys?: Record<ApprovalAction, readonly string[]>;
  // Issue #316: which page of a long command is shown (wraps around).
  readonly commandPage?: number;
  // Issue #316: the rows the overlay may occupy (approvalOverlayRows). Pi cuts
  // an overlay from the bottom, so a command taller than what is left pages to
  // fit — the marker, justification and hint row always stay on screen.
  readonly maxRows?: number;
}

// Issue #316: the dialog shows what will actually run. A command wraps
// across rows; one page holds this many rows, and a taller command shows an
// explicit `… command lines a–b of n · [v] next page` marker — the height is
// capped honestly, never by a silent character slice.
export const APPROVAL_COMMAND_PAGE_LINES = 8;
export const APPROVAL_PAGE_KEY = 'v';
const COMMAND_PREFIX = 'command: ';

// Issue #316: one command line as rows that each fit `room` terminal columns.
// The unit is the grapheme cluster (a combining sequence or an emoji ZWJ
// sequence is one unit) measured with pi-tui's own width, so no character is
// cut mid-cluster or pushed past the edge where the compositor would drop it.
// A unit wider than the room still gets a row of its own — nothing is skipped.
function wrapByColumns(line: string, room: number): string[] {
  const rows: string[] = [];
  let row = '';
  let used = 0;
  for (const { segment } of graphemes.segment(line)) {
    const cells = visibleWidth(segment);
    if (used > 0 && used + cells > room) {
      rows.push(row);
      row = '';
      used = 0;
    }
    row += segment;
    used += cells;
  }
  rows.push(row);
  return rows;
}

function commandRows(command: string, width: number): string[] {
  const room = Math.max(1, width - COMMAND_PREFIX.length);
  const rows: string[] = [];
  for (const line of command.split('\n')) {
    if (line === '') {
      rows.push('');
      continue;
    }
    rows.push(...wrapByColumns(line, room));
  }
  return rows;
}

// `budget` is the rows the whole command block (marker included) may take.
function commandLines(
  command: string,
  width: number,
  page: number,
  budget?: number,
): string[] {
  const rows = commandRows(command, width);
  // A command that fits its budget (and a page) shows whole; a taller one
  // pages, and the marker takes one of the budgeted rows.
  const cap = Math.min(APPROVAL_COMMAND_PAGE_LINES, budget ?? Infinity);
  const pageLines =
    rows.length <= cap
      ? APPROVAL_COMMAND_PAGE_LINES
      : Math.max(
          1,
          Math.min(APPROVAL_COMMAND_PAGE_LINES, (budget ?? Infinity) - 1),
        );
  const pages = Math.max(1, Math.ceil(rows.length / pageLines));
  const current = ((page % pages) + pages) % pages;
  const from = current * pageLines;
  const shown = rows.slice(from, from + pageLines);
  const indent = ' '.repeat(COMMAND_PREFIX.length);
  const out = shown.map((row, index) =>
    index === 0 ? `${COMMAND_PREFIX}${row}` : `${indent}${row}`,
  );
  if (pages > 1) {
    out.push(
      `… command lines ${from + 1}–${from + shown.length} of ${rows.length} · [${APPROVAL_PAGE_KEY}] next page`,
    );
  }
  return out;
}

// Operator-facing key names: `ctrl+s` → `Ctrl-S`, `escape` → `Esc`.
export function approvalKeyLabel(key: string): string {
  if (key === 'escape') return 'Esc';
  const parts = key.split('+');
  if (parts.length === 1) return key;
  const base = (parts.at(-1) ?? '').toUpperCase();
  const mods = parts
    .slice(0, -1)
    .map((mod) => `${mod.charAt(0).toUpperCase()}${mod.slice(1)}`);
  return [...mods, base].join('-');
}

function hintLine(options: ApprovalRenderOptions): string {
  const keys = options.keys ?? APPROVAL_DEFAULT_KEYS;
  if (options.armed === false) {
    return keys.deny.includes(APPROVAL_IMMEDIATE_KEY)
      ? '… keys unlock in a moment · [Esc] deny now'
      : '… keys unlock in a moment';
  }
  const labels = (action: ApprovalAction): string =>
    keys[action].map((key) => `[${approvalKeyLabel(key)}]`).join('/');
  return `${labels('allow-once')} allow once   ${labels('allow-session')} allow session   ${labels('deny')} deny`;
}

// Issue #316: what the dialog shows when the overlay has too few rows for
// the fixed rows, the page marker and one command row. Pi cuts an overlay
// from the bottom, so a squeezed full dialog would show the first command row
// and lose the rest — including the hint row — while `a` still approved. This
// block fails closed instead: it says so, offers deny, and (the surface and
// the view both check the same layout) allow keys are inert. The deny row
// comes first so a one-row overlay still carries it.
function tooShortLines(
  request: ApprovalViewRequest,
  width: number,
  options: ApprovalRenderOptions,
): string[] {
  const keys = options.keys ?? APPROVAL_DEFAULT_KEYS;
  const deny = keys.deny.map((key) => `[${approvalKeyLabel(key)}]`).join('/');
  return [
    `Too short to show this command — ${deny} deny`,
    `Approval required: ${request.capability}`,
    `tool: ${request.toolName}`,
    'Enlarge the terminal to review the whole command.',
  ].map((line) => truncateLine(line, width));
}

interface ApprovalLayout {
  readonly lines: string[];
  // False when the full dialog needs more rows than the overlay has.
  readonly fits: boolean;
}

function layoutApproval(
  request: ApprovalViewRequest,
  width: number,
  options: ApprovalRenderOptions,
): ApprovalLayout {
  const w = Math.max(0, Math.floor(width));
  const lines = [
    `Approval required: ${request.capability}`,
    `tool: ${request.toolName}`,
  ];
  // The host's own words for the challenge (issue #96): the installed policy
  // summarizes a bash call as "capability: <the command>" and a file call as
  // "capability: <tool> <path>". Without this line the operator approves a
  // capability without seeing the operation, which is the whole point of the
  // surface. Empty means "no summary supplied" — a minimal request is not a
  // blank line. Issue #316: when the request carries the full command, that
  // is what the dialog shows — wrapped and paged, never cut — and the
  // one-line summary (a shortened copy of it) is not repeated.
  const hasCommand = request.command !== undefined && request.command !== '';
  if (!hasCommand && request.summary !== undefined && request.summary !== '') {
    lines.push(`summary: ${request.summary}`);
  }
  if (request.paths !== undefined && request.paths.length > 0) {
    lines.push(`paths: ${request.paths.join(', ')}`);
  }
  lines.push(`justification: ${request.justification ?? '(none)'}`);
  lines.push(hintLine(options));
  // Every row that is not the command: what is left of the overlay's rows is
  // the command block's budget (issue #316).
  const commandBlock = hasCommand
    ? commandLines(
        request.command ?? '',
        w,
        options.commandPage ?? 0,
        options.maxRows === undefined
          ? undefined
          : options.maxRows - lines.length,
      )
    : [];
  const head = lines.slice(0, 2).map((line) => truncateLine(line, w));
  const rest = lines.slice(2).map((line) => truncateLine(line, w));
  // The command rows are already fitted to the width (wrapped, not cut);
  // only the page marker could exceed a very narrow width.
  const full = [
    ...head,
    ...commandBlock.map((line) => truncateLine(line, w)),
    ...rest,
  ];
  // The paging above always shows at least one command row and, when it pages,
  // the marker: if even that overflows the overlay, the hint row (last) would
  // be cut, so nothing of the full dialog is shown.
  if (options.maxRows === undefined || full.length <= options.maxRows) {
    return { lines: full, fits: true };
  }
  return {
    lines: tooShortLines(request, w, options).slice(0, options.maxRows),
    fits: false,
  };
}

// Pure headless render (no VirtualTerminal in Pi 0.85.1): callers render
// these lines directly like renderLayout in layout.test.ts.
export function renderApprovalLines(
  request: ApprovalViewRequest,
  width: number,
  options: ApprovalRenderOptions = {},
): string[] {
  return layoutApproval(request, width, options).lines;
}

// Issue #316: whether the whole dialog (command rows or page marker,
// justification and hint row) fits in `maxRows` overlay rows at this width.
// The approval surface asks this to keep allow keys inert while it does not.
export function approvalFitsOverlay(
  request: ApprovalViewRequest,
  width: number,
  maxRows: number | undefined,
): boolean {
  return layoutApproval(request, width, { maxRows }).fits;
}

// Narrow-terminal fallback (w < 80): same body under an inline header so
// the approval never depends on overlay space being available.
export function renderApprovalInline(
  request: ApprovalViewRequest,
  width: number,
  options: ApprovalRenderOptions = {},
): string[] {
  const w = Math.max(0, Math.floor(width));
  return [
    truncateLine('! approval (inline) — narrow terminal', w),
    ...renderApprovalLines(request, w, options),
  ];
}

// Keybinding registry (§16.6/§16.9). Defaults live here (not in Pi's
// global KeybindingsManager — the tui seam exposes no registry writer),
// matched exclusively through matchesKey: no hardcoded key strings on
// the input path.
type ApprovalKeyId = Parameters<typeof matchesKey>[1];

export const APPROVAL_DEFAULT_KEYS: Record<
  ApprovalAction,
  readonly ApprovalKeyId[]
> = {
  // Issue #315: an approval is consent to run code with the operator's
  // authority, so type-ahead meant for the editor must never produce one.
  // allow-once and deny keep a letter but act only after the arming delay
  // below; allow-session (consent for the whole session) is Ctrl-S, which
  // prose cannot produce; Esc is the one immediate key, and it only denies.
  'allow-once': ['a'],
  'allow-session': ['ctrl+s'],
  deny: ['d', 'escape'],
};

// Issue #315: decision keys are ignored for this long after a request
// appears (and again for each queued request), so a keystroke typed into the
// editor a moment before the ask arrived cannot answer it.
export const APPROVAL_ARMING_MS = 400;

// Issue #315: after ANY key the modal swallows the unlock needs this much
// quiet, not just the first arming delay. A thinking pause in the middle of
// prose is ~0.5 s, so 400 ms after the last typed key would let the next bare
// `a` answer a request the operator never looked at; 1.5 s is a pause long
// enough to be a decision to stop typing.
export const APPROVAL_QUIET_MS = 1500;

// Issue #315: a decision key that arrives within this long of the SAME key is
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

// Issue #315: a key ordinary typing can produce — a bare character, space,
// or a shifted character (an upper-case letter or a symbol).
export function isProseKey(key: string): boolean {
  return key.length === 1 || key === 'space' || /^shift\+.$/.test(key);
}

// Issue #315 (§16.9): registry hygiene beyond action overlaps. allow-session
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

// Focus capture + explicit unfocus (§16.4). The handle types mirror Pi's
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
  // Issue #96: a lane-arrived ask is not caused by an input event, so the
  // app must be able to request a frame itself. Optional because the overlay
  // tests drive a fake host that only implements showOverlay; the live
  // TuiAltScreen always provides it.
  requestRender?: (force?: boolean) => void;
  // Issue #316: the terminal the overlay is composited on (Pi's TUI exposes
  // it). Optional — a host without it keeps the fixed command page size.
  readonly terminal?: {
    readonly rows: number;
    readonly columns: number;
  };
}

export function showApprovalOverlay(
  tui: ApprovalOverlayTui,
  view: ApprovalView,
  options?: ApprovalOverlayOptions,
): ApprovalOverlayHandle {
  // No manual focused pre-set: Pi's showOverlay focuses via setFocus (which
  // sets focused through the isFocusable guard) only when capturing AND
  // visible — isOverlayVisible honors the visible() callback, so on narrow
  // terminals Pi never focuses and the view must stay unfocused (no
  // CURSOR_MARKER). Setting focused here unconditionally would lie.
  return tui.showOverlay(view, options ?? approvalOverlayOptions());
}

export function dismissApprovalOverlay(
  view: ApprovalView,
  handle: ApprovalOverlayHandle,
  editor: Component | null,
): void {
  // unfocus moves focus to the editor but leaves the entry on Pi's
  // overlayStack (still composited); hide() is the only removal path.
  // unfocus-first: after hide() Pi's unfocus early-returns (entry gone,
  // focus already moved), so the explicit editor target would be lost.
  handle.unfocus({ target: editor });
  view.focused = false;
  handle.hide();
}

export interface ApprovalViewOptions {
  readonly request: ApprovalViewRequest;
  readonly onDecision?: (
    action: ApprovalAction,
    request: ApprovalViewRequest,
  ) => void;
  readonly onFocusEditor?: () => void;
  readonly keyOverrides?: ApprovalKeyOverrides;
  // Issue #315: the surface's arming state, read on every render so the key
  // hints unlock in the frame the surface arms. Absent means armed.
  readonly isArmed?: () => boolean;
  // Issue #316: the page of a long command the surface shows.
  readonly commandPage?: () => number;
  // Issue #316: the rows the overlay may occupy, read on every render (the
  // terminal can resize). Absent means the fixed command page size.
  readonly maxRows?: () => number | undefined;
  // Issue #316: false while the overlay is too short to show the command —
  // every allow key is then inert (deny always works). Absent means allowed.
  readonly canAllow?: () => boolean;
}

export class ApprovalView implements Component, Focusable {
  focused = false;
  private readonly viewRequest: ApprovalViewRequest;
  private readonly onDecision: (
    action: ApprovalAction,
    request: ApprovalViewRequest,
  ) => void;
  private readonly onFocusEditor: () => void;
  private readonly keyOverrides?: ApprovalKeyOverrides;
  private readonly isArmed: () => boolean;
  private readonly commandPage: () => number;
  private readonly maxRows: () => number | undefined;
  private readonly canAllow: () => boolean;

  constructor(options: ApprovalViewOptions) {
    this.viewRequest = options.request;
    this.onDecision = options.onDecision ?? (() => {});
    this.onFocusEditor = options.onFocusEditor ?? (() => {});
    this.keyOverrides = options.keyOverrides;
    this.isArmed = options.isArmed ?? (() => true);
    this.commandPage = options.commandPage ?? (() => 0);
    this.maxRows = options.maxRows ?? (() => undefined);
    this.canAllow = options.canAllow ?? (() => true);
  }

  getRequest(): ApprovalViewRequest {
    return this.viewRequest;
  }

  handleInput(data: string): void {
    const match = resolveApprovalKey(data, this.keyOverrides);
    if (match === undefined) return;
    if (!this.isArmed() && match.key !== APPROVAL_IMMEDIATE_KEY) return;
    if (match.action !== 'deny' && !this.canAllow()) return;
    this.onDecision(match.action, this.viewRequest);
    this.onFocusEditor();
  }

  render(width: number): string[] {
    const lines = renderApprovalLines(this.viewRequest, width, {
      armed: this.isArmed(),
      commandPage: this.commandPage(),
      keys: resolvedBindings(this.keyOverrides),
      maxRows: this.maxRows(),
    });
    if (this.focused && lines.length > 0) {
      lines[0] += CURSOR_MARKER;
    }
    return lines;
  }

  invalidate(): void {}
}

// memoOnce decisions (§41): first answer wins, persisted through the
// injected store so a restart/rerender never re-asks. The store is
// memory by default — file backing (like the host's approvals.json) is
// composed by the caller, never by this module (I/O confinement).
export interface ApprovalDecisionStore {
  load(): Record<string, ApprovalDecision>;
  save(decisions: Record<string, ApprovalDecision>): void;
}

export class MemoryApprovalDecisionStore implements ApprovalDecisionStore {
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

// Timeout→deny (§41): every wait is bounded by maxPendingMs, so headless
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
