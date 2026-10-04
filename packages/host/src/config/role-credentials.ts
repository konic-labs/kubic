// §36.3 provider-credential scoping for orchestrator workers (issue #200).
//
// Each orchestrator subagent is a `kubic run` child that starts from the
// §3.8 allowlist — which carries no provider key of its own. This module
// answers the two questions the launch path must not guess:
//
//   1. which PROVIDER does this worker's role resolve to, and
//   2. exactly which of the operator's key env vars does that provider need?
//
// A worker is granted only those names' values, delivered through the
// KUBIC_ROLE_<role>_* grant namespace (`packages/worker/src/lifecycle/env.ts`
// mints them; the child reads them back as the provider's apiKey auth). A
// sibling role's provider key is never forwarded, and an unrelated parent
// secret (AWS_*, GITHUB_TOKEN, …) never is — it is not a provider key. With
// §58 `require_credential_broker` the values are replaced by `broker:<ref>`
// sentinels, so no secret material reaches the child env at all.
//
// Pure and injected: the provider key index comes from the composed models
// assembly (`assembleModels`), the env from the caller. Nothing here reads
// process.env, spawns anything, or logs a value.

import { buildBrokeredWorkerEnv } from '../policy/enterprise.js';

/** How one provider's key reaches the process. */
export interface ProviderKeyEnv {
  /**
   * The env var names whose values authenticate this provider. Empty when
   * nothing needs forwarding: a keyless custom provider (`apiKey` literal)
   * or a built-in the manager authenticated through an ambient credential
   * file.
   */
  readonly envVars: readonly string[];
  /**
   * True when the provider needs no forwarded key AT ALL. False with an
   * empty `envVars` means the provider has no usable credential configured
   * in this environment — a registration, not a deliverable key.
   */
  readonly noKeyNeeded: boolean;
  /**
   * Set when the provider authenticates from process-level configuration (a
   * region, a profile, several vars read straight from `process.env`) that
   * the grant namespace cannot carry into a worker: the reason, naming what
   * is missing. A worker pinned to it is refused before any worktree exists
   * instead of passing the preflight and dying `Provider is not configured`.
   */
  readonly undeliverable?: string;
}

/** provider id → how its key reaches the process. */
export type ProviderKeyIndex = ReadonlyMap<string, ProviderKeyEnv>;

/** A read-only environment view (never process.env directly in tests). */
export type EnvLookup = Readonly<Record<string, string | undefined>>;

// The provider a `provider/model` pin names. A ref without a usable
// provider/id split names no provider — never a guessed one.
export function providerOfModelRef(
  ref: string | undefined,
): string | undefined {
  if (ref === undefined) return undefined;
  const slash = ref.indexOf('/');
  if (slash <= 0 || slash === ref.length - 1) return undefined;
  return ref.slice(0, slash);
}

// The provider the worker child will actually select, mirroring the launch
// contract the orchestrate path pins (issue #202): the value the child is
// TOLD as `KUBIC_MODEL` wins — the role's `[roles.<r>].model` pin, the
// explicit per-agent pin, or the manager's model inherited as the fallback
// level — then the operator's ambient `KUBIC_MODEL` (the child inherits it
// only when no resolved pin overwrote it), then the manager's configured
// pin, then the provider the child falls back to when nothing is pinned at
// all. Model resolution itself is issue #202's concern; the credential plan
// follows the value the caller resolved for the role, never a hardcoded role
// default — and never an ambient pin the child does not run.
export interface WorkerProviderResolution {
  /** KUBIC_MODEL from the orchestrator's environment, when set. */
  readonly envModel?: string;
  /** The manager's effective `[model]` / KUBIC_MODEL pin, when set. */
  readonly managerModel?: string;
  /** First usable provider of the manager's catalog (the child's fallback). */
  readonly fallbackProvider?: string;
  /**
   * A frozen enterprise `[model]` (issue #295; §35.1) is in force: every
   * worker child's own config load drops `KUBIC_MODEL` — the operator's and
   * the role default the manager would inject — in favour of the enterprise
   * pin, which is `managerModel`. Only that pin (then the fallback) decides
   * the provider; resolving from a pin the child never runs would check, or
   * refuse on, the wrong provider's credential.
   */
  readonly modelFrozen?: boolean;
}

export function resolveWorkerProvider(
  input: WorkerProviderResolution & { readonly modelRef?: string },
): string | undefined {
  if (input.modelFrozen === true) {
    return providerOfModelRef(input.managerModel) ?? input.fallbackProvider;
  }
  return (
    providerOfModelRef(input.modelRef) ??
    providerOfModelRef(input.envModel) ??
    providerOfModelRef(input.managerModel) ??
    input.fallbackProvider
  );
}

export type ProviderGrantResult =
  | { readonly kind: 'grant'; readonly grant: Record<string, string> }
  | {
      readonly kind: 'refusal';
      readonly provider: string;
      readonly message: string;
    };

export interface ProviderGrantDeps {
  readonly keyEnv: ProviderKeyIndex;
  readonly env: EnvLookup;
  /** §58 require_credential_broker: sentinels, never live material. */
  readonly requireCredentialBroker?: boolean;
}

// The grant for ONE already-resolved provider. An id the manager does not
// know at all is not a credential failure: there is no key to deliver, and
// the child's own provider probe names it (its exit is provider-bound
// either way). A registered provider with no usable credential IS one.
export function resolveProviderGrant(
  provider: string | undefined,
  deps: ProviderGrantDeps,
): ProviderGrantResult {
  if (provider === undefined) return { kind: 'grant', grant: {} };
  const keyEnv = deps.keyEnv.get(provider);
  if (keyEnv === undefined) return { kind: 'grant', grant: {} };
  if (keyEnv.undeliverable !== undefined) {
    return {
      kind: 'refusal',
      provider,
      message: `no credential for provider '${provider}': ${keyEnv.undeliverable}`,
    };
  }
  if (keyEnv.noKeyNeeded) return { kind: 'grant', grant: {} };
  if (keyEnv.envVars.length === 0) {
    return {
      kind: 'refusal',
      provider,
      message: `no credential for provider '${provider}': it has no configured key in the orchestrator's environment`,
    };
  }
  const missing = keyEnv.envVars.filter(
    (name) => (deps.env[name] ?? '') === '',
  );
  if (missing.length > 0) {
    return {
      kind: 'refusal',
      provider,
      message: `no credential for provider '${provider}': ${missing.map((name) => `$${name}`).join(', ')} not set in the orchestrator's environment`,
    };
  }
  const grant: Record<string, string> = {};
  for (const name of keyEnv.envVars) grant[name] = deps.env[name] as string;
  if (deps.requireCredentialBroker !== true) {
    return { kind: 'grant', grant };
  }
  // The §58 broker: every live value becomes a `broker:<ref>` sentinel that
  // names the ref without carrying material. The shape backstop inside
  // buildBrokeredWorkerEnv refuses a value that slipped through unreplaced.
  const brokered = buildBrokeredWorkerEnv(
    grant,
    keyEnv.envVars.map((name) => ({
      ref: `$${name}`,
      value: grant[name] as string,
    })),
    { credentials: { requireCredentialBroker: true } },
  );
  return { kind: 'grant', grant: brokered.env };
}

// The first fallback candidate whose credential this host can deliver. The
// child's implicit pick is only GUESSED from this list, so an undeliverable
// candidate is skipped, never turned into a pre-run refusal — the child's own
// provider probe names the provider it really picked. `undefined` when none
// qualifies (nothing to deliver, no refusal).
export function firstDeliverableProvider(
  providers: readonly string[],
  deps: ProviderGrantDeps,
): string | undefined {
  return providers.find(
    (provider) => resolveProviderGrant(provider, deps).kind === 'grant',
  );
}

export interface WorkerCredentialRequest {
  readonly agentId: string;
  readonly role: string;
  /** The role's resolved `provider/model` pin, when the plan carries one. */
  readonly modelRef?: string;
}

export interface WorkerCredentialGrant {
  readonly agentId: string;
  readonly role: string;
  readonly provider: string | undefined;
  /** env-var name → value, exactly the child's need. Never logged. */
  readonly grant: Record<string, string>;
}

export interface WorkerCredentialRefusal {
  readonly agentId: string;
  readonly role: string;
  readonly provider: string | undefined;
  readonly message: string;
}

export interface WorkerCredentialPlan {
  /** One grant per request (an empty grant when nothing needs delivering). */
  readonly grants: ReadonlyMap<string, WorkerCredentialGrant>;
  /** The FIRST undeliverable credential, in request order. */
  readonly refusal: WorkerCredentialRefusal | undefined;
}

export interface WorkerCredentialPlanDeps extends ProviderGrantDeps {
  readonly resolution: WorkerProviderResolution;
}

// The run-wide plan the preflight and every launch share: one resolution per
// role, computed once, so what the preflight approves is exactly what the
// launch delivers.
export function planWorkerCredentials(
  requests: readonly WorkerCredentialRequest[],
  deps: WorkerCredentialPlanDeps,
): WorkerCredentialPlan {
  const grants = new Map<string, WorkerCredentialGrant>();
  let refusal: WorkerCredentialRefusal | undefined;
  for (const request of requests) {
    const provider = resolveWorkerProvider({
      ...deps.resolution,
      ...(request.modelRef === undefined ? {} : { modelRef: request.modelRef }),
    });
    const resolved = resolveProviderGrant(provider, deps);
    if (resolved.kind === 'refusal') {
      refusal ??= {
        agentId: request.agentId,
        role: request.role,
        provider: resolved.provider,
        message: resolved.message,
      };
      continue;
    }
    grants.set(request.agentId, {
      agentId: request.agentId,
      role: request.role,
      provider,
      grant: resolved.grant,
    });
  }
  return { grants, refusal };
}

export interface DoctorCredentialProbe {
  readonly ok: boolean;
  readonly detail: string;
}

// `kubic doctor`'s credential line: which provider each role's workers get
// credentials for — provider NAMES only, never a key name or value. A role
// whose credential cannot be delivered fails the check by provider name, the
// same refusal the orchestrate preflight acts on.
export function workerCredentialDoctorProbe(
  requests: readonly WorkerCredentialRequest[],
  deps: WorkerCredentialPlanDeps,
): DoctorCredentialProbe {
  const plan = planWorkerCredentials(requests, deps);
  if (plan.refusal !== undefined) {
    return { ok: false, detail: plan.refusal.message };
  }
  if (requests.length === 0) {
    return {
      ok: true,
      detail: `no roles assigned; workers resolve ${deps.resolution.fallbackProvider ?? 'no provider'}`,
    };
  }
  // One entry per DISTINCT role→provider pair: two workers of the same role
  // resolve the same provider, and the line names what each role gets
  // (issue #178 — the default delegation set is now two implementers).
  const parts = [
    ...new Set(
      requests.map((request) => {
        const grant = plan.grants.get(request.agentId);
        return `${request.role}→${grant?.provider ?? 'no provider'}`;
      }),
    ),
  ];
  return { ok: true, detail: parts.join(', ') };
}
