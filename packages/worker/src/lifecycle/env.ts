// Spawn env allowlist §3.8 + role-scoped creds §36.3 (issue #42).
// Pure: the child sees exactly the allowlisted base plus its own role
// grant — never the parent's secrets, never a sibling role's token.
// Debug lines go through redactEnvForLog so secrets never hit §50 output.

import { redactSecretEnv } from '../../../core/src/secret-keys.js';

export const ENV_ALLOWLIST: readonly string[] = [
  'PATH',
  'HOME',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'TERM',
  'TZ',
  'CI',
  'NO_COLOR',
  'CLICOLOR',
  'KUBIC_MODEL',
  // The faux testing provider switch (`KUBIC_PROVIDER=faux`): a worker of a
  // faux orchestration must answer from the same scripted provider as its
  // manager, never fall through to a real one. Not a secret.
  'KUBIC_PROVIDER',
  'KUBIC_DEBUG',
  // The worker's own identity (issue #94): the child prints its readiness
  // marker under this id and the orchestrator matches it, so the id is
  // part of the child's world — never the parent's whole environment.
  'KUBIC_WORKER_ID',
  // Per-worker approvals (issue #105): the orchestration run tells its child
  // where the ask mailbox is and which orchestrator session it belongs to, so
  // a challenged call the child cannot answer reaches the USER through the
  // manager instead of dying at a missing surface. Both are non-secret
  // locations/identifiers — the same class as KUBIC_WORKER_ID.
  'KUBIC_APPROVALS_DIR',
  'KUBIC_ORCHESTRATOR_SESSION',
  // models.json lookup for workers (issue #222): the manager's project root
  // (the worktree holds only tracked files, so an untracked models.json is
  // not in it) and the operator's project-trust decision, which gates that
  // file in the child exactly as it did in the manager. A location and a
  // flag — neither is a secret.
  'KUBIC_MODELS_ROOT',
  'KUBIC_TRUST_PROJECT',
  // The child's approval bound (issue #230): derived from the manager's
  // config maxPendingMs and kept below it. A number, not a secret.
  'KUBIC_APPROVALS_BOUND_MS',
];

const KUBIC_PREFIX = 'KUBIC_';

export function filterSpawnEnv(
  base: Record<string, string>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(base)) {
    if ((ENV_ALLOWLIST as readonly string[]).includes(key)) {
      out[key] = value;
    }
  }
  return out;
}

// Namespaces a role grant under KUBIC_ROLE_<ROLE>_. The `role` value
// is trusted as-is: this function mints whatever sibling-prefixed
// namespace the caller names and performs NO authorization. The
// orchestrator MUST authorize the role value at the composition root
// (when that wiring lands) — only a role the session is entitled to
// may reach this function, or a caller could mint a sibling role's
// namespace.
export function roleCredentialEnv(
  role: string,
  grant: Record<string, string>,
): Record<string, string> {
  const prefix = `KUBIC_ROLE_${role.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}_`;
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(grant)) {
    if (key.toUpperCase().startsWith(KUBIC_PREFIX)) {
      throw new Error(
        `refusing KUBIC_-prefixed grant key for role ${role}: ${key}`,
      );
    }
    const name = key.toUpperCase().replace(/[^A-Z0-9]+/g, '_');
    out[`${prefix}${name}`] = value;
  }
  return out;
}

export function buildSpawnEnv(
  base: Record<string, string>,
  role: string,
  grant: Record<string, string>,
): Record<string, string> {
  return { ...filterSpawnEnv(base), ...roleCredentialEnv(role, grant) };
}

// The shared classifier (core/secret-keys.ts, issue #359): the trajectory
// exporter redacts with the very same rule.
export function redactEnvForLog(
  env: Record<string, string>,
): Record<string, string> {
  return redactSecretEnv(env);
}
