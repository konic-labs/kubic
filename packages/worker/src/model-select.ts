// Model selection, one-way escalation, thinking clamp + persist
// (issue #20, slice B; §38).
//
// Selection chain: explicit CLI selection (--model provider/id) beats the
// recorded config default, which beats first-available. Escalation climbs
// a caller-supplied ladder only (one-way: never down, never sideways off
// the ladder), every step recorded with reason, total steps bounded.
// Thinking levels clamp to what the model supports (Pi owns the map);
// the level persists in a sidecar so attach restores it.

import { join } from 'node:path';
import type { FileBridge } from '../../exec/src/file-bridge.js';
import { isThinkingLevel } from './models-config.js';
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

export interface ModelSelection {
  provider: string;
  id: string;
}

export type AnyModel = Model<string>;

export function selectModel(
  models: MutableModels,
  explicit?: ModelSelection,
  configDefault?: ModelSelection,
  // Issue #221: the providers the implicit first-available pick may use,
  // in preference order. The assembly lists models.json customs first and
  // leaves out every built-in whose auth is not configured, so a keyless
  // built-in is never selected silently. Omitted: every registered
  // provider, in registration order.
  fallbackProviders?: readonly string[],
): AnyModel {
  const pick = (sel: ModelSelection, origin: string): AnyModel => {
    const provider = models.getProvider(sel.provider);
    if (provider === undefined) {
      throw new ModelSelectError(
        `unknown provider '${sel.provider}' (${origin})`,
      );
    }
    const model = models.getModel(sel.provider, sel.id);
    if (model === undefined) {
      throw new ModelSelectError(
        `unknown model '${sel.id}' on provider '${sel.provider}' (${origin})`,
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
  throw new ModelSelectError(
    fallbackProviders === undefined
      ? 'no models available: register a provider first'
      : "no models available: register a provider first (set a built-in provider's env key, e.g. ANTHROPIC_API_KEY, or add models.json)",
  );
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

export interface EscalationRecord {
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

export class EscalationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EscalationError';
  }
}

export function createLadder(
  steps: string[],
  options: { maxEscalations?: number } = {},
): EscalationLadder {
  if (steps.length === 0)
    throw new EscalationError('escalation ladder must not be empty');
  return {
    steps,
    maxEscalations: options.maxEscalations ?? steps.length,
    record: [],
  };
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
// without consuming escalation budget. The solo lane validates with this
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

const THINKING_FILE = 'thinking.json';

export function saveThinkingLevel(
  bridge: FileBridge,
  sessionDir: string,
  level: ModelThinkingLevel,
): void {
  bridge.writeFile(join(sessionDir, THINKING_FILE), JSON.stringify({ level }));
}

export function loadThinkingLevel(
  bridge: FileBridge,
  sessionDir: string,
): ModelThinkingLevel | null {
  let raw: string;
  try {
    raw = bridge.readTextFile(join(sessionDir, THINKING_FILE));
  } catch {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      isThinkingLevel((parsed as Record<string, unknown>).level)
    ) {
      return (parsed as { level: ModelThinkingLevel }).level;
    }
    return null;
  } catch {
    return null;
  }
}
