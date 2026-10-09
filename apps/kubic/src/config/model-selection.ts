// Model selection under the loaded configuration: the runtime pin and
// whether enterprise froze it, the role's model scope and thinking default,
// and the gate every selection passes (enterprise policy, role scope,
// catalog) before any provider is called.

import type { ModelSelection } from '@kubic/agent/model-select';
import { ModelSelectError, selectModel } from '@kubic/agent/model-select';
import type { MutableModels } from '@kubic/agent/pi-boundary';
import type {
  RoleModelEntry,
  RuntimeConfig,
  RuntimeEscalation,
} from '@kubic/host/config';
import { FAUX_MODEL_ID, FAUX_PROVIDER_ID } from '@kubic/host/models';
import type { EffectivePolicy } from '@kubic/host/policy';
import {
  hasModelPolicy,
  isModelAllowed,
  isProviderAllowed,
} from '@kubic/host/policy';
import { roleModelAllowed, roleModelEntry } from '@kubic/host/roles';
import {
  roleModelSelection,
  selectionOrigin,
  withSelectionOrigin,
} from '../model-projection.js';
import type { CliConfigResult } from './load.js';

// Provider/model selection for `kubic run`: the configured pin when one is
// set, otherwise undefined (first-registered provider, the existing
// behaviour). Validated against the live catalog by the lane's own
// selectModel, which fails the run by name on an unknown provider/model.
export function runtimeModelPin(
  result: CliConfigResult,
): ModelSelection | undefined {
  const runtime = result.runtime;
  const selection = runtime?.model;
  if (runtime === undefined || selection === undefined) return undefined;
  // The pin carries the input it came from, so a refusal of an
  // unknown model says `KUBIC_MODEL`/`--model`/the config layer — not `--model`
  // for every explicit selection.
  return withSelectionOrigin(
    { provider: selection.provider, id: selection.id },
    modelPinOrigin(runtime),
  );
}

// The label the named model refusal shows for the runtime pin: the flag, the
// env variable, or the config layer whose `[model]` carried it.
function modelPinOrigin(runtime: RuntimeConfig): string {
  switch (runtime.modelSource) {
    case 'cli':
      return '--model';
    case 'env':
      return 'KUBIC_MODEL';
    default:
      return `[model] in ${runtime.modelSource} config`;
  }
}

// Whether a frozen enterprise `[model]` is the effective pin: every cli/env pin
// is dropped — so the consumers that reason about which model runs (the TUI
// `/model` switch) follow the pin, never a raw KUBIC_MODEL.
export function runtimeModelFrozen(result: CliConfigResult): boolean {
  return result.runtime?.modelSource === 'enterprise';
}

// One stderr line per cli/env model pin a frozen enterprise `[model]`
// overrode — the composition root prints them once at the
// boot of run/tui, so `kubic run --model x` against an enterprise
// pin says it ran the pin instead of dropping `x` silently. Empty when
// nothing was overridden (no freeze, no cli/env pin, or the same pin).
export function runtimeModelPinNotes(result: CliConfigResult): string[] {
  return (result.runtime?.modelPinOverrides ?? []).map((entry) => {
    const input =
      entry.source === 'cli'
        ? `--model ${entry.requested}`
        : `KUBIC_MODEL=${entry.requested}`;
    return `note: ${input} ignored: model pinned by enterprise policy (${entry.pinned})`;
  });
}

// Enterprise policy: the EffectivePolicy resolved once at
// load — `kubic run` and `kubic tui` gate role grants, model selection and
// the lane tool set with it. Undefined when the config was refused: the
// agent-executing commands fail closed on their own before this matters, and
// an absent [policy] section leaves the object empty (hasModelPolicy /
// hasToolPolicy decide whether any gate applies).
export function runtimePolicy(
  result: CliConfigResult,
): EffectivePolicy | undefined {
  return result.runtime?.policy;
}

// selectModel words every explicit pin `(--model)` and every config default
// `(config default)`; when the selection carries its real origin
// (model-projection's withSelectionOrigin) the suffix names that instead. Only
// the pick that was actually attempted can have failed: an explicit pin is
// tried first and alone.
function relabelRefusal(
  error: ModelSelectError,
  explicit: ModelSelection | undefined,
  configDefault: ModelSelection | undefined,
): ModelSelectError {
  const attempted =
    explicit !== undefined
      ? { selection: explicit, wording: '--model' }
      : configDefault !== undefined
        ? { selection: configDefault, wording: 'config default' }
        : undefined;
  if (attempted === undefined) return error;
  const origin = selectionOrigin(attempted.selection);
  const suffix = ` (${attempted.wording})`;
  if (origin === undefined || !error.message.endsWith(suffix)) return error;
  return new ModelSelectError(
    `${error.message.slice(0, -suffix.length)} (${origin})`,
  );
}

// The named refusal both entry points share: one text, so
// the headless terminus and the TUI's exit-6 report cannot drift apart.
function modelPolicyRefusal(provider: string, id: string): string {
  return `model '${provider}/${id}' refused by enterprise policy (allowed_models/allowed_providers): no provider call was made`;
}

// Model selection under the enterprise gate, shared by
// `kubic run` and `kubic tui`: an explicit/role/config selection outside
// `allowed_models`/`allowed_providers` is refused with a named
// ModelSelectError BEFORE the registry is probed or any provider is called,
// and the implicit fallback pick only considers allowed providers. With no
// model policy configured this is exactly `selectModel` — the selection
// behaviour is byte-identical to before.
// The role's allowed set as a selection gate: the
// resolved role's name plus its set. Built once per boot/switch from
// the resolved role; undefined (or an empty set) means unconstrained.
export interface RoleModelScope {
  role: string;
  models: RoleModelEntry[] | undefined;
}

export function roleModelScope(
  resolved: { name: string; models: RoleModelEntry[] | undefined } | undefined,
): RoleModelScope | undefined {
  if (
    resolved === undefined ||
    resolved.models === undefined ||
    resolved.models.length === 0
  ) {
    return undefined;
  }
  return { role: resolved.name, models: resolved.models };
}

// The out-of-set refusal: names the requested model, the
// role, and the set — the operator pins an allowed model or widens the
// set, never guesses which boundary fired.
function roleModelRefusal(
  role: string,
  provider: string,
  id: string,
  models: readonly RoleModelEntry[],
): string {
  const entries = models.map((entry) => entry.id).join(', ');
  return `model '${provider}/${id}' refused: role '${role}' allows ${entries} only`;
}

// The role's thinking default for the SELECTED model: a matching set entry's
// thinking wins over the flat role default (specific beats general — otherwise
// per-entry thinking would be dead config whenever the flat default is set);
// without a matching entry the flat default stands, and without either there is
// none.
export function resolveRoleThinking(
  resolved:
    | {
        thinking: string | undefined;
        models: readonly RoleModelEntry[] | undefined;
      }
    | undefined,
  provider: string,
  id: string,
): string | undefined {
  if (resolved === undefined) return undefined;
  return (
    roleModelEntry(resolved.models, provider, id)?.thinking ?? resolved.thinking
  );
}

// The boot's model pick, one rule for every boot: a faux pin is the explicit
// selection and otherwise the runtime pin is; the role default and the
// fallbacks follow, under the same policy gate and role scope.
export function selectBootModel(input: {
  models: MutableModels;
  fauxPinned: boolean;
  pin: ModelSelection | undefined;
  roleModel: string | undefined;
  fallbackProviders: readonly string[] | undefined;
  policy: EffectivePolicy | undefined;
  roleScope?: RoleModelScope;
}): ReturnType<typeof selectModel> {
  return selectModelUnderPolicy(
    input.models,
    input.fauxPinned
      ? { provider: FAUX_PROVIDER_ID, id: FAUX_MODEL_ID }
      : input.pin,
    roleModelSelection(input.roleModel),
    input.fallbackProviders,
    input.policy,
    input.roleScope,
  );
}

export function selectModelUnderPolicy(
  models: MutableModels,
  explicit: ModelSelection | undefined,
  configDefault: ModelSelection | undefined,
  fallbackProviders: readonly string[] | undefined,
  policy: EffectivePolicy | undefined,
  // The role's allowed set: gates the explicit/role
  // selection AND the final pick, exactly like the enterprise gate above
  // — a run that would boot (or switch) outside its role's set refuses
  // by name instead of silently running out-of-set.
  roleScope?: RoleModelScope,
): ReturnType<typeof selectModel> {
  const gate =
    policy !== undefined && hasModelPolicy(policy) ? policy : undefined;
  if (gate !== undefined) {
    for (const selection of [explicit, configDefault]) {
      if (
        selection !== undefined &&
        !isModelAllowed(gate, selection.provider, selection.id)
      ) {
        throw new ModelSelectError(
          modelPolicyRefusal(selection.provider, selection.id),
        );
      }
    }
  }
  const scopeModels = roleScope?.models;
  const scope =
    roleScope === undefined ||
    scopeModels === undefined ||
    scopeModels.length === 0
      ? undefined
      : { role: roleScope.role, models: scopeModels };
  if (scope !== undefined) {
    for (const selection of [explicit, configDefault]) {
      if (
        selection !== undefined &&
        !roleModelAllowed(scope.models, selection.provider, selection.id)
      ) {
        throw new ModelSelectError(
          roleModelRefusal(
            scope.role,
            selection.provider,
            selection.id,
            scope.models,
          ),
        );
      }
    }
  }
  const candidates =
    gate === undefined
      ? fallbackProviders
      : (
          fallbackProviders ??
          models.getProviders().map((provider) => provider.id)
        ).filter((provider) => isProviderAllowed(gate, provider));
  let picked: ReturnType<typeof selectModel>;
  try {
    picked = selectModel(models, explicit, configDefault, candidates);
  } catch (error) {
    throw error instanceof ModelSelectError
      ? relabelRefusal(error, explicit, configDefault)
      : error;
  }
  if (gate !== undefined && !isModelAllowed(gate, picked.provider, picked.id)) {
    throw new ModelSelectError(modelPolicyRefusal(picked.provider, picked.id));
  }
  if (
    scope !== undefined &&
    !roleModelAllowed(scope.models, picked.provider, picked.id)
  ) {
    throw new ModelSelectError(
      roleModelRefusal(scope.role, picked.provider, picked.id, scope.models),
    );
  }
  return picked;
}

// The lane's escalation ladder: the role's own rungs
// win outright when the role names any — even [] (the role opts out of
// climbing) — and the `[model]` bound still caps the role's climbs. No
// rungs anywhere means no ladder: escalation stays opt-in.
export function resolveLaneLadder(
  model: RuntimeEscalation | undefined,
  role: readonly string[] | undefined,
): RuntimeEscalation | undefined {
  if (role !== undefined) {
    return {
      steps: [...role],
      maxEscalations: model?.maxEscalations ?? role.length,
    };
  }
  if (model === undefined) return undefined;
  return { steps: [...model.steps], maxEscalations: model.maxEscalations };
}
