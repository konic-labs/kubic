// Model selection, one-way escalation, thinking clamp.
//
// Selection chain: explicit CLI selection (--model provider/id) beats the
// recorded config default, which beats first-available. Escalation climbs
// a caller-supplied ladder only (one-way: never down, never sideways off
// the ladder), every step recorded with reason, total steps bounded.
// Thinking levels clamp to what the model supports (Pi owns the map);
// the level itself persists as durable agent state through `configure()`
// + `pi.agent`, never a sidecar — attach restores it from
// the storage.

import { suggest } from '@kubic/core/suggest';
import { isThinkingLevel, THINKING_LEVELS } from './models-config/index.js';
import {
  clampThinkingLevel,
  getSupportedThinkingLevels,
  type Model,
  type ModelThinkingLevel,
  type MutableModels,
} from './pi-boundary.js';

export class ModelSelectError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ModelSelectError';
  }
}

// No model at all — no provider has a key and no explicit or
// configured model was named. The TUI answers it with the first screen's
// no-key block instead of a bare error line.
export class NoModelAvailableError extends ModelSelectError {
  constructor(message: string) {
    super(message);
    this.name = 'NoModelAvailableError';
  }
}

export interface ModelSelection {
  provider: string;
  id: string;
}

export type AnyModel = Model<string>;

export function selectModel(
  models: MutableModels,
  explicit?: ModelSelection,
  configDefault?: ModelSelection,
  // The providers the implicit first-available pick may use,
  // in preference order. The assembly lists models.json customs first and
  // leaves out every built-in whose auth is not configured, so a keyless
  // built-in is never selected silently. Omitted: every registered
  // provider, in registration order.
  fallbackProviders?: readonly string[],
): AnyModel {
  const pick = (sel: ModelSelection, origin: string): AnyModel => {
    const provider = models.getProvider(sel.provider);
    if (provider === undefined) {
      // Name the closest registered provider, if any.
      const [close] = suggest(
        sel.provider,
        models.getProviders().map((candidate) => candidate.id),
      );
      throw new ModelSelectError(
        `unknown provider '${sel.provider}' (${origin})${close === undefined ? '' : `; did you mean '${close}'?`}`,
      );
    }
    const model = models.getModel(sel.provider, sel.id);
    if (model === undefined) {
      const [close] = suggest(
        sel.id,
        models.getModels(sel.provider).map((candidate) => candidate.id),
      );
      throw new ModelSelectError(
        `unknown model '${sel.id}' on provider '${sel.provider}' (${origin})${close === undefined ? '' : `; did you mean '${close}'?`}`,
      );
    }
    return model as AnyModel;
  };
  if (explicit !== undefined) return pick(explicit, '--model');
  if (configDefault !== undefined) return pick(configDefault, 'config default');
  const candidates =
    fallbackProviders ?? models.getProviders().map((provider) => provider.id);
  for (const providerId of candidates) {
    const first = models.getModels(providerId)[0];
    if (first !== undefined) return first as AnyModel;
  }
  throw new NoModelAvailableError(
    fallbackProviders === undefined
      ? 'no models available: register a provider first'
      : "no models available: register a provider first (set a built-in provider's env key, e.g. ANTHROPIC_API_KEY, or add models.json)",
  );
}

// The `--thinking <level>` value rule: the level vocabulary is
// the shared one, so `--thinking banana` is refused by name with the levels
// that exist — the same wording `/thinking` uses (apps/kubic/src/tui/commands/parse.ts).
export function parseThinkingFlag(flag: string): ModelThinkingLevel {
  if (!isThinkingLevel(flag)) {
    throw new ModelSelectError(
      `unknown thinking level '${flag}' (levels: ${THINKING_LEVELS.join(', ')})`,
    );
  }
  return flag;
}

export function parseModelFlag(flag: string): ModelSelection {
  const slash = flag.indexOf('/');
  if (slash <= 0 || slash === flag.length - 1) {
    throw new ModelSelectError(
      `--model must be 'provider/id' (got ${JSON.stringify(flag)})`,
    );
  }
  return { provider: flag.slice(0, slash), id: flag.slice(slash + 1) };
}

interface EscalationRecord {
  from: string;
  to: string;
  reason: string;
  at: number;
}

export interface EscalationLadder {
  steps: string[];
  maxEscalations: number;
  record: EscalationRecord[];
}

class EscalationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EscalationError';
  }
}

export function escalateModel(
  ladder: EscalationLadder,
  from: string,
  to: string,
  reason: string,
): { to: string } {
  validateEscalation(ladder, from, to);
  ladder.record.push({ from, to, reason, at: Date.now() });
  return { to };
}

// Side-effect-free pre-check for escalateModel: throws the same errors
// without consuming escalation budget. The lane validates with this
// BEFORE touching the live lane, applies the model switch, and only then
// records via escalateModel — so a refused or failed switch never burns
// budget. (No-op from==to steps pass here; the lane rejects those
// explicitly so a redundant event is never recorded.)
export function validateEscalation(
  ladder: EscalationLadder,
  from: string,
  to: string,
): void {
  if (ladder.record.length >= ladder.maxEscalations) {
    throw new EscalationError(
      `escalation bounded: ${ladder.record.length} steps already (max ${ladder.maxEscalations})`,
    );
  }
  const fromAt = ladder.steps.indexOf(from);
  const toAt = ladder.steps.indexOf(to);
  if (fromAt === -1 || toAt === -1) {
    throw new EscalationError(
      `escalation off-ladder refused: '${from}' -> '${to}'`,
    );
  }
  if (toAt < fromAt) {
    throw new EscalationError(
      `escalation is one-way: refusing down-step '${from}' -> '${to}'`,
    );
  }
}

export function supportedThinking(
  _models: MutableModels,
  model: AnyModel,
): ModelThinkingLevel[] {
  return getSupportedThinkingLevels(model);
}

export function clampThinking(
  _models: MutableModels,
  model: AnyModel,
  level: ModelThinkingLevel,
): ModelThinkingLevel {
  return clampThinkingLevel(model, level);
}

// A requested level with the name of whoever requested it: 'cli'/'env'/
// 'enterprise' for a per-run override, a config layer name otherwise.
interface ThinkingRequest {
  level: string;
  source: string;
}

export interface ThinkingInputs {
  // A per-run override (--thinking, KUBIC_MODEL_THINKING, or an enterprise
  // freeze): beats everything, including the session's persisted level.
  override?: ThinkingRequest;
  // The level the session recorded at its last boot (restored on attach).
  persisted?: ModelThinkingLevel | null;
  // The role's `thinking` default (`[roles.<name>] thinking`).
  role?: string;
  // `[model] thinking` from the config file layers.
  config?: ThinkingRequest;
}

export interface ResolvedThinking {
  // What the lane boots with — always one of the model's supported levels.
  level: ModelThinkingLevel;
  // cli | env | enterprise | session | role | <config layer> | default
  source: string;
  // Present when the requested level was clamped: names the model, the
  // request and the level applied instead.
  notice?: string;
}

// Pick the requested level by precedence
// override > session > role > config, then clamp it to what the model
// supports. Pi owns the support map; an unsupported request is never
// silently rewritten — the notice says what happened.
export function resolveThinkingLevel(
  model: AnyModel,
  inputs: ThinkingInputs,
): ResolvedThinking {
  const request: ThinkingRequest | undefined =
    inputs.override ??
    (inputs.persisted === undefined || inputs.persisted === null
      ? undefined
      : { level: inputs.persisted, source: 'session' }) ??
    (inputs.role === undefined
      ? undefined
      : { level: inputs.role, source: 'role' }) ??
    inputs.config;
  if (request === undefined) return { level: 'off', source: 'default' };
  if (!isThinkingLevel(request.level)) {
    throw new ModelSelectError(
      `thinking level ${JSON.stringify(request.level)} (${request.source}) is not one of the known levels`,
    );
  }
  const level = clampThinkingLevel(model, request.level);
  if (level === request.level) return { level, source: request.source };
  return {
    level,
    source: request.source,
    notice: `thinking '${request.level}' (${request.source}) is not supported by ${model.provider}/${model.id}; clamped to '${level}' (supported: ${getSupportedThinkingLevels(model).join(', ')})`,
  };
}
