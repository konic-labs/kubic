// The steps of a lane boot (boot.ts runs them in order): the tool context
// and the one tool set the conversation offers and the prompt advertises,
// the policy extensions, the session's stored model reconciled with the
// selection, the thinking level, and the tool activation.

import { withReadRoots } from '@kubic/exec/read-roots';
import { ModelSelectError, resolveThinkingLevel } from '../model-select.js';
import { toolsForClasses, validateClasses } from '../permissions.js';
import {
  type Context,
  type Conversation,
  defineExtension,
  type Model,
  type ModelThinkingLevel,
  type Registry,
} from '../pi-boundary.js';
import { createSessionSpillSink } from '../spill.js';
import type { OperationKillRegistry } from './abort.js';
import type { LaneBootOptions } from './boot.js';
import { policyInterceptorHooks } from './interceptors/index.js';
import {
  applyToolPolicy,
  PolicyRefusedError,
  toolsForNames,
} from './policy.js';
import type { KubicToolContext } from './tools-adapter.js';

export function defaultModelId(model: {
  provider: string;
  id: string;
}): string {
  return `${model.provider}/${model.id}`;
}

export function toolContextFor(
  options: LaneBootOptions,
  kills: OperationKillRegistry,
): KubicToolContext {
  return {
    env:
      options.skillReadRoots === undefined
        ? options.env
        : withReadRoots(options.env, options.skillReadRoots),
    sessionId: options.sessionId,
    agentId: options.agentId,
    kills,
    ...(options.journal === undefined ? {} : { journal: options.journal }),
    // The interactive turn supplier rides the tool context so
    // every intercepted write/edit samples the live turn at call time.
    ...(options.currentTurn === undefined
      ? {}
      : { currentTurn: options.currentTurn }),
    // Clipped bash output spills into the session directory, so
    // it is pruned with the session and never lands in the workspace.
    spill: createSessionSpillSink(options.session.dir),
  };
}

export interface LaneToolSet {
  // The class-derived allowlist, when the permission classes are declared.
  readonly classAllowed: readonly string[] | undefined;
  // The one set the conversation offers and the prompt's `tools:` line names.
  readonly names: string[];
  // A role, an explicit selection or the enterprise gate narrowed the set,
  // which then needs its own activation. Without them, applyToolPolicy
  // already installs the class-derived allowlist (and a narrowed set can
  // never exceed it).
  readonly mustActivate: boolean;
}

// Intersection: the tools the
// conversation offers and the tools the prompt advertises are ONE set —
// base tools, narrowed by the permission classes when declared, by the
// role allowlist when declared, and by the enterprise tool policy when
// configured. A role or an enterprise deny can only narrow what the
// classes allow, never widen it. Computed before the prompt is assembled
// so the `tools:` line names exactly what the conversation offers: the
// model must be told the truth about its own tool set, and the
// value is fixed for the boot, so the prompt-cache prefix is still
// byte-stable across turns.
export function laneToolSet(
  options: LaneBootOptions,
  baseNames: readonly string[],
): LaneToolSet {
  const classAllowed =
    options.policy?.classes === undefined
      ? undefined
      : toolsForClasses(validateClasses({ ...options.policy.classes }));
  const enterpriseGate = options.policy?.toolAllowed;
  const registeredNames = new Set(baseNames);
  if (options.toolSelection !== undefined && options.noTools === true) {
    throw new PolicyRefusedError(
      '--tools and --no-tools are mutually exclusive',
    );
  }
  let roleNames: readonly string[] = options.toolAllowlist ?? baseNames;
  if (options.toolSelection !== undefined) {
    const selected = new Set(options.toolSelection);
    roleNames = roleNames.filter((tool) => selected.has(tool));
  }
  if (options.noTools === true) roleNames = [];
  let names =
    classAllowed === undefined
      ? [...roleNames]
      : roleNames.filter((tool) => classAllowed.includes(tool));
  if (enterpriseGate !== undefined) {
    names = names.filter((tool) => enterpriseGate(tool));
  }
  // A name the registry does not offer is not offered to the model either:
  // the prompt line and the configured tool set stay one set even when a
  // role names a tool this build does not carry.
  names = names.filter((tool) => registeredNames.has(tool));
  return {
    classAllowed,
    names,
    mustActivate:
      options.toolAllowlist !== undefined ||
      options.toolSelection !== undefined ||
      options.noTools === true ||
      enterpriseGate !== undefined,
  };
}

// Registry install order = hook order: policy before spans, and the
// Kubic extension (tools + prompt) last, which boot.ts installs once the
// prompt is known. Nothing here is stored; conversations store extension
// names only, so a reopen re-installs them.
export function installPolicyExtensions(
  registry: Registry,
  options: LaneBootOptions,
): void {
  if (options.policy?.interceptors !== undefined) {
    registry.install(
      defineExtension({
        name: 'kubic.policy',
        hooks: policyInterceptorHooks({
          ...options.policy.interceptors,
          ...(options.skillReadRoots === undefined
            ? {}
            : {
                readRoots: [
                  ...(options.policy.interceptors.readRoots ?? []),
                  ...options.skillReadRoots,
                ],
              }),
        }),
      }),
    );
  }
  const spanHooks = options.policy?.spanHooks?.();
  if (spanHooks !== undefined && spanHooks.length > 0) {
    registry.install(
      defineExtension({ name: 'kubic.spans', hooks: [...spanHooks] }),
    );
  }
}

function resolveStoredModel(
  models: LaneBootOptions['models'],
  stored: { provider: string; modelId: string },
): Model<string> {
  const id = `${stored.provider}/${stored.modelId}`;
  const hint = '(pin a model to switch this session)';
  if (models.getProvider(stored.provider) === undefined) {
    throw new ModelSelectError(
      `session model '${id}' is unavailable: provider '${stored.provider}' is not registered ${hint}`,
    );
  }
  const model = models.getModel(stored.provider, stored.modelId);
  if (model === undefined) {
    throw new ModelSelectError(
      `session model '${id}' is unavailable: model '${stored.modelId}' is not registered on provider '${stored.provider}' ${hint}`,
    );
  }
  return model as Model<string>;
}

export interface ModelReconciliation {
  // The model the lane runs: the selection, or the session's stored model.
  readonly model: LaneBootOptions['model'];
  // What the boot tells the user about the choice, when the two differ.
  readonly notice: string | undefined;
}

// Reconcile the stored conversation model with the selection
// BEFORE the extension fixes the system prompt and the reserve. A resumed
// session keeps its own model unless the selection is an explicit pin or the
// enterprise policy refuses the stored one.
export function reconcileStoredModel(
  options: LaneBootOptions,
  stored: { provider: string; modelId: string } | undefined,
): ModelReconciliation {
  const selectedId = defaultModelId(options.model);
  const storedId =
    stored === undefined
      ? undefined
      : defaultModelId({ provider: stored.provider, id: stored.modelId });
  const storedRefused =
    stored !== undefined &&
    options.policy?.modelAllowed?.(stored.provider, stored.modelId) === false;
  const keep =
    stored !== undefined &&
    storedId !== selectedId &&
    options.modelPolicy !== 'selected' &&
    !storedRefused
      ? stored
      : undefined;
  const differs = storedId !== undefined && storedId !== selectedId;
  const model =
    keep === undefined
      ? options.model
      : resolveStoredModel(options.models, keep);
  if (differs && keep === undefined) {
    // An explicit selection is an explicit model change: applied
    // to the restored conversation (and persisted) and announced.
    return {
      model,
      notice: `model: session model '${storedId}' switched to '${selectedId}' (${
        storedRefused && options.modelPolicy !== 'selected'
          ? 'enterprise policy'
          : 'explicit selection'
      })`,
    };
  }
  return {
    model,
    notice: differs
      ? `model: session keeps its own model '${storedId}' (selected default '${selectedId}' not applied; pin a model to switch)`
      : undefined,
  };
}

// Resolve the thinking request against the session's
// stored level and clamp it to the EFFECTIVE model (the reconciliation may
// keep the session's own model, so clamping to the selection would
// answer for the wrong model). A clamp is never silent.
export function laneThinkingLevel(
  options: LaneBootOptions,
  model: LaneBootOptions['model'],
  persisted: ModelThinkingLevel | null | undefined,
): ReturnType<typeof resolveThinkingLevel> {
  const resolved = resolveThinkingLevel(model, {
    ...(options.thinking === undefined ? {} : options.thinking),
    // The explicit level is the same level as `override`, and wins over
    // it: one variable, two spellings, no silent double application.
    ...(options.thinkingLevel === undefined
      ? {}
      : {
          override: {
            level: options.thinkingLevel,
            source: 'override',
          },
        }),
    persisted: persisted ?? null,
  });
  if (resolved.notice !== undefined) {
    (options.onThinkingNotice ?? options.onModelNotice)?.(resolved.notice);
  }
  return resolved;
}

// The offered tools: the class policy first, then the narrowing.
export async function activateLaneTools(
  registry: Registry,
  conversation: Conversation,
  options: LaneBootOptions,
  tools: LaneToolSet,
  storedTools: unknown,
  context: Context,
): Promise<void> {
  if (options.policy?.classes !== undefined) {
    await applyToolPolicy(
      registry,
      conversation,
      options.policy.classes,
      context,
    );
  }
  // Role narrowing: the role's resolved tool set is the
  // NARROWER of the two allowlists — applied after the class-derived one,
  // so a role can never widen what the permission classes permit. An empty
  // set is the noTools case (the conversation offers nothing). A tool outside
  // the role's set is absent from the offer; offer-time absence is what this
  // pins.
  if (tools.mustActivate) {
    await conversation.configure(
      { tools: toolsForNames(registry, tools.names) },
      context,
    );
  } else if (tools.classAllowed === undefined && storedTools !== undefined) {
    // The stored filter is durable (configure writes it), so a session booted
    // with a role/enterprise narrowing would otherwise keep it while this
    // boot's prompt advertises the full intersection. Clearing it makes the
    // offered set total on every boot; the prompt's `tools:` line is the same
    // set by construction.
    await conversation.configure({ tools: null }, context);
  }
}
