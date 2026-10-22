// The gates the effective policy answers: may this tool run, this provider
// or this model be used.

import type { EffectivePolicy } from './types.js';
import { PolicyDeniedError } from './types.js';
import { normalizeToolName } from './validate.js';

// Deny-by-default: a denied tool is never allowed; an unlisted tool is
// allowed only when an explicit allow list names it. Matching is
// case- and whitespace-insensitive on both sides.
export function isToolAllowed(policy: EffectivePolicy, tool: string): boolean {
  const normalized = normalizeToolName(tool);
  if (
    policy.tools.deny.some((denied) => normalizeToolName(denied) === normalized)
  ) {
    return false;
  }
  if (policy.tools.allow === undefined) return false;
  return policy.tools.allow.some(
    (allowed) => normalizeToolName(allowed) === normalized,
  );
}

// The LANE's enterprise gate: the effective policy can only
// narrow what the lane's classes/roles already allow. It denies a named
// denied tool always, and — when the enterprise layer configured an allow
// list — anything outside it; with NO allow list configured the enterprise
// layer says nothing about the tool and the lane's own allowlist decides.
// (`isToolAllowed` keeps the engine's deny-by-default reading for callers
// that merge an explicit allowlist, like `kubic policy`.)
export function isToolAllowedByEnterprise(
  policy: EffectivePolicy,
  tool: string,
): boolean {
  const normalized = normalizeToolName(tool);
  if (
    policy.tools.deny.some((denied) => normalizeToolName(denied) === normalized)
  ) {
    return false;
  }
  if (policy.tools.allow === undefined) return true;
  return policy.tools.allow.some(
    (allowed) => normalizeToolName(allowed) === normalized,
  );
}

// A denied tool is not re-enableable by project, role, or model: any grant
// path funnels through this gate and the enterprise denial holds. The
// predicate is the LANE's: a deny
// list narrows and an absent allow list says nothing about a tool — the
// engine's deny-by-default reading (`isToolAllowed`) would refuse every role
// under a deny-only policy while the lane gate still admits its tools.
export function assertToolGrantable(
  policy: EffectivePolicy,
  tool: string,
  requester: { layer: string; role?: string; model?: string },
): void {
  if (isToolAllowedByEnterprise(policy, tool)) return;
  const who =
    requester.role !== undefined
      ? `role '${requester.role}'`
      : requester.model !== undefined
        ? `model '${requester.model}'`
        : `layer '${requester.layer}'`;
  throw new PolicyDeniedError(
    `tool '${tool}' denied for ${who}: enterprise denial holds (deny-by-default)`,
  );
}

// `allowed_models` matching: `*` globs inside an id segment
// (or a whole segment), `provider/id`, or a bare id that matches across
// providers. A pattern with a provider segment only matches that provider —
// so `faux/*` can never widen to `other/*`.
function globMatches(pattern: string, value: string): boolean {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replaceAll('*', '.*');
  return new RegExp(`^${escaped}$`).test(value);
}

function patternMatchesProvider(pattern: string, provider: string): boolean {
  const slash = pattern.indexOf('/');
  if (slash === -1) return true;
  return globMatches(pattern.slice(0, slash), provider);
}

function patternMatchesModel(
  pattern: string,
  provider: string,
  id: string,
): boolean {
  const slash = pattern.indexOf('/');
  if (slash === -1) return globMatches(pattern, id);
  return (
    globMatches(pattern.slice(0, slash), provider) &&
    globMatches(pattern.slice(slash + 1), id)
  );
}

// Whether the layer configured a tool gate at all. An absent [policy]
// section (or one that names only models) must not deny every tool by
// accident: the lane gate is only installed when this is true.
export function hasToolPolicy(policy: EffectivePolicy): boolean {
  return policy.tools.allow !== undefined || policy.tools.deny.length > 0;
}

// Same question for models: no allowlist configured means no model gate.
export function hasModelPolicy(policy: EffectivePolicy): boolean {
  return (
    policy.models.providers !== undefined ||
    policy.models.ids !== undefined ||
    policy.models.allowed !== undefined
  );
}

// Deny-by-default for models: an unlisted provider is never allowed; an
// unlisted model id is allowed only when no id allowlist is set.
// `allowed` patterns add provider-qualified matches; every
// configured list applies (intersection), never widens.
export function isProviderAllowed(
  policy: EffectivePolicy,
  provider: string,
): boolean {
  if (
    policy.models.providers !== undefined &&
    !policy.models.providers.includes(provider)
  ) {
    return false;
  }
  if (policy.models.allowed !== undefined) {
    return policy.models.allowed.some((pattern) =>
      patternMatchesProvider(pattern, provider),
    );
  }
  return policy.models.providers !== undefined;
}

export function isModelAllowed(
  policy: EffectivePolicy,
  provider: string,
  id: string,
): boolean {
  if (!isProviderAllowed(policy, provider)) return false;
  if (policy.models.ids !== undefined && !policy.models.ids.includes(id)) {
    return false;
  }
  if (policy.models.allowed !== undefined) {
    return policy.models.allowed.some((pattern) =>
      patternMatchesModel(pattern, provider, id),
    );
  }
  return true;
}

// `[policy] data_policy`: the values Kubic enforces. `redact` scans secrets
// out of everything a session persists and out of raw transcript output;
// `redact-model` also scans tool output before the model reads it. Any other
// value is carried and reported, never enforced.
export type DataProtection = 'redact' | 'redact-model';

export function dataProtectionOf(
  policy: EffectivePolicy | undefined,
): DataProtection | undefined {
  const value = policy?.data.policy;
  return value === 'redact' || value === 'redact-model' ? value : undefined;
}
