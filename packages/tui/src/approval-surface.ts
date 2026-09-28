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
//   - the width rule (§16.4, criterion 2): at/above APPROVAL_MIN_WIDTH the
//     overlay is the surface, below it the inline body is, and the two are
//     mutually exclusive by construction;
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
  APPROVAL_MIN_WIDTH,
  approvalKeyConflicts,
  approvalKeyProblems,
  renderApprovalInline,
  renderApprovalLines,
  resolveApprovalKey,
  shouldUseInlineFallback,
} from './approval-view.js';
import { sanitizeLaneText } from './lane-cells.js';

export { APPROVAL_DEFAULT_KEYS, APPROVAL_MIN_WIDTH };

// The inline body's own header (approval-view.ts renders it): named here so
// callers and tests assert the same string instead of a literal.
export const INLINE_APPROVAL_HEADER = '! approval (inline) — narrow terminal';

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
  // off), the clock it is measured on, and the timer that repaints the frame
  // the request arms in. All injectable so tests are deterministic.
  armingMs?: number;
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

export interface ApprovalSurface {
  // Called by the decider. Resolves when the user decides (or when the
  // session gives up); never rejects.
  ask(request: SurfaceRequest): Promise<ApprovalDecision>;
  // Feeds one keypress. True when it settled the shown request, false when the
  // key is not a decision (the caller then routes it normally).
  decide(data: string): boolean;
  // The request currently shown, if any (queued requests are not shown).
  pending(): SurfaceRequest | undefined;
  isShowing(): boolean;
  // Issue #315: false during the arming window after a request appears —
  // every decision key but the immediate deny is ignored until then.
  isArmed(): boolean;
  // Settles every queued and shown request as a deny. Used by the quit path
  // and by the in-flight cancel path, so nothing is left hanging.
  cancelPending(reason?: string): void;
  // The body to render instead of an overlay at this width.
  renderInline(width: number): string[];
  // The body an overlay composites at this width.
  renderOverlayBody(width: number): string[];
  usesInlineFallback(width: number): boolean;
  // Settable change hooks (see ApprovalSurfaceOptions.onChange): the surface
  // is created by the composition root before the lane boots, so the app
  // attaches its overlay sync and render request after creation.
  onChange: (() => void) | undefined;
  // The live screen's own render request (Pi's requestRender): the app sets
  // this when it attaches the overlay, and every surface change calls it so a
  // lane-arrived ask paints a frame instead of waiting for a keypress.
  renderRequest: (() => void) | undefined;
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
  seat(request: SurfaceRequest): Promise<ApprovalDecision>;
}

interface PendingAsk {
  readonly request: SurfaceRequest;
  readonly resolve: (decision: ApprovalDecision) => void;
}

// Sanitise a request at ingress: capability, tool name, command, paths and
// justification are all model/tool-supplied strings, and renderApprovalLines
// renders them raw (its own tests pin that). Cleaning here means every render
// path downstream — overlay and inline both — is covered by one choke point.
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
  };
}

function decisionFor(action: ApprovalAction): ApprovalDecision {
  if (action === 'allow-once') return { approved: true, by: 'allow-once' };
  if (action === 'allow-session') {
    return { approved: true, by: 'allow-session' };
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
  } = {
    onChange: options.onChange,
    renderRequest: undefined,
  };
  const queue: PendingAsk[] = [];
  let shown: PendingAsk | undefined;
  const armingMs = options.armingMs ?? APPROVAL_ARMING_MS;
  const now = options.now ?? ((): number => performance.now());
  const setTimer = options.setTimer ?? defaultArmTimer;
  let shownAt = 0;
  let cancelArmTimer: (() => void) | undefined;
  const notify = (): void => {
    hooks.onChange?.();
    hooks.renderRequest?.();
  };
  const isArmed = (): boolean =>
    shown !== undefined && now() - shownAt >= armingMs;
  const showNext = (): void => {
    if (shown !== undefined) return;
    shown = queue.shift();
    if (shown === undefined) return;
    // Issue #315: every request — the next queued one included — starts its
    // own arming window, and the frame repaints when it arms so the key
    // hints unlock visibly.
    shownAt = now();
    cancelArmTimer?.();
    cancelArmTimer = undefined;
    if (armingMs > 0) {
      const arming = shown;
      cancelArmTimer = setTimer(armingMs, () => {
        if (shown === arming) notify();
      });
    }
    notify();
  };
  const settle = (ask: PendingAsk, decision: ApprovalDecision): void => {
    if (shown === ask) {
      shown = undefined;
      showNext();
      if (shown === undefined) notify();
    }
    ask.resolve(decision);
  };
  const findAction = (data: string): ApprovalAction | undefined => {
    // Classified by approval-view.ts's own resolver, which matches through
    // pi-tui's matchesKey — no raw byte comparison on the input path, so a
    // Kitty-protocol terminal's Esc ('\x1b[27u') resolves like the legacy
    // byte. Deny first is that module's documented precedence.
    const match = resolveApprovalKey(data, overrides);
    if (match === undefined) return undefined;
    // Issue #315: inside the arming window only the immediate deny acts.
    if (!isArmed() && match.key !== APPROVAL_IMMEDIATE_KEY) return undefined;
    return match.action;
  };
  const surface: ApprovalSurface = {
    ask: (request: SurfaceRequest): Promise<ApprovalDecision> => {
      const clean = sanitizeRequest(request);
      return new Promise<ApprovalDecision>((resolve) => {
        queue.push({ request: clean, resolve });
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
    decide: (data: string): boolean => {
      const current = shown;
      if (current === undefined) return false;
      const action = findAction(data);
      if (action === undefined) return false;
      settle(current, decisionFor(action));
      return true;
    },
    pending: (): SurfaceRequest | undefined => shown?.request,
    isShowing: (): boolean => shown !== undefined,
    isArmed,
    cancelPending: (reason?: string): void => {
      const decision: ApprovalDecision = {
        approved: false,
        reason: reason ?? APPROVAL_CANCELLED_REASON,
      };
      const waiting = [...queue];
      queue.length = 0;
      const current = shown;
      shown = undefined;
      if (current !== undefined) current.resolve(decision);
      for (const ask of waiting) ask.resolve(decision);
      if (current !== undefined || waiting.length > 0) notify();
    },
    renderInline: (width: number): string[] => {
      const current = shown;
      if (current === undefined) return [];
      return renderApprovalInline(current.request, width, {
        armed: isArmed(),
        keys: surface.keys(),
      });
    },
    renderOverlayBody: (width: number): string[] => {
      const current = shown;
      if (current === undefined) return [];
      return renderApprovalLines(current.request, width, {
        armed: isArmed(),
        keys: surface.keys(),
      });
    },
    usesInlineFallback: (width: number): boolean =>
      shouldUseInlineFallback(width),
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
    }),
    // Delegates to ask() so the sanitiser and the queue are always in the
    // path. `seat` is also the value runTuiCommand hands the boot.
    seat: (request: SurfaceRequest): Promise<ApprovalDecision> =>
      surface.ask(request),
  };
  return surface;
}
