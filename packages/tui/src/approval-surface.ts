// ApprovalSurface: the TUI's answer seat for the host's approval asks
// (issue #96; §41, §16.4). This is the module that turns approval-view.ts
// from a dead component into the surface the installed policy needs.
//
// Why this exists at all: the host installs the approval ask on the run path
// (packages/host/src/approvals.ts, issue #86) but no command could answer it —
// the headless runner has no TTY and the TUI had no overlay — so every
// challenged call was refused with NO_ANSWER_SURFACE_REASON. The TUI is the
// only command with a user attached, so it is the one that has to collect the
// verdict. The surface owns:
//
//   - the queue: the lane challenges one call at a time, but the decider may
//     be asked again before the previous verdict is consumed, so asks queue and
//     are answered in order (a request is never dropped: dropping one would
//     hang a turn);
//   - the boot key check: the shipped key map is verified against
//     approval-view.ts's own conflict detector, so a conflicting map is
//     refused by name instead of silently binding one action to two keys;
//   - sanitisation at ingress: the request fields are tool-call content, so
//     they are cleaned before a render function sees them.
//
// Presentation + collection only (§66): this module never decides a policy
// question. It reports what the USER pressed, and `deny` is what it reports
// when nobody can press anything.

import type {
  ApprovalAction,
  ApprovalDecision,
  ApprovalKeyOverrides,
  ApprovalViewRequest,
} from './approval-view.js';
import {
  APPROVAL_ARMING_MS,
  APPROVAL_DEFAULT_KEYS,
  APPROVAL_IMMEDIATE_KEY,
  APPROVAL_QUIET_MS,
  APPROVAL_REPEAT_MS,
  approvalKeyConflicts,
  approvalKeyProblems,
  resolveApprovalKey,
} from './approval-view.js';
import { sanitizeLaneText } from './lane-cells.js';
import { matchesKey } from './tui-boundary.js';

export { APPROVAL_DEFAULT_KEYS };

// The reason recorded when the session can no longer collect a verdict. Named
// once: the deny that a quit produces must read the same everywhere.
export const APPROVAL_CANCELLED_REASON = 'the approval was never answered';

export interface ApprovalSurfaceOptions {
  readonly keyOverrides?: ApprovalKeyOverrides;
  // Called whenever the shown request changes: an ask arrived, a decision
  // settled one, or cancelPending cleared the queue. The app uses it to
  // re-sync its overlay AND to request a render — an ask arrives from the
  // lane's own async turn, not from the input loop, so without this the
  // request would sit invisible until the operator happened to press a key
  // (the bug the end-to-end test caught: the frame never showed the overlay).
  onChange?: (() => void) | undefined;
  // Issue #315: the arming delay (APPROVAL_ARMING_MS when absent; 0 turns it
  // off), the quiet period a swallowed key restarts it with and the window in
  // which the same decision key counts as a terminal repeat
  // (APPROVAL_QUIET_MS / APPROVAL_REPEAT_MS when absent; both are off when the
  // arming delay is 0, which is the test seam), the clock they are measured on,
  // and the timer that repaints the frame the request arms in. All injectable
  // so tests are deterministic.
  armingMs?: number;
  quietMs?: number;
  repeatMs?: number;
  now?: () => number;
  setTimer?: (ms: number, fire: () => void) => () => void;
}

function defaultArmTimer(ms: number, fire: () => void): () => void {
  const timer = setTimeout(fire, ms);
  timer.unref?.();
  return () => clearTimeout(timer);
}

// Structural request: approval-view.ts's own request type plus nothing. The
// surface does not care which host service asked.
export type SurfaceRequest = ApprovalViewRequest;

/** Issue #467: the card's one-line input — a denial comment or a command. */
export interface ApprovalInput {
  readonly kind: 'comment' | 'edit';
  readonly text: string;
}

/** Issue #467: the longest comment the card takes (the host bounds it too). */
export const APPROVAL_COMMENT_MAX_CHARS = 500;
/** And the longest command an edit may grow to. */
export const APPROVAL_EDIT_MAX_CHARS = 16 * 1024;

// Text a key (or a burst of typing) inserts: no control character in it.
function insertable(data: string): boolean {
  return data !== '' && [...data].every((ch) => ch >= ' ' && ch !== '\u007f');
}

export interface ApprovalSurface {
  // Called by the decider. Resolves when the user decides (or when the
  // session gives up); never rejects.
  //
  // Issue #232: the optional AbortSignal is the asker's own bound. An abort
  // WITHDRAWS exactly this ask — the shown one is cleared and the next queued
  // ask is shown, a queued one is dropped from the queue — and resolves it as
  // a deny, so a stale question never blocks the surface and a decision
  // pressed later settles the next real ask, never the withdrawn one.
  ask(request: SurfaceRequest, signal?: AbortSignal): Promise<ApprovalDecision>;
  // Feeds one keypress. True when it settled the shown request, false when the
  // key is not a decision (the caller then routes it normally).
  decide(data: string): boolean;
  // The request currently shown, if any (queued requests are not shown).
  pending(): SurfaceRequest | undefined;
  isShowing(): boolean;
  // Issue #315: false during the arming window after a request appears —
  // every decision key but the immediate deny is ignored until then. The
  // window measures QUIET time: it restarts (for the longer APPROVAL_QUIET_MS)
  // on every key the modal swallows, and a decision key that repeats the
  // previous key inside APPROVAL_REPEAT_MS is swallowed as a terminal repeat.
  isArmed(): boolean;
  // Issue #316: false while the dialog cannot show the whole command (the
  // overlay is too short): every allow key is inert then, deny always works.
  isAllowable(): boolean;
  // Issue #315: the app dropped a key while a request shows without asking
  // `decide` (a held-key repeat): that is typing too, so the arming window
  // restarts. A no-op when nothing shows.
  noteDroppedKey(): void;
  // Issue #467: `c` (comment) or `e` (edit) opened a one-line input on the
  // card. While it is open, `typeInto` takes the keys first: text, Backspace,
  // Ctrl-U, Esc (back to the card) and Enter (send) — `settled` when Enter
  // answered the ask, `consumed` for any other key it used, undefined for a
  // key it leaves alone (a global key). `decide` takes no key meanwhile.
  inputMode(): ApprovalInput | undefined;
  typeInto(data: string): 'settled' | 'consumed' | undefined;
  // Issue #465: the shown request just came on screen (the dashboard's `a`
  // opened its card): it arms from now, like a fresh ask — a key pressed
  // with the one that opened it cannot answer it. A no-op when nothing shows.
  reveal(): void;
  // Issue #316: the page of a long command the dialog shows, and the
  // `v` key that advances it (wrapping back to the first page).
  commandPage(): number;
  nextCommandPage(): boolean;
  // Issue #459: the asks waiting behind the shown one (the card's `i of n`
  // and its `next:` row), and the `?` explanation row, closed again for
  // every new ask.
  queued(): readonly SurfaceRequest[];
  explaining(): boolean;
  toggleExplain(): boolean;
  // Settles every queued and shown request as a deny. Used by the quit path
  // and by the in-flight cancel path, so nothing is left hanging.
  cancelPending(reason?: string): void;
  // Settable change hooks (see ApprovalSurfaceOptions.onChange): the surface
  // is created by the composition root before the lane boots, so the app
  // attaches its overlay sync and render request after creation.
  onChange: (() => void) | undefined;
  // The live screen's own render request (Pi's requestRender): the app sets
  // this when it attaches the overlay, and every surface change calls it so a
  // lane-arrived ask paints a frame instead of waiting for a keypress.
  renderRequest: (() => void) | undefined;
  // Issue #316: the app's own answer to "does the shown dialog fit the overlay
  // it is composited on right now?" (it knows the live terminal size). Absent
  // means it does — a host that cannot report a size keeps the fixed layout.
  fitCheck: (() => boolean) | undefined;
  // Verifies the resolved key map; throws naming the conflicting key, a
  // prose allow-session key (issue #315), or an approval key that shadows
  // one of the caller's `reserved` global keys.
  checkKeys(reserved?: ReadonlyArray<string>): boolean;
  keys(): Record<ApprovalAction, readonly string[]>;
  // The answer seat itself (issue #96): field-for-field the host's
  // `SoloPolicyInput.answer` shape (packages/host/src/approvals.ts), typed
  // structurally because the TUI package must not import host implementation
  // — the composition root's own typecheck pins the compatibility. Asking
  // through `seat` is the ONLY way in: it delegates to ask(), so the ingress
  // sanitiser above cannot be bypassed by a caller that reaches for the seat
  // directly.
  seat(
    request: SurfaceRequest,
    signal?: AbortSignal,
  ): Promise<ApprovalDecision>;
}

interface PendingAsk {
  readonly request: SurfaceRequest;
  readonly resolve: (decision: ApprovalDecision) => void;
  // Issue #232: detaches the abort listener an ask installed. A settled ask
  // must not react to a signal that fires later.
  detach?: () => void;
}

// Sanitise a request at ingress: capability, tool name, command, paths and
// justification are all model/tool-supplied strings, and renderApprovalLines
// renders them raw (its own tests pin that). Cleaning here means every render
// path downstream — the card and the transcript — is covered by one choke point.
function sanitizeRequest(request: SurfaceRequest): SurfaceRequest {
  const paths =
    request.paths === undefined
      ? undefined
      : request.paths.map((path) => sanitizeLaneText(path));
  return {
    ...request,
    capability: sanitizeLaneText(request.capability),
    toolName: sanitizeLaneText(request.toolName),
    ...(request.command === undefined
      ? {}
      : { command: sanitizeLaneText(request.command) }),
    ...(paths === undefined ? {} : { paths }),
    ...(request.justification === undefined
      ? {}
      : { justification: sanitizeLaneText(request.justification) }),
    ...(request.summary === undefined
      ? {}
      : { summary: sanitizeLaneText(request.summary) }),
    ...(request.preview === undefined
      ? {}
      : { preview: sanitizePreview(request.preview) }),
  };
}

// Issue #459: a preview carries file content — untrusted like the rest.
// Each diff row is cleaned after its number prefix, so tabs expand from the
// content's own first column.
function sanitizePreview(
  preview: NonNullable<SurfaceRequest['preview']>,
): NonNullable<SurfaceRequest['preview']> {
  if (preview.kind === 'write') {
    return { ...preview, preview: sanitizeLaneText(preview.preview) };
  }
  return {
    ...preview,
    text: preview.text
      .split('\n')
      .map((row) => {
        const hit = /^([-+ ] *\d+ )(.*)$/u.exec(row);
        return hit === null
          ? sanitizeLaneText(row)
          : `${hit[1]}${sanitizeLaneText(hit[2] ?? '')}`;
      })
      .join('\n'),
  };
}

function decisionFor(action: ApprovalAction): ApprovalDecision {
  if (action === 'allow-once') return { approved: true, by: 'allow-once' };
  if (action === 'allow-session') {
    return { approved: true, by: 'allow-session' };
  }
  // Issue #467: the host's `ALLOW_TURN_EDITS`.
  if (action === 'allow-edits') {
    return { approved: true, by: 'allow-turn-edits' };
  }
  return { approved: false, reason: 'denied by the user' };
}

export function createApprovalSurface(
  options: ApprovalSurfaceOptions = {},
): ApprovalSurface {
  const overrides = options.keyOverrides;
  // The hooks are mutable after construction: the surface is created by the
  // composition root before the lane boots, so the app attaches its overlay
  // sync and its render request later.
  const hooks: {
    onChange: (() => void) | undefined;
    renderRequest: (() => void) | undefined;
    fitCheck: (() => boolean) | undefined;
  } = {
    onChange: options.onChange,
    renderRequest: undefined,
    fitCheck: undefined,
  };
  const queue: PendingAsk[] = [];
  let shown: PendingAsk | undefined;
  const armingMs = options.armingMs ?? APPROVAL_ARMING_MS;
  // Both follow the arming delay's off switch: with it at 0 (tests and the
  // composition root's seam) nothing ever locks.
  const quietMs = options.quietMs ?? (armingMs === 0 ? 0 : APPROVAL_QUIET_MS);
  const repeatMs =
    options.repeatMs ?? (armingMs === 0 ? 0 : APPROVAL_REPEAT_MS);
  const now = options.now ?? ((): number => performance.now());
  const setTimer = options.setTimer ?? defaultArmTimer;
  let shownAt = 0;
  // How long the current window lasts: the arming delay for a fresh request,
  // the quiet period once a key was swallowed.
  let windowMs = armingMs;
  // The previous key the surface saw, for the terminal-repeat rule.
  let lastKey: { readonly data: string; readonly at: number } | undefined;
  // Issue #467: the card's open input, if any (closed for every new ask).
  let input: ApprovalInput | undefined;
  let page = 0;
  let explain = false;
  let cancelArmTimer: (() => void) | undefined;
  // Bumped on every (re)start of the window, so a timer that outlived its
  // window (an injected timer may ignore its cancel) never repaints for it.
  let armGeneration = 0;
  const notify = (): void => {
    hooks.onChange?.();
    hooks.renderRequest?.();
  };
  const isArmed = (): boolean =>
    shown !== undefined && now() - shownAt >= windowMs;
  // Issue #315: (re)start the arming window and the repaint timer that
  // unlocks the key hints when it ends.
  const startArming = (ask: PendingAsk, ms: number): void => {
    shownAt = now();
    windowMs = ms;
    armGeneration += 1;
    cancelArmTimer?.();
    cancelArmTimer = undefined;
    if (ms > 0) {
      const generation = armGeneration;
      cancelArmTimer = setTimer(ms, () => {
        if (shown === ask && armGeneration === generation) notify();
      });
    }
  };
  // Issue #315: a swallowed key is typing, and typing means the operator is
  // not answering yet — so the next decision needs a fresh quiet period.
  // Repaints when this re-locked hints that were showing as live.
  const restartArming = (): void => {
    const current = shown;
    if (current === undefined) return;
    const wasArmed = isArmed();
    startArming(current, quietMs);
    if (wasArmed && quietMs > 0) notify();
  };
  const showNext = (): void => {
    if (shown !== undefined) return;
    shown = queue.shift();
    if (shown === undefined) return;
    // Issue #315: every request — the next queued one included — starts its
    // own arming window, and the frame repaints when it arms so the key
    // hints unlock visibly.
    page = 0;
    explain = false;
    input = undefined;
    startArming(shown, armingMs);
    notify();
  };
  const settle = (ask: PendingAsk, decision: ApprovalDecision): void => {
    ask.detach?.();
    ask.detach = undefined;
    if (shown === ask) {
      shown = undefined;
      showNext();
      if (shown === undefined) notify();
    }
    ask.resolve(decision);
  };
  // Issue #232: the asker's bound expired (or the asker went away). Withdraw
  // THIS ask — the shown one clears and the next queued ask takes the screen,
  // a queued one leaves the queue — and resolve it as a deny. Nothing else on
  // the surface changes: the withdrawal is not a decision the user made.
  const withdraw = (ask: PendingAsk): void => {
    if (shown === ask) {
      shown = undefined;
      showNext();
      if (shown === undefined) notify();
    } else {
      const at = queue.indexOf(ask);
      if (at !== -1) queue.splice(at, 1);
    }
    settle(ask, { approved: false, reason: APPROVAL_CANCELLED_REASON });
  };
  const isAllowable = (): boolean => hooks.fitCheck?.() ?? true;
  const findAction = (data: string): ApprovalAction | undefined => {
    // Classified by approval-view.ts's own resolver, which matches through
    // pi-tui's matchesKey — no raw byte comparison on the input path, so a
    // Kitty-protocol terminal's Esc ('\x1b[27u') resolves like the legacy
    // byte. Deny first is that module's documented precedence.
    const match = resolveApprovalKey(data, overrides);
    // Issue #315: the same byte again inside the OS auto-repeat window is a
    // held key, not a new press (legacy terminals flag no repeats). Esc is
    // exempt — it only ever denies.
    const at = now();
    const repeated =
      lastKey !== undefined &&
      lastKey.data === data &&
      at - lastKey.at < repeatMs;
    lastKey = { data, at };
    if (match !== undefined) {
      const immediate = match.key === APPROVAL_IMMEDIATE_KEY;
      // Inside the arming window only the immediate deny acts; a repeat never
      // decides; and while the dialog cannot show the whole command (issue
      // #316) only deny does.
      if (
        (immediate || (isArmed() && !repeated)) &&
        (match.action === 'deny' || isAllowable())
      ) {
        return match.action;
      }
    }
    // Not a decision (prose, a global key, or a decision key that came too
    // soon): the modal swallowed it, so the quiet period starts over.
    restartArming();
    return undefined;
  };
  const surface: ApprovalSurface = {
    ask: (
      request: SurfaceRequest,
      signal?: AbortSignal,
    ): Promise<ApprovalDecision> => {
      const clean = sanitizeRequest(request);
      // Already given up before the question was asked: never queue it.
      if (signal?.aborted === true) {
        return Promise.resolve({
          approved: false,
          reason: APPROVAL_CANCELLED_REASON,
        });
      }
      return new Promise<ApprovalDecision>((resolve) => {
        const ask: PendingAsk = { request: clean, resolve };
        if (signal !== undefined) {
          const onAbort = (): void => {
            if (ask.detach === undefined) return;
            ask.detach = undefined;
            withdraw(ask);
          };
          signal.addEventListener('abort', onAbort, { once: true });
          ask.detach = () => signal.removeEventListener('abort', onAbort);
        }
        queue.push(ask);
        showNext();
      });
    },
    get onChange(): (() => void) | undefined {
      return hooks.onChange;
    },
    set onChange(next: (() => void) | undefined) {
      hooks.onChange = next;
    },
    // The app sets this after it attaches the overlay: a lane-arrived ask
    // must paint a frame, and only the live screen can request one.
    get renderRequest(): (() => void) | undefined {
      return hooks.renderRequest;
    },
    set renderRequest(next: (() => void) | undefined) {
      hooks.renderRequest = next;
    },
    get fitCheck(): (() => boolean) | undefined {
      return hooks.fitCheck;
    },
    set fitCheck(next: (() => boolean) | undefined) {
      hooks.fitCheck = next;
    },
    queued: (): readonly SurfaceRequest[] => queue.map((ask) => ask.request),
    explaining: (): boolean => shown !== undefined && explain,
    toggleExplain: (): boolean => {
      if (shown === undefined) return false;
      explain = !explain;
      notify();
      return true;
    },
    decide: (data: string): boolean => {
      const current = shown;
      if (current === undefined || input !== undefined) return false;
      const action = findAction(data);
      if (action === undefined) return false;
      // Issue #467: `c` and `e` open the card's input instead of answering;
      // `e` and `A` act only on the asks the host offered them for.
      if (action === 'comment') {
        input = { kind: 'comment', text: '' };
        notify();
        return false;
      }
      if (action === 'edit') {
        if (current.request.editable !== true) return false;
        input = { kind: 'edit', text: current.request.command ?? '' };
        notify();
        return false;
      }
      if (action === 'allow-edits' && current.request.batchable !== true) {
        return false;
      }
      settle(current, decisionFor(action));
      return true;
    },
    inputMode: (): ApprovalInput | undefined =>
      shown === undefined ? undefined : input,
    typeInto: (data: string): 'settled' | 'consumed' | undefined => {
      const current = shown;
      const open = input;
      if (current === undefined || open === undefined) return undefined;
      if (matchesKey(data, 'escape')) {
        input = undefined;
        notify();
        return 'consumed';
      }
      if (matchesKey(data, 'enter')) {
        const text = open.text.trim();
        if (open.kind === 'comment') {
          input = undefined;
          settle(current, {
            approved: false,
            reason:
              text === ''
                ? 'denied by the user'
                : `denied by the user: ${text}`,
          });
          return 'settled';
        }
        // An emptied command is not an answer: the input stays open.
        if (text === '') return 'consumed';
        input = undefined;
        settle(
          current,
          text === (current.request.command ?? '').trim()
            ? { approved: true, by: 'allow-once' }
            : {
                approved: true,
                by: 'allow-once',
                edited: { command: open.text },
              },
        );
        return 'settled';
      }
      if (matchesKey(data, 'backspace')) {
        input = { ...open, text: [...open.text].slice(0, -1).join('') };
        notify();
        return 'consumed';
      }
      if (matchesKey(data, 'ctrl+u')) {
        input = { ...open, text: '' };
        notify();
        return 'consumed';
      }
      if (insertable(data)) {
        const max =
          open.kind === 'comment'
            ? APPROVAL_COMMENT_MAX_CHARS
            : APPROVAL_EDIT_MAX_CHARS;
        input = { ...open, text: `${open.text}${data}`.slice(0, max) };
        notify();
        return 'consumed';
      }
      return undefined;
    },
    pending: (): SurfaceRequest | undefined => shown?.request,
    isShowing: (): boolean => shown !== undefined,
    isArmed,
    isAllowable,
    noteDroppedKey: restartArming,
    reveal: (): void => {
      const current = shown;
      if (current === undefined) return;
      const wasArmed = isArmed();
      startArming(current, armingMs);
      if (wasArmed && armingMs > 0) notify();
    },
    commandPage: (): number => page,
    nextCommandPage: (): boolean => {
      if (shown === undefined) return false;
      page += 1;
      notify();
      return true;
    },
    cancelPending: (reason?: string): void => {
      const decision: ApprovalDecision = {
        approved: false,
        reason: reason ?? APPROVAL_CANCELLED_REASON,
      };
      const waiting = [...queue];
      queue.length = 0;
      const current = shown;
      shown = undefined;
      const settleAll = [current, ...waiting];
      for (const ask of settleAll) {
        if (ask === undefined) continue;
        ask.detach?.();
        ask.detach = undefined;
        ask.resolve(decision);
      }
      if (current !== undefined || waiting.length > 0) notify();
    },
    checkKeys: (reserved?: ReadonlyArray<string>): boolean => {
      const conflicts = approvalKeyConflicts(overrides);
      const first = conflicts[0];
      if (first !== undefined) {
        throw new Error(`approval key conflict: ${first.key}`);
      }
      const problem = approvalKeyProblems(overrides, reserved)[0];
      if (problem !== undefined) throw new Error(problem);
      return true;
    },
    keys: (): Record<ApprovalAction, readonly string[]> => ({
      'allow-once': [
        ...(overrides?.['allow-once'] ?? APPROVAL_DEFAULT_KEYS['allow-once']),
      ],
      'allow-session': [
        ...(overrides?.['allow-session'] ??
          APPROVAL_DEFAULT_KEYS['allow-session']),
      ],
      deny: [...(overrides?.deny ?? APPROVAL_DEFAULT_KEYS.deny)],
      comment: [...(overrides?.comment ?? APPROVAL_DEFAULT_KEYS.comment)],
      edit: [...(overrides?.edit ?? APPROVAL_DEFAULT_KEYS.edit)],
      'allow-edits': [
        ...(overrides?.['allow-edits'] ?? APPROVAL_DEFAULT_KEYS['allow-edits']),
      ],
    }),
    // Delegates to ask() so the sanitiser, the queue and the abort path are
    // always in the path. `seat` is also the value runTuiCommand hands the
    // boot (and what the host's service calls with its own AbortSignal).
    seat: (
      request: SurfaceRequest,
      signal?: AbortSignal,
    ): Promise<ApprovalDecision> => surface.ask(request, signal),
  };
  return surface;
}
