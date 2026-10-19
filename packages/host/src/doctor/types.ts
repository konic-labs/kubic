// The doctor report's shapes, and the probes a doctor run is given.
import type { CliIo } from '../cli/index.js';
import type { FullAccessSession } from './doctor-full-access.js';

// warn is informational only: it is
// rendered, counted, and never exit-flipping — only fail flips the exit.
export type DoctorStatus = 'pass' | 'warn' | 'fail' | 'skip';

export type DoctorReason =
  | 'ok'
  | 'provider-down'
  | 'policy-mismatch'
  | 'deps-missing'
  | 'full-access'
  | 'unsupported-level'
  | 'unsupported-platform'
  | 'detection-only'
  | 'sink-unreachable'
  | 'window-default'
  | 'room-short'
  | 'skipped';

export interface DoctorCheck {
  id: string;
  label: string;
  status: DoctorStatus;
  reason: DoctorReason;
  detail: string;
}

// Provider probe input mirrors CustomProviderSpec (models-config/schema.ts)
// plus reachability — set by an injected faux prober, never by dialing.
// `dialled` is the honesty switch: absent/false means the
// provider was only LISTED (registered in the catalog, never contacted),
// and the printed line says so. A probe that really contacted the provider
// sets it true, and only then may the line claim a dial.
export interface ProviderProbe {
  id: string;
  reachable: boolean;
  detail?: string;
  models?: string[];
  dialled?: boolean;
}

export interface DepProbe {
  id: string;
  ok: boolean;
  detail?: string;
}

// A models.json model that runs on the fallback context window.
export interface ModelWindowProbe {
  readonly provider: string;
  readonly model: string;
  readonly contextWindow: number;
}

// A model the room check measures: its registry window.
export interface RoomModel {
  readonly provider: string;
  readonly model: string;
  readonly contextWindow: number;
}

// The room check's inputs: the configured compaction keys (absent: the lane
// defaults), the models the user defined in models.json (their window is theirs
// to set), and the default model the configuration selects. A built-in model is
// never measured: models.json cannot resize it. Read-only, nothing is dialled.
export interface ContextRoomProbe {
  readonly reserveTokens?: number;
  readonly keepRecentTokens?: number;
  readonly customModels: readonly RoomModel[];
  readonly defaultModel?: RoomModel;
}

export interface DoctorDeps extends CliIo {
  // The terminal width the grouped summary packs into.
  readonly columns?: number;
  probeProviders: () => ProviderProbe[];
  // Models on the fallback context window: one warn each. Absent: no check.
  probeModelWindows?: () => readonly ModelWindowProbe[];
  // The room a compaction leaves for each model: one warn when a model has
  // less than the floor. Absent: no check.
  probeContextRoom?: () => ContextRoomProbe;
  checkDeps: () => DepProbe[];
  loadPolicy: () => unknown;
  // The INSTALLED policy — the same posture object
  // the lane booted with, so the line cannot print a posture the run does
  // not enforce. Absent (legacy callers/tests): no installed-policy check,
  // the existing matrix is unchanged.
  installedPolicy?: () => InstalledPolicyPosture;
  // Role documents: the loaded `.kubic/roles/*.md`
  // set projected onto DoctorChecks — a contradictory role reports
  // fail/policy-mismatch with the resolver's named reason, and a refused
  // run can never print green. Absent: no role checks (matrices without it are
  // unchanged).
  probeRoles?: () => DoctorCheck[];
  // The skills gate probe — absent means no skills
  // checks. Same contract as probeRoles: a throwing probe becomes one
  // failing check, returned checks pass through verbatim.
  probeSkills?: () => DoctorCheck[];
  // Enterprise policy: the checks `enterpriseDoctorChecks`
  // derives from the resolved `[policy]` section, built by the composition
  // root (host never imports the app). Absent — including when no `[policy]`
  // is configured at all — means no enterprise checks and an unchanged
  // default matrix. A throwing probe becomes one named failing check.
  enterpriseChecks?: () => DoctorCheck[];
  // Configured audit sinks: the checks
  // `auditSinksDoctorChecks` derives from the loaded `[[audit]]` tables,
  // built by the composition root with real reachability probes. Absent
  // means no sink checks and an unchanged default matrix. A throwing
  // probe becomes one named failing check, never a crash.
  probeAuditSinks?: () => DoctorCheck[];
  // Repo-level session overlap: the local session
  // store's view of sessions recorded against one workspace — two or more
  // reports a warn note (concurrent different-session runs are legal; the
  // note states the sweep blind spot). Absent: no overlap check.
  probeSessionOverlap?: () => SessionOverlapProbe;
  // Full-access sessions: the composition root's
  // enumeration of the workspace's live sessions whose posture.json
  // records fullAccess (host/doctor-full-access). Absent: no per-session
  // checks (matrices without it are unchanged). A throwing probe becomes one
  // warn check, never a crash: an unlistable store must not flip the exit.
  probeFullAccessSessions?: () => FullAccessSession[];
  // The state other local users can read: session transcripts, journaled
  // file content and the trust store, walked with a bound. undefined means
  // the walk could not run here (Windows).
  probeStatePermissions?: () => StatePermissionProbe | undefined;
  // The platform the bash tool runs on; absent reads process.platform.
  readonly platform?: string;
}

// The installed posture, described once in approvals/installed-policy.ts. Host owns the
// derivation (it is the module that also owns the approval service); doctor
// only renders it, which is why this import is type-only plus a structural
// re-declaration here — the value comes in through `installedPolicy`.
export interface InstalledPolicyPosture {
  source: 'config' | 'default';
  route: 'ask-user' | 'deny';
  classes: {
    filesystem: 'none' | 'read' | 'workspace-write' | 'full';
    shell: false | 'read-only-allowlist' | true;
    network: 'none' | 'allowlist' | 'full';
    git: false | 'workspace' | 'full';
    credentials: 'none' | 'allowlist';
  };
  allowlist: string[];
  interceptors: string[];
  sessionScoped: boolean;
  maxPendingMs: number;
  autoApprove?: string[];
  requireJustification?: boolean;
  fullAccess: boolean;
  // Declared levels the tool set cannot express.
  unsupported?: readonly {
    class: string;
    level: string;
    enforcedAs: string;
    reason: string;
  }[];
}

// Repo-level session overlap input: the workspace and
// the ids of every session recorded against it in the local session store.
// The store lists sessions — it cannot prove one is RUNNING — so the check
// warns about a possible overlap, never about a verified one.
export interface SessionOverlapProbe {
  workspace: string;
  sessionIds: string[];
}

// A group- or world-accessible state directory. The probe
// reports it (and the next open tightens it); doctor warns, never fails —
// a loose directory is a real exposure but not a broken installation.
// The private-state walk: the first loose entries (each with the mode it
// should have — 0700 for a directory, 0600 for a file), how many there are,
// how many entries were examined, and whether the walk hit its bound.
export interface StatePermissionProbe {
  readonly loose: readonly {
    readonly path: string;
    readonly mode: number;
    readonly expected: number;
  }[];
  readonly count: number;
  readonly checked: number;
  readonly truncated: boolean;
}
