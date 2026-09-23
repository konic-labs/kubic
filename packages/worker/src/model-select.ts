// Model selection, one-way escalation, thinking clamp + persist
// (issue #20, slice B; §38).
//
// Selection chain: explicit CLI selection (--model provider/id) beats the
// recorded config default, which beats first-available. Escalation climbs
// a caller-supplied ladder only (one-way: never down, never sideways off
// the ladder), every step recorded with reason, total steps bounded.
// Thinking levels clamp to what the model supports (Pi owns the map);
// the level persists in a sidecar so attach restores it.

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
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
): AnyModel {
  const pick = (sel: ModelSelection, origin: string): AnyModel => {
    const provider = models.getProvider(sel.provider);
    if (provider === undefined) {
      throw new ModelSelectError(`unknown provider '${sel.provider}' (${origin})`);
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
  const providers = models.getProviders();
  for (const provider of providers) {
    const first = models.getModels(provider.id)[0];
    if (first !== undefined) return first as AnyModel;
  }
  throw new ModelSelectError('no models available: register a provider first');
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
  if (steps.length === 0) throw new EscalationError('escalation ladder must not be empty');
  return { steps, maxEscalations: options.maxEscalations ?? steps.length, record: [] };
}

export function escalateModel(
  ladder: EscalationLadder,
  from: string,
  to: string,
  reason: string,
): { to: string } {
  if (ladder.record.length >= ladder.maxEscalations) {
    throw new EscalationError(
      `escalation bounded: ${ladder.record.length} steps already (max ${ladder.maxEscalations})`,
    );
  }
  const fromAt = ladder.steps.indexOf(from);
  const toAt = ladder.steps.indexOf(to);
  if (fromAt === -1 || toAt === -1) {
    throw new EscalationError(`escalation off-ladder refused: '${from}' -> '${to}'`);
  }
  if (toAt < fromAt) {
    throw new EscalationError(`escalation is one-way: refusing down-step '${from}' -> '${to}'`);
  }
  ladder.record.push({ from, to, reason, at: Date.now() });
  return { to };
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
  sessionDir: string,
  level: ModelThinkingLevel,
): void {
  writeFileSync(join(sessionDir, THINKING_FILE), JSON.stringify({ level }));
}

export function loadThinkingLevel(sessionDir: string): ModelThinkingLevel | null {
  let raw: string;
  try {
    raw = readFileSync(join(sessionDir, THINKING_FILE), 'utf8');
  } catch {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      typeof (parsed as Record<string, unknown>).level === 'string'
    ) {
      return (parsed as Record<string, unknown>).level as ModelThinkingLevel;
    }
    return null;
  } catch {
    return null;
  }
}
