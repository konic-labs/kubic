// Cache-preserving prompt assembly + model affinity.
//
// Prompt caches key on leading bytes: any instability in the prefix
// (system text, tool order, metadata order) or any mid-prefix edit
// silently voids the cache. This module keeps the prefix byte-stable by
// construction and pins one model per task with explicit, recorded,
// one-way escalation. Pure: no Pi imports except types via pi-boundary,
// no network, no filesystem.

import { type EscalationLadder, escalateModel } from './model-select.js';

export class PromptCacheError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PromptCacheError';
  }
}

// NOTE: the PROMPT_CACHE_RULES list was deleted — it named
// no production reader (the rules live in and are pinned by the
// assembly, lifecycle and two-turn tests, not by a constant).
export interface SystemPromptInput {
  role: string;
  cwd: string;
  toolNames: string[];
  metadata: Record<string, string>;
  extraSections?: string[];
}

function sortedToolNames(names: string[]): string[] {
  return [...names].sort();
}

function serializeMetadata(meta: Record<string, string>): string {
  return Object.keys(meta)
    .sort()
    .map((k) => `${k}=${meta[k]}`)
    .join(',');
}

export function assembleSystemPrompt(input: SystemPromptInput): string {
  const sections = [
    input.role,
    `cwd: ${input.cwd}`,
    `tools: ${sortedToolNames(input.toolNames).join(',')}`,
    `meta: ${serializeMetadata(input.metadata)}`,
    ...(input.extraSections ?? []),
  ];
  return sections.join('\n');
}

// Extra prompt sections append last in assembleSystemPrompt above, so nothing
// shifts the prefix bytes; the lane-level two-turn test pins that no new
// pi.system entry is committed. The per-task model pin below keeps the model
// stable across turns.

interface AffinityEscalation {
  from: string;
  to: string;
  reason: string;
  at: number;
}

// The model is pinned once per task. Turns read the pin; there is
// no reselect hook, so N turns always resolve to 1 model id.
export interface TaskAffinity {
  taskId: string;
  modelId: string;
  escalations: AffinityEscalation[];
}

export function pinModelForTask(taskId: string, modelId: string): TaskAffinity {
  return { taskId, modelId, escalations: [] };
}

export function taskModelForTurn(affinity: TaskAffinity): string {
  return affinity.modelId;
}

export interface ModelEscalationEvent {
  type: 'model-escalation';
  taskId: string;
  from: string;
  to: string;
  reason: string;
  at: number;
}

// The ONLY path off the pin: one-way, ladder-bounded, recorded (via the
// shared escalateModel), and observable — every switch builds a
// trajectory-routable event and notifies the sink. No silent switches:
// affinity objects are never mutated in place.
export function escalatePinnedModel(
  affinity: TaskAffinity,
  ladder: EscalationLadder,
  to: string,
  reason: string,
  sink?: (event: ModelEscalationEvent) => void,
): { affinity: TaskAffinity; event: ModelEscalationEvent } {
  const from = affinity.modelId;
  escalateModel(ladder, from, to, reason);
  const at = Date.now();
  const event: ModelEscalationEvent = {
    type: 'model-escalation',
    taskId: affinity.taskId,
    from,
    to,
    reason,
    at,
  };
  sink?.(event);
  return {
    affinity: {
      taskId: affinity.taskId,
      modelId: to,
      escalations: [...affinity.escalations, { from, to, reason, at }],
    },
    event,
  };
}
