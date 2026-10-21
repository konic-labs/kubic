import type {
  ApprovalAskVerdict,
  ApprovalCall,
  PolicyInterceptorOptions,
} from '@kubic/agent/lane/interceptors';
import type { ToolContribution } from '@kubic/agent/lane/wrap';
import type {
  PermissionClasses,
  UnsupportedLevel,
} from '@kubic/agent/permissions';
import {
  checkAgreement,
  checkExpressible,
  toolsForClasses,
  validateClasses,
} from '@kubic/agent/permissions';
import type { ApprovalVerdict, Capability } from './policy.js';
import { PolicyValidationError, validatePolicy } from './policy.js';
import type { PreApprovals } from './pre-approvals.js';
import type { ApprovalRequest } from './request.js';
import type { AccessPosture } from './stores.js';
import { FileApprovalStore } from './stores.js';

// Adapter from the service to the agent's approve hook. Non-triggered calls
// pass immediately WITHOUT challenging — the agent keeps every guard up for
// them. Triggered calls need every raised capability approved and return
// challenged=true so the agent stands down the guards for exactly that call.
// Full-access approves everything as challenged AND records the posture —
// indicated, recorded beside the session for audit/doctor readers — never
// quiet. The ask is awaited inside the pi-durable ToolTask beforeTool hook: the
// service's own maxPendingMs bound still denies on timeout, and the hook runs
// before the tool's intent commit, so a crash while a seat is deciding re-asks
// on resume rather than resuming an unapproved call. Single-sourced with the
// agent seam: `ApprovalCall`/`ApprovalAskVerdict` are the agent's types, so
// ask and hook cannot drift apart.
export type ApprovalAsk = (call: ApprovalCall) => Promise<ApprovalAskVerdict>;

// The INSTALLED policy. This is the
// single derivation both the lane boot and `kubic doctor` read, so
// agreement between what doctor prints and what the lane enforces holds by
// construction instead of by two hand-kept copies.
//
// Deny-by-default doctrine, stated once here:
// - classes: the explicit, documented safe default is DEFAULT_PERMISSIONS
//     — filesystem workspace-write, shell true, network none,
//     git workspace, credentials none. Config-sourced classes REPLACE the
//     default when the config layer supplies them; the restrictive tail
//     (network none, credentials none) is what makes the default safe.
//   - interceptors: destructive + network + confinement guards are ALWAYS
//     installed, with the approval ask wired, so a destructive command in a
//     non-interactive run is refused rather than executed. `workspace` is
//     the confinement root: the lane cannot invent one, so it is explicit.
//   - contributions: the telemetry wrapper is appended LAST, which makes it
//     outermost — it therefore times (and records) a DENIED attempt too.
//     The permission wrapper is composed by the lane itself, innermost, from
// the same classes (boot.ts withPolicyContributions) — never duplicated
//     here.
export interface PolicyInput {
  workspace: string;
  /** Config-sourced classes; absent means the documented DEFAULT_PERMISSIONS. */
  classes?: PermissionClasses;
  /**
   * Role-sourced approval obligations: tool names
   * that always require approval under the resolved role — the union of
   * the role document's `requires` and every config `[roles.<name>]`
   * layer's. Threaded into the installed trigger context; absent means
   * none (the triggers alone decide).
   */
  requires?: string[];
  /**
   * Where the classes came from, as the CONFIG LAYER recorded it. Absent
   * falls back to the shape rule (classes present ⇒ 'config'), which is what
   * legacy callers mean; the composition root always passes the layer's own
   * answer, so a config-less install is never printed as 'config'.
   */
  source?: 'config' | 'default';
  /** Extension/facet contributions; telemetry composes outermost of them. */
  contributions?: ToolContribution[];
  /** Home directory holding the global `~/.kubic` (default os.homedir()). */
  home?: string;
  /** The session root in use; writes into it are refused. */
  sessionsRoot?: string;
  /** Telemetry sink; absent means no telemetry wrapper. */
  telemetry?: (record: { toolName: string; durationMs: number }) => void;
  /** Bounded approval wait (headless never answers; it denies on timeout). */
  maxPendingMs?: number;
  /** The approval route the shipped default runs on. */
  route?: 'ask-user' | 'deny';
  /** Stored decisions are scoped to one session (the shipped default). */
  sessionScoped?: boolean;
  /**
   * Config `[approvals] autoApprove`: capabilities approved
   * without an ask. Explicit-only — it arrives from config, never from the
   * tool path — and it is consulted before the no-surface refusal, so a
   * headless run honours it too.
   */
  autoApprove?: Capability[];
  /** Config `[approvals] requireJustification`. */
  requireJustification?: boolean;
  /**
   * A verified pre-approval file (`kubic run --pre-approvals`): the
   * capabilities, tools and commands it lists are approved without an ask,
   * checked on every call, headless included.
   */
  preApprovals?: PreApprovals;
  /** Session dir carrying posture.json (session-scoped full access). */
  sessionDir?: string;
  /**
   * The answer seat: the command's own surface for collecting a
   * verdict on a challenged call. Attached only by commands with a user
   * attached (`kubic tui`); absent means the immediate no-surface refusal
   * below, which is what every headless run keeps. An ask that resolves
   * `undefined` is a seat that could not answer — the service's own
   * maxPendingMs bound denies it rather than hanging the turn.
   */
  answer?: (
    request: ApprovalRequest,
    signal?: AbortSignal,
  ) => Promise<ApprovalVerdict | undefined>;
  clock?: () => number;
  /** Audit identity: the session (absent: sessionDir's basename). */
  sessionId?: string;
  /**
   * Audit identity: the `provider/id` the lane runs on. A function is read at
   * RECORD time, so a policy installed before the lane boots (the stored-model
   * rule) or a model switched mid-session (`/model`) is still recorded under
   * the model the lane runs now.
   */
  model?: string | (() => string);
  /**
   * Audit identity: the thinking level the lane runs. A
   * function is read at RECORD time, like the model — the policy is
   * installed before the lane boots, and `/thinking` can change it
   * mid-session. Absent keeps the honest `unknown`.
   */
  thinking?: string | (() => string | undefined);
  /**
   * Audit identity: the base revision the run started
   * from (`git rev-parse HEAD` captured once at run start, `none` outside
   * git). The composition root resolves it; the policy only carries it.
   */
  base?: string;
  /** A failed ledger append lands here; it never reaches the approval. */
  onAuditError?: (message: string) => void;
}

// The config `[approvals]` half of the install: the one shape
// the composition root projects from the config load and every entry
// point (run, tui, replay, doctor) spreads into installPolicy.
export type ApprovalConfig = Pick<
  PolicyInput,
  | 'route'
  | 'maxPendingMs'
  | 'autoApprove'
  | 'requireJustification'
  | 'sessionScoped'
>;

// What the lane installed and what doctor must print, in ONE object.
export interface InstalledPolicyPosture {
  source: 'config' | 'default';
  route: 'ask-user' | 'deny';
  classes: PermissionClasses;
  allowlist: string[];
  interceptors: string[];
  sessionScoped: boolean;
  maxPendingMs: number;
  autoApprove: string[];
  requireJustification: boolean;
  fullAccess: boolean;
  // Every declared level the tool set cannot express,
  // with the level the lane enforces instead — reported, never silent.
  unsupported: UnsupportedLevel[];
}

export interface RecordedApprovalDeny {
  capability: string;
  toolName: string;
  reason: string;
}

// The named reason a challenged call is refused with while no surface can
// collect a verdict. Named once, here, so the block reason and the headless
// run's terminus say the same sentence.
export const NO_ANSWER_SURFACE_REASON =
  'approval required, but no approval surface is installed on this command: kubic run has no ask prompt, so the call is refused; answer approvals in kubic tui, configure an approval broker or a pre-approval file, or change the approval route or policy';

export interface InstalledPolicy {
  classes: PermissionClasses;
  interceptors: PolicyInterceptorOptions;
  contributions: ToolContribution[];
  posture: InstalledPolicyPosture;
  // Approvals this policy refused, in order. The composition root reads this
  // after a drive: a headless run that hit an unanswerable approval must end
  // as an approval terminus — approval_denied for an explicit refusal,
  // approval_timed_out when the reason carries the timeout marker (both exit
  // 4) — never as a silent success.
  denials: () => RecordedApprovalDeny[];
  // The decider, exposed so a caller (or a test) can drive it directly.
  ask: ApprovalAsk;
  // The end-of-session posture check — a posture.json written
  // after the last ask is restored and recorded before the session closes.
  settle?: () => void;
  // True exactly when the ask above auto-approves every
  // challenged call as full access — the boot posture the ask
  // itself decides on, so the indicator cannot drift from the policy.
  approvalsSkipped: () => boolean;
  // The in-session toggle. Flips the LIVE posture the
  // next ask reads, writes posture.json through the same helpers the CLI
  // uses, appends the audit row, and re-bases the guard on the new
  // posture (the operator's own change is not a foreign one). Returns the
  // recorded posture; throws only when the posture file cannot be written
  // (the caller reports it, the in-memory posture stays put).
  setFullAccess?: (enabled: boolean, by: string) => AccessPosture;
  // The turn ended — an `allow all edits this turn` answer
  // stops applying. And whether one applies right now (the status line).
  endTurn?: () => void;
  editsApprovedThisTurn?: () => boolean;
}

export function installedPolicyPosture(
  input: PolicyInput,
  // The posture record read at boot; absent reads it here.
  bootPosture?: AccessPosture,
): InstalledPolicyPosture {
  const classes = validateClasses({ ...(input.classes ?? {}) });
  const allowlist = toolsForClasses(classes);
  // The derived allowlist must agree with the classes it came from —
  // a contradictory pair is refused by name here, never printed green.
  const agreement = checkAgreement(classes, allowlist);
  if (!agreement.agree) {
    throw new PolicyValidationError(
      `installed policy contradicts itself: ${agreement.reason}`,
    );
  }
  // One validation for every approval knob: the same
  // validatePolicy the config load and the service use, so the posture
  // doctor prints is exactly the policy the service enforces.
  const policy = validatePolicy({
    ...(input.route === undefined ? {} : { route: input.route }),
    ...(input.maxPendingMs === undefined
      ? {}
      : { maxPendingMs: input.maxPendingMs }),
    ...(input.autoApprove === undefined
      ? {}
      : { autoApprove: input.autoApprove }),
    ...(input.sessionScoped === undefined
      ? {}
      : { sessionScoped: input.sessionScoped }),
    ...(input.requireJustification === undefined
      ? {}
      : { requireJustification: input.requireJustification }),
  });
  const fullAccess =
    bootPosture?.fullAccess ??
    (input.sessionDir === undefined
      ? false
      : new FileApprovalStore(input.sessionDir).loadPosture().fullAccess);
  return {
    // The layer's own answer when the caller supplies it (the composition
    // root does); the shape rule only as the legacy fallback, so the printed
    // source is never a guess about a config-less install.
    source:
      input.source ?? (input.classes === undefined ? 'default' : 'config'),
    route: policy.route,
    classes: { ...classes },
    allowlist: [...allowlist],
    // Named mechanisms, not adjectives: this is exactly what the lane
    // registers (registerPolicyInterceptors) plus the execute-time wrapper
    // the lane composes from `classes`.
    interceptors: [
      'permission-wrapper',
      'destructive-guard',
      'network-guard',
      'confine-guard',
      'approval',
    ],
    sessionScoped: policy.sessionScoped,
    maxPendingMs: policy.maxPendingMs,
    autoApprove: [...policy.autoApprove],
    requireJustification: policy.requireJustification,
    fullAccess,
    unsupported: checkExpressible(classes),
  };
}
