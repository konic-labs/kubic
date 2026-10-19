// The ledger records Kubic writes: one builder per kind (an approval decision,
// a run start, an undo restore, a credential use, a full-access change, a
// posture change), each producing the input emitAudit validates.

import type { RunMode } from '@kubic/agent/permissions';
import type { AuditInput } from './audit.js';
import { toCredentialSentinel } from './audit.js';

// Placeholder for a field the recording site genuinely does not know.
// The record stays honest: it says "unknown", it never invents a value.
const UNKNOWN = 'unknown';

// No network, no credential: an approval decision is not a network action.
const NO_NETWORK = {
  host: 'none',
  port: 0,
  decision: 'deny',
  bytes: 0,
} as const;

function parseModel(model: string | undefined): {
  provider: string;
  id: string;
} {
  if (model === undefined || model === '') {
    return { provider: UNKNOWN, id: UNKNOWN };
  }
  const slash = model.indexOf('/');
  return slash > 0
    ? { provider: model.slice(0, slash), id: model.slice(slash + 1) }
    : { provider: UNKNOWN, id: model };
}

type Verdict =
  | { approved: true; by: string }
  | { approved: false; reason: string };

function verdictFields(verdict: Verdict): {
  approval: string;
  result: 'ok' | 'deny';
  reason: string;
} {
  return verdict.approved
    ? {
        approval: `approved by ${verdict.by}`,
        result: 'ok',
        reason: 'approved',
      }
    : {
        approval: 'denied',
        result: 'deny',
        reason: verdict.reason || 'denied',
      };
}

// Audit record for an approval decision (the in-process lane's ask).
export interface DecisionInput {
  sessionId: string;
  toolName: string;
  trigger: string;
  workspace: string;
  model?: string;
  thinking?: string;
  /**
   * The base revision the run started from: `git rev-parse
   * HEAD` captured once at run start, `none` outside git. Absent keeps the
   * honest `unknown`.
   */
  base?: string;
  approved: boolean;
  by?: string;
  reason?: string;
  /** An approval's recorded note (an edited command). */
  note?: string;
  posture: string;
}

export function decisionAudit(input: DecisionInput): AuditInput {
  const { approval, result, reason } = verdictFields(
    input.approved
      ? { approved: true, by: input.by ?? 'user' }
      : { approved: false, reason: input.reason ?? 'denied' },
  );
  // An approval's own note (an edited command names both) is
  // its recorded reason.
  const recorded =
    input.approved && input.note !== undefined ? input.note : reason;
  return {
    who: 'agent:root',
    what: `tool:${input.toolName || UNKNOWN}`,
    agent: { session: input.sessionId || UNKNOWN, role: 'root' },
    model: { ...parseModel(input.model), thinking: input.thinking || UNKNOWN },
    process: { pid: process.pid },
    workspace: {
      path: input.workspace || UNKNOWN,
      base: input.base ?? UNKNOWN,
    },
    permission: { permission: `trigger:${input.trigger || UNKNOWN}`, approval },
    credential: { sentinel: 'none' },
    network: { ...NO_NETWORK },
    posture: input.posture,
    result,
    reason: recorded,
  };
}

// The `level = "privileged"` filter: a `[[audit]]` sink
// at the privileged level keeps approval decisions (`tool:<name>`) and the
// privileged-action whats, and drops the rest (`credential:<provider>`).
// The repo ledger always keeps everything — the level only gates
// configured sinks.
export function isPrivilegedAuditWhat(what: string): boolean {
  return (
    what.startsWith('tool:') ||
    // The run-start row is a decision-grade record (it names
    // the autonomous combination), not a privileged ACTION — the action
    // kinds stay closed.
    what === 'run:start' ||
    what === 'posture:full-access' ||
    // The revoke half of a privileged
    // posture change reaches privileged sinks too — the disable half of
    // a grant must never vanish while the grant is kept.
    what === 'posture:approvals' ||
    what === 'undo-restore' ||
    // A gate command is arbitrary shell from the config, run outside the
    // approval interceptors: an action, not a decision.
    what.startsWith('verify:')
  );
}

// Audit record for a journal undo restore: the user-level act of
// putting files back. restored names the restored paths, skipped counts the
// steps left in place — a partial restore (exit 1) records 'error'.
export interface UndoRestoreInput {
  /** Absent for a workspace-scoped undo (no session) — records unknown. */
  sessionId?: string;
  workspace: string;
  base?: string;
  restored: string[];
  skipped?: number;
}

export function undoRestoreAudit(input: UndoRestoreInput): AuditInput {
  const skipped = input.skipped ?? 0;
  const files =
    input.restored.length === 1 ? '1 file' : `${input.restored.length} file(s)`;
  return {
    who: 'user:cli',
    what: 'undo-restore',
    agent: { session: input.sessionId || UNKNOWN, role: 'user' },
    model: { provider: UNKNOWN, id: UNKNOWN, thinking: UNKNOWN },
    process: { pid: process.pid },
    workspace: { path: input.workspace, base: input.base || UNKNOWN },
    permission: { permission: 'journal:undo', approval: 'user command' },
    credential: { sentinel: 'none' },
    network: { ...NO_NETWORK },
    posture: 'approvals',
    result: skipped > 0 ? 'error' : 'ok',
    reason:
      `restored ${files}: ${input.restored.join(', ')}` +
      (skipped > 0 ? `; ${skipped} skipped` : ''),
  };
}

// Audit record for one `[verify]` gate command a run executed: the command
// is shell from the config — a trusted project's included — and runs outside
// the approval interceptors, so each run of one is on record with its
// verdict. `baseline` marks the run at the base revision's throwaway
// checkout.
export interface VerifyCommandInput {
  sessionId: string;
  workspace: string;
  base: string;
  gate: string;
  command: string;
  verdict: 'pass' | 'fail';
  baseline: boolean;
}

export function verifyCommandAudit(input: VerifyCommandInput): AuditInput {
  return {
    who: 'config:verify',
    what: `verify:${input.gate}`,
    agent: { session: input.sessionId || UNKNOWN, role: 'verify' },
    model: { provider: UNKNOWN, id: UNKNOWN, thinking: UNKNOWN },
    process: { pid: process.pid },
    workspace: { path: input.workspace, base: input.base || UNKNOWN },
    permission: { permission: 'verify:command', approval: 'config [verify]' },
    credential: { sentinel: 'none' },
    network: { ...NO_NETWORK },
    posture: 'approvals',
    result: input.verdict === 'pass' ? 'ok' : 'error',
    reason: `${input.baseline ? 'baseline ' : ''}${input.gate} gate ran sh -c ${JSON.stringify(input.command)}: ${input.verdict}`,
  };
}

// Audit record for one credential use: the ref
// (as a sentinel), the role and the purpose — never the value.
export interface CredentialUseInput {
  sessionId: string;
  role: string;
  provider: string;
  ref: string;
  purpose: string;
  workspace: string;
  when?: string;
}

export function credentialUseAudit(input: CredentialUseInput): AuditInput {
  return {
    who: `agent:${input.role || UNKNOWN}`,
    what: `credential:${input.provider || UNKNOWN}`,
    ...(input.when === undefined ? {} : { when: input.when }),
    agent: { session: input.sessionId || UNKNOWN, role: input.role || UNKNOWN },
    model: {
      provider: input.provider || UNKNOWN,
      id: UNKNOWN,
      thinking: UNKNOWN,
    },
    process: { pid: process.pid },
    workspace: { path: input.workspace || UNKNOWN, base: UNKNOWN },
    permission: {
      permission: 'credential:use',
      approval: 'resolved at request time',
    },
    credential: { sentinel: toCredentialSentinel(input.ref) },
    network: { ...NO_NETWORK },
    posture: 'credentials',
    result: 'ok',
    reason: input.purpose,
  };
}

// Audit record for switching a session to full access:
// who enabled it (the user, through the CLI), when, for which session, and
// through which command. One row per enable; the per-ask rows that follow
// carry posture 'full-access' on their own.
export interface FullAccessEnabledInput {
  sessionId: string;
  /** The originating command line, e.g. `kubic run --dangerously-skip-approvals`. */
  command: string;
  workspace: string;
}

export function fullAccessEnabledAudit(
  input: FullAccessEnabledInput,
): AuditInput {
  return {
    who: 'user:cli',
    what: 'posture:full-access',
    agent: { session: input.sessionId || UNKNOWN, role: 'user' },
    model: { provider: UNKNOWN, id: UNKNOWN, thinking: UNKNOWN },
    process: { pid: process.pid },
    workspace: { path: input.workspace || UNKNOWN, base: UNKNOWN },
    permission: {
      permission: 'posture:full-access',
      approval: `enabled by ${input.command}`,
    },
    credential: { sentinel: 'none' },
    network: { ...NO_NETWORK },
    posture: 'full-access',
    result: 'ok',
    reason: `full access enabled for session ${input.sessionId || UNKNOWN} by ${input.command}`,
  };
}

// Audit record for a run's start: the mode the run
// resolved — explicit `--autonomous` or off by default — so the audit trail
// names the autonomous combination the session records. A run record, not a
// privileged action: it is kept at the privileged sink level beside the
// decisions, while the privileged action kinds stay a closed set.
export interface RunStartInput {
  sessionId?: string;
  /** The originating command, e.g. `kubic run`. */
  command: string;
  /** The run's mode. */
  runMode: RunMode;
  workspace?: string;
  posture: string;
  /** Whether `--autonomous` was passed explicitly. */
  autonomous: boolean;
  /** The resolved worktree base revision: the caller passes
   *  its `runBase`; absent, the row stays honestly `unknown`. */
  base?: string;
}

export function runStartAudit(input: RunStartInput): AuditInput {
  const role = 'root';
  return {
    who: 'user:cli',
    what: 'run:start',
    agent: { session: input.sessionId || UNKNOWN, role },
    model: { provider: UNKNOWN, id: UNKNOWN, thinking: UNKNOWN },
    process: { pid: process.pid },
    workspace: {
      path: input.workspace || UNKNOWN,
      base: input.base || UNKNOWN,
    },
    permission: {
      permission: 'run:start',
      approval: `started by ${input.command}`,
    },
    credential: { sentinel: 'none' },
    network: { ...NO_NETWORK },
    posture: input.posture,
    result: 'ok',
    reason:
      `run started in ${input.runMode} mode by ${input.command}` +
      (input.autonomous ? ' (--autonomous)' : ''),
  };
}

// audit record for switching a session BACK to enforced approvals: the TUI's
// in-session toggle off, the symmetric half of `fullAccessEnabledAudit`. One
// row per disable, so the ledger carries the whole posture history in order.
export interface FullAccessDisabledInput {
  sessionId: string;
  /** The originating action, e.g. `kubic tui /approvals off`. */
  command: string;
  workspace: string;
}

export function fullAccessDisabledAudit(
  input: FullAccessDisabledInput,
): AuditInput {
  return {
    who: 'user:tui',
    what: 'posture:approvals',
    agent: { session: input.sessionId || UNKNOWN, role: 'user' },
    model: { provider: UNKNOWN, id: UNKNOWN, thinking: UNKNOWN },
    process: { pid: process.pid },
    workspace: { path: input.workspace || UNKNOWN, base: UNKNOWN },
    permission: {
      permission: 'posture:approvals',
      approval: `disabled by ${input.command}`,
    },
    credential: { sentinel: 'none' },
    network: { ...NO_NETWORK },
    posture: 'approvals',
    result: 'ok',
    reason: `full access disabled for session ${input.sessionId || UNKNOWN} by ${input.command}`,
  };
}

// Audit record for a posture.json change made DURING a session:
// the change is refused — the boot posture stays in force and the file is
// restored — and recorded once, so a model-written grant is never mistaken
// for the user's.
export interface PostureChangedInput {
  sessionId: string;
  workspace: string;
  bootFullAccess: boolean;
  observedFullAccess: boolean;
}

export function postureChangedAudit(input: PostureChangedInput): AuditInput {
  const boot = input.bootFullAccess ? 'full-access' : 'approvals';
  const seen = input.observedFullAccess ? 'full-access' : 'approvals';
  return {
    who: 'agent:root',
    what: 'posture:changed-mid-session',
    agent: { session: input.sessionId || UNKNOWN, role: 'root' },
    model: { provider: UNKNOWN, id: UNKNOWN, thinking: UNKNOWN },
    process: { pid: process.pid },
    workspace: { path: input.workspace || UNKNOWN, base: UNKNOWN },
    permission: { permission: 'posture:change', approval: 'denied' },
    credential: { sentinel: 'none' },
    network: { ...NO_NETWORK },
    posture: boot,
    result: 'deny',
    reason: `posture.json changed during the session (${boot} -> ${seen}); ignored and restored — the posture decided at boot stays in force`,
  };
}
