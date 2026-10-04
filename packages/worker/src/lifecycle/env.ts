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
  // The generation the lifecycle registered this child under (issue #383):
  // the child's §46 trajectory records it as provenance.generation. A
  // counter, not a secret.
  'KUBIC_WORKER_GENERATION',
  // Per-worker approvals (issue #105): the orchestration run tells its child
  // where the ask mailbox is and which orchestrator session it belongs to, so
  // a challenged call the child cannot answer reaches the USER through the
  // manager instead of dying at a missing surface. Both are non-secret
  // locations/identifiers — the same class as KUBIC_WORKER_ID.
  'KUBIC_APPROVALS_DIR',
  'KUBIC_ORCHESTRATOR_SESSION',
  // The worker's OWN session id (issue #159; §23): `<orch>-<agent>`, what its
  // approval ask is bound to. It travels beside KUBIC_ORCHESTRATOR_SESSION (the
  // run that spawned it) so a worker's decision can be attributed to the run
  // — the two were conflated before, which made the §60 audit row unusable.
  // An identifier, never a secret, like the two above.
  'KUBIC_WORKER_SESSION',
  // The manager's approval VERIFICATION key (issue #149): the child refuses
  // any answer in the mailbox without a matching MAC, so a worker that writes
  // its own `{"approved":true}` changes nothing. A public key grants no
  // signing power, so allowlisting it hands the worker nothing it could use —
  // the private half never leaves the manager process.
  'KUBIC_APPROVALS_VERIFY_KEY',
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
  // The documented runtime env overrides (issue #201; RUNTIME_ENV_OVERRIDES
  // in host/config/runtime.ts). The child loads its own config from its
  // worktree, so an override the manager resolved — approval route, thinking
  // level, journal retention — must reach it too, or the worker runs a
  // different policy than the manager reports. Non-secret values; a frozen
  // enterprise key still wins inside the child's own load.
  'KUBIC_MODEL_THINKING',
  'KUBIC_APPROVALS_ROUTE',
  'KUBIC_JOURNAL_RETENTION_DAYS',
  // Per-spawn budget (issue #208, §71): the orchestration run hands its child
  // the resolved spec (JSON) so the child's own lane enforces maxToolCalls /
  // maxTokens / maxCostUsd — non-secret limits, the same class as the
  // locations above. maxRuntimeMs never travels here (host watchdog).
  'KUBIC_BUDGET',
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

function grantPrefix(role: string): string {
  return `KUBIC_ROLE_${role.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}_`;
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
  const prefix = grantPrefix(role);
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

// The child-side read of its own role grant (issue #200): the inverse of
// roleCredentialEnv for the ONE role this process was launched as. The
// grant becomes visible under the provider-key names the models layer asks
// for; a sibling role's prefix never matches, so a grant the host minted
// for another role stays invisible even if it somehow reached this env.
export function roleGrantEnv(
  role: string,
  env: Readonly<Record<string, string>>,
): Record<string, string> {
  const prefix = grantPrefix(role);
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (!key.startsWith(prefix)) continue;
    const name = key.slice(prefix.length);
    if (name === '') continue;
    out[name] = value;
  }
  return out;
}

// The env view the models assembly reads: the process env exactly as the
// child got it, with this role's grant exposed under the plain names a
// provider's `apiKeyEnv` (or a built-in's own auth) looks up. The plain
// names exist only in the returned view — never in the child's own
// process env, and never written anywhere.
export function withRoleGrant(
  env: Readonly<Record<string, string>>,
  role: string,
): Record<string, string> {
  return { ...env, ...roleGrantEnv(role, env) };
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
