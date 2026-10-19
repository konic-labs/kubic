// The policy checks: the posture the lane would install, what that posture
// can only detect rather than enforce, and the configured approvals.

import {
  describeUnsupported,
  effectiveCredentialLevel,
  effectiveNetworkLevel,
} from '@kubic/agent/permissions';
import {
  alwaysAskAutoApprove,
  CAPABILITIES,
  validatePolicy,
} from '../../approvals/index.js';
import type { DoctorCheck, InstalledPolicyPosture } from '../types.js';

// The config-sourced approval policy as policy:approvals validated it — the
// half the installed posture must agree with.
export interface ConfiguredApprovals {
  route: string;
  maxPendingMs: number;
}

export function configuredApprovals(
  raw: unknown,
): ConfiguredApprovals | undefined {
  try {
    const policy = validatePolicy(raw);
    return { route: policy.route, maxPendingMs: policy.maxPendingMs };
  } catch {
    return undefined;
  }
}

export function installedPolicyCheck(
  posture: InstalledPolicyPosture,
  configured?: ConfiguredApprovals,
): DoctorCheck {
  const base = { id: 'policy:installed', label: 'policy installed' };
  // The route and bound the lane installs must be the
  // ones config declares — two contradictory green lines are the false
  // confidence doctor exists to prevent.
  if (
    configured !== undefined &&
    (configured.route !== posture.route ||
      configured.maxPendingMs !== posture.maxPendingMs)
  ) {
    return {
      ...base,
      status: 'fail',
      reason: 'policy-mismatch',
      detail: `installed approval policy (route=${posture.route}, maxPendingMs=${posture.maxPendingMs}) differs from config (route=${configured.route}, maxPendingMs=${configured.maxPendingMs})`,
    };
  }
  // What doctor prints must be what the lane enforces. The posture
  // carries both halves, so a contradiction is detectable from the object
  // itself — an empty allowlist is a real posture (filesystem none), a
  // missing guard list is not.
  if (posture.interceptors.length === 0) {
    return {
      ...base,
      status: 'fail',
      reason: 'policy-mismatch',
      detail:
        'installed policy declares no interceptors — nothing would guard a destructive command',
    };
  }
  if (
    posture.route === 'ask-user' &&
    !posture.interceptors.includes('approval')
  ) {
    return {
      ...base,
      status: 'fail',
      reason: 'policy-mismatch',
      detail:
        'installed policy routes to ask-user without an approval interceptor — a challenged call could never be decided',
    };
  }
  if (posture.classes.credentials !== 'none' && posture.fullAccess) {
    return {
      ...base,
      status: 'fail',
      reason: 'policy-mismatch',
      detail:
        'installed policy combines credential access with full-access posture — contradictory install',
    };
  }
  const unsupported = posture.unsupported ?? [];
  // A level the lane cannot express is never printed green —
  // the check warns and names each one with the level actually enforced.
  const unsupportedTail =
    unsupported.length === 0
      ? ''
      : `; unsupported: ${unsupported.map(describeUnsupported).join('; ')}`;
  return {
    ...base,
    status: unsupported.length === 0 ? 'pass' : 'warn',
    reason: unsupported.length === 0 ? 'ok' : 'unsupported-level',
    detail:
      `source=${posture.source}, filesystem=${posture.classes.filesystem}, ` +
      `shell=${String(posture.classes.shell)}, network=${posture.classes.network}, ` +
      `git=${String(posture.classes.git)}, credentials=${posture.classes.credentials}; ` +
      `${posture.allowlist.length} allowed tool(s): ${posture.allowlist.join(', ')}; ` +
      `guards: ${posture.interceptors.join(', ')}; route=${posture.route}, ` +
      `maxPendingMs=${posture.maxPendingMs}, ` +
      `autoApprove=${(posture.autoApprove ?? []).join(',') || 'none'}` +
      `${posture.requireJustification === true ? ', requireJustification' : ''}` +
      `${
        posture.fullAccess
          ? '; FULL ACCESS recorded for this session — every guard stands down for challenged calls'
          : ''
      }${unsupportedTail}`,
  };
}

// An installed class whose restriction is LEXICAL
// DETECTION, not enforcement. `policy:installed` prints the classes as facts;
// this check names the ones a run cannot actually hold, so the line is never
// read as a sandbox. Warn only — it discloses a limit, it does not flip the
// exit (the same contract as the static notices). Omitted entirely when
// every installed class is structurally enforced (or unrestricted), so a
// matrix that has nothing to disclose gains no line.
export function detectionOnlyCheck(
  posture: InstalledPolicyPosture,
): DoctorCheck | undefined {
  const lexical: string[] = [];
  if (effectiveNetworkLevel(posture.classes.network) === 'none') {
    lexical.push(
      'network=none is a lexical bash command detector for the listed network clients (curl, wget, ssh, git clone/fetch/pull, gh, docker pull, …) — an interpreter, a script the agent writes and runs, or an unlisted tool can still reach the network',
    );
  }
  if (posture.classes.filesystem !== 'none') {
    lexical.push(
      `filesystem=${posture.classes.filesystem} is lexical path confinement — symlinks are not resolved and the shell can still read anything the command does not name`,
    );
  }
  if (effectiveCredentialLevel(posture.classes.credentials) === 'none') {
    lexical.push(
      'credentials=none is a lexical credential-path detector — only the listed paths are challenged',
    );
  }
  if (lexical.length === 0) return undefined;
  return {
    id: 'policy:detection-only',
    label: 'policy detection only',
    status: 'warn',
    reason: 'detection-only',
    detail: `detection only (not enforcement): ${lexical.join('; ')}`,
  };
}

// Policy mismatches: unknown autoApprove capabilities (anything
// outside CAPABILITIES and the dynamic `requires:<tool>` triggers),
// autoApprove entries that can never apply under route=deny, and any
// policy that fails host validation outright. An always-ask capability
// (kubic-state-write) in autoApprove is a named warning, not a failure: the
// config contract keeps accepting it and the lane ignores it.
export function policyCheck(raw: unknown): DoctorCheck {
  const base = {
    id: 'policy:approvals',
    label: 'policy approvals',
  };
  let policy: { route: string; autoApprove: string[]; maxPendingMs: number };
  try {
    const validated = validatePolicy(raw);
    policy = {
      route: validated.route,
      autoApprove: validated.autoApprove,
      maxPendingMs: validated.maxPendingMs,
    };
  } catch (error) {
    return {
      ...base,
      status: 'fail',
      reason: 'policy-mismatch',
      detail: error instanceof Error ? error.message : String(error),
    };
  }
  const unknown = policy.autoApprove.filter(
    (cap) =>
      !(CAPABILITIES as readonly string[]).includes(cap) &&
      !cap.startsWith('requires:'),
  );
  if (unknown.length > 0) {
    return {
      ...base,
      status: 'fail',
      reason: 'policy-mismatch',
      detail: `unknown autoApprove capabilities: ${unknown.join(', ')}`,
    };
  }
  if (policy.route === 'deny' && policy.autoApprove.length > 0) {
    return {
      ...base,
      status: 'fail',
      reason: 'policy-mismatch',
      detail: 'route=deny ignores autoApprove — entries can never apply',
    };
  }
  // An always-ask capability in autoApprove can never apply:
  // named as a warning (informational, exit-neutral) and left out of the
  // count, so the line never claims an approval the lane will not grant.
  const ignored = [...new Set(alwaysAskAutoApprove(policy.autoApprove))];
  const effective = policy.autoApprove.filter(
    (cap) => !ignored.includes(cap),
  ).length;
  const summary = `route=${policy.route}, ${effective} auto-approved, maxPendingMs=${policy.maxPendingMs}`;
  if (ignored.length > 0) {
    return {
      ...base,
      status: 'warn',
      reason: 'policy-mismatch',
      detail: `${ignored.join(', ')} always asks — an autoApprove entry never answers it and is ignored; ${summary}`,
    };
  }
  return {
    ...base,
    status: 'pass',
    reason: 'ok',
    detail: summary,
  };
}
