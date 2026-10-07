// §37.4 request options per model/role (issue #257).
// The `[model]` table carries the defaults, a `[roles.<name>]` table
// overrides them per key, and the winner becomes pi-durable
// `settings.stream` on the lane's own harness. Absent fields stay absent: the harness (and below it the provider SDK) applies
// its own defaults, never an invented Kubic one.

import type {
  CacheRetention,
  ConversationStreamOptions,
} from './pi-boundary.js';

/** The four §37.4 keys, as parsed from `[model]` / `[roles.<name>]`. */
export interface ModelStreamTuning {
  timeoutMs?: number;
  maxRetries?: number;
  maxRetryDelayMs?: number;
  cacheRetention?: CacheRetention;
}

/** The merged config's tuning tables: the `[model]` defaults plus every
 * role table that sets at least one key. */
export interface StreamTuningTables {
  model?: ModelStreamTuning;
  roles?: Record<string, ModelStreamTuning>;
}

/**
 * Layer one role table over the `[model]` defaults, per key. Returns
 * undefined when neither sets anything, so the caller omits `stream` and
 * the provider defaults stand.
 */
export function resolveStreamOptions(
  model: ModelStreamTuning | undefined,
  role: ModelStreamTuning | undefined,
): ConversationStreamOptions | undefined {
  const merged: ConversationStreamOptions = {
    ...(model?.timeoutMs === undefined ? {} : { timeoutMs: model.timeoutMs }),
    ...(model?.maxRetries === undefined
      ? {}
      : { maxRetries: model.maxRetries }),
    ...(model?.maxRetryDelayMs === undefined
      ? {}
      : { maxRetryDelayMs: model.maxRetryDelayMs }),
    ...(model?.cacheRetention === undefined
      ? {}
      : { cacheRetention: model.cacheRetention }),
    ...(role?.timeoutMs === undefined ? {} : { timeoutMs: role.timeoutMs }),
    ...(role?.maxRetries === undefined ? {} : { maxRetries: role.maxRetries }),
    ...(role?.maxRetryDelayMs === undefined
      ? {}
      : { maxRetryDelayMs: role.maxRetryDelayMs }),
    ...(role?.cacheRetention === undefined
      ? {}
      : { cacheRetention: role.cacheRetention }),
  };
  return Object.keys(merged).length === 0 ? undefined : merged;
}
