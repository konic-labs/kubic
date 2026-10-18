// The effective config `kubic config` reports: every set leaf with the layer
// that owns it and what the runtime does with it, secrets redacted.

import {
  DEFAULT_RESERVE_TOKENS,
  effectiveReserveTokens,
  KEEP_RECENT_TOKENS,
} from '@kubic/agent/compaction';
import type { PermissionClasses } from '@kubic/agent/permissions';
import { redactSecretShapes } from '@kubic/core/secret-shapes';
import { alwaysAskAutoApprove } from '../approvals/index.js';
import { isRecord } from './checks.js';
import { flatten } from './runtime-layers.js';
import type {
  ConfigLayerReport,
  ConfigValueSource,
  RuntimeConfig,
  RuntimeModelSelection,
  RuntimeThinking,
} from './runtime-types.js';
import type { ConfigKey, KeyEffect } from './schema.js';
import { CONFIG_SECTIONS } from './schema.js';

// What the runtime does with each config key (`kubic config`, `kubic
// doctor`): consumed, kept with the reason, or pending.
/** @internal */
export type RuntimeKeyEffect = KeyEffect;

/** @internal */
export type RuntimeKeyDisposition = 'consumed' | 'kept' | 'pending' | 'unknown';

// The schema's runtime rows: one per `section.key`, plus a section's own row,
// which the keys of an open-ended section resolve through.
/** @internal */
export const RUNTIME_KEY_EFFECTS: Record<string, RuntimeKeyEffect> =
  Object.fromEntries(
    CONFIG_SECTIONS.flatMap((section) => {
      const rows: [string, KeyEffect][] = [];
      if ('runtime' in section) rows.push([section.name, section.runtime]);
      for (const key of section.keys as readonly ConfigKey[]) {
        if (key.runtime !== undefined) {
          rows.push([`${section.name}.${key.name}`, key.runtime]);
        }
      }
      return rows;
    }),
  );

// The table lookup is section-or-key (the rule): `roles.implementer.
// model` resolves through `roles`. Undefined means the table has no row for
// the key at all — `config-doctor` flags exactly that by name.
/** @internal */
export function keyEffectFor(key: string): RuntimeKeyEffect | undefined {
  const direct = RUNTIME_KEY_EFFECTS[key];
  if (direct !== undefined) return direct;
  const section = key.split('.')[0] as string;
  return RUNTIME_KEY_EFFECTS[section];
}

/** @internal */
export function runtimeKeyDisposition(
  entry: RuntimeKeyEffect | undefined,
): RuntimeKeyDisposition {
  if (entry === undefined) return 'unknown';
  if ('effect' in entry) return 'consumed';
  if ('kept' in entry) return 'kept';
  return 'pending';
}

interface EffectiveConfigValue {
  key: string;
  // Formatted like the TOML value it came from, so the human view and the
  // machine view never disagree about what the value is.
  value: string;
  layer: ConfigValueSource;
  // What the key-effect table says this key does — 'consumed'
  // (an effect row), 'kept' (a recorded decision), 'pending' (a named
  // follow-up), or 'unknown' (no row at all; config-doctor flags it).
  disposition: RuntimeKeyDisposition;
}

export interface EffectiveConfigView {
  values: EffectiveConfigValue[];
  sources: Record<string, ConfigValueSource>;
  approvals: {
    route: string;
    source: ConfigValueSource;
    autoApprove: string[];
    maxPendingMs: number;
    sessionScoped: boolean;
    requireJustification: boolean;
  };
  permissions: { classes: PermissionClasses; source: ConfigValueSource };
  journal: {
    retentionDays?: number;
    maxAgeMs?: number;
    outOfScope?: string[];
    source: ConfigValueSource;
  };
  compaction: {
    enabled: boolean;
    reserveTokens: number;
    keepRecentTokens: number;
    source: ConfigValueSource;
  };
  model: RuntimeModelSelection | undefined;
  modelSource: ConfigValueSource;
  // The effective thinking level with its source, so
  // `kubic config --json` reports what the lane boots with.
  thinking: RuntimeThinking | undefined;
  projectTrusted: boolean;
  overriddenAttempts: string[];
  layers: ConfigLayerReport[];
}

function formatValue(value: unknown): string {
  if (typeof value === 'string')
    return JSON.stringify(redactSecretShapes(value));
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => formatValue(item)).join(', ')}]`;
  }
  // Tables render as JSON: the role `models` set is the
  // first array-of-tables in config, and without this branch it printed
  // `[object Object]`. Strings redact leaf-wise, never the structure.
  if (isRecord(value)) return JSON.stringify(redactDeep(value));
  return JSON.stringify(redactSecretShapes(String(value)));
}

function redactDeep(value: unknown): unknown {
  if (typeof value === 'string') return redactSecretShapes(value);
  if (Array.isArray(value)) return value.map(redactDeep);
  if (isRecord(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, child]) => [key, redactDeep(child)]),
    );
  }
  return value;
}

// Machine-readable effective values: every set leaf with the layer that owns
// it, plus the projections the product actually consumes. Consumed by
// `kubic config --json` and by `kubic doctor --json` via the same function.
export function effectiveConfigView(
  runtime: RuntimeConfig,
): EffectiveConfigView {
  const values: EffectiveConfigValue[] = [];
  for (const [key, value] of Object.entries(flatten(runtime.config))) {
    values.push({
      key,
      value: formatValue(value),
      layer: runtime.sources[key] ?? 'defaults',
      disposition: runtimeKeyDisposition(keyEffectFor(key)),
    });
  }
  // [agent] systemPromptFile: the report names the EFFECTIVE
  // (resolved) path, not the declared spelling — same derivation the lane
  // boots with. The layer stays the declaring one.
  if (runtime.systemPromptFile !== undefined) {
    const row = values.find((entry) => entry.key === 'agent.systemPromptFile');
    if (row !== undefined) {
      row.value = formatValue(runtime.systemPromptFile.path);
      row.layer = runtime.systemPromptFile.source;
    }
  }
  values.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  return {
    values,
    sources: { ...runtime.sources },
    approvals: {
      route: runtime.approvals.policy.route,
      source: runtime.approvals.source,
      autoApprove: [...runtime.approvals.policy.autoApprove],
      maxPendingMs: runtime.approvals.policy.maxPendingMs,
      sessionScoped: runtime.approvals.policy.sessionScoped,
      requireJustification: runtime.approvals.policy.requireJustification,
    },
    permissions: {
      classes: { ...runtime.permissions.classes },
      source: runtime.permissions.source,
    },
    journal: {
      ...runtime.journal,
      ...(runtime.journal.outOfScope === undefined
        ? {}
        : { outOfScope: [...runtime.journal.outOfScope] }),
    },
    // The reportable compaction policy: configured values
    // default-filled, so the report names what the lane will run with. The
    // reserve is the EFFECTIVE one through the same clamp the lane's live
    // getter uses — with no conversation there is no model window yet, so
    // an unknown window reports the configured value and the lane re-clamps
    // per model at boot.
    compaction: {
      enabled: runtime.compaction.enabled ?? true,
      reserveTokens: effectiveReserveTokens(
        0,
        runtime.compaction.reserveTokens ?? DEFAULT_RESERVE_TOKENS,
      ),
      keepRecentTokens:
        runtime.compaction.keepRecentTokens ?? KEEP_RECENT_TOKENS,
      source: runtime.compaction.source,
    },
    model: runtime.model === undefined ? undefined : { ...runtime.model },
    modelSource: runtime.modelSource,
    thinking:
      runtime.thinking === undefined ? undefined : { ...runtime.thinking },
    projectTrusted: runtime.projectTrusted,
    overriddenAttempts: [...runtime.overriddenAttempts],
    layers: runtime.layers.map((layer) => ({ ...layer })),
  };
}

// The effective compaction policy as one reportable line: what
// the lane runs with. The reserve is already clamped through the lane's own
// clamp; the lane re-clamps per model at boot (at most a quarter of its
// window), so a small-window model may compact sooner than this line's
// figure. Shared by `kubic config` and the doctor probe, so the two surfaces
// cannot disagree about the effective reserve.
export function compactionSummaryLine(compaction: {
  enabled: boolean;
  reserveTokens: number;
  keepRecentTokens: number;
  source: ConfigValueSource;
}): string {
  return `compaction: ${compaction.enabled ? 'automatic' : 'off'}, reserve=${compaction.reserveTokens} token(s) (${compaction.source}; clamped per model to at most a quarter of its window), keep-recent=${compaction.keepRecentTokens} token(s), capped to a quarter of the room below the reserve`;
}

// Human-readable rendering of the same view (one line per fact); secret
// shapes are redacted, so a mis-shaped value never reaches a terminal
// verbatim — and an operator cannot paste one back into a shared log.
export function renderEffectiveConfig(view: EffectiveConfigView): string[] {
  const lines: string[] = [];
  // The disposition split up front: a reader sees how many
  // values are consumed, how many are kept decisions, and how many are
  // pending — before the per-value lines repeat it.
  const counts = { consumed: 0, kept: 0, pending: 0, unknown: 0 };
  for (const value of view.values) counts[value.disposition] += 1;
  lines.push(
    `config: ${view.values.length} value(s) from ${view.layers.filter((l) => l.present).length} present layer(s); effects: ${counts.consumed} consumed, ${counts.kept} kept, ${counts.pending} pending${
      counts.unknown === 0
        ? ''
        : `, ${counts.unknown} with no effect row (see doctor)`
    }`,
  );
  for (const layer of view.layers) {
    lines.push(
      `layer ${layer.layer}: ${layer.present ? 'present' : 'absent'}${
        layer.layer === 'project'
          ? layer.trusted
            ? ' (trusted)'
            : ' (refused: untrusted)'
          : ''
      }${layer.path === undefined ? '' : ` ${layer.path}`}`,
    );
  }
  for (const value of view.values) {
    lines.push(
      `${value.key} = ${value.value} (${value.layer}, ${value.disposition})`,
    );
  }
  if (view.model !== undefined) {
    lines.push(
      `selected model: ${view.model.provider}/${view.model.id}${
        view.model.thinking === undefined
          ? ''
          : ` (thinking: ${view.model.thinking})`
      } (${view.modelSource})`,
    );
  } else {
    lines.push(
      `selected model: first available provider (${view.modelSource}) — no model pin configured`,
    );
  }
  // The effective thinking level with its source: what the
  // lane boots with before the model clamp. The `model.thinking` value row
  // above names the file default; this names the winner.
  if (view.thinking !== undefined) {
    lines.push(
      `thinking level: ${view.thinking.level} (${view.thinking.source})`,
    );
  }
  // An always-ask capability in autoApprove never applies: named
  // and left out of the count, never printed as an approval nothing grants.
  const ignoredAutoApprove = [
    ...new Set(alwaysAskAutoApprove(view.approvals.autoApprove)),
  ];
  const effectiveAutoApprove = view.approvals.autoApprove.filter(
    (capability) => !ignoredAutoApprove.includes(capability),
  );
  lines.push(
    `approvals: route=${view.approvals.route} (${view.approvals.source}), ${effectiveAutoApprove.length} auto-approved${
      ignoredAutoApprove.length === 0
        ? ''
        : ` (${ignoredAutoApprove.join(', ')} always asks — ignored)`
    }, maxPendingMs=${view.approvals.maxPendingMs}`,
  );
  lines.push(
    `permissions: filesystem=${view.permissions.classes.filesystem}, shell=${String(view.permissions.classes.shell)}, network=${view.permissions.classes.network}, git=${String(view.permissions.classes.git)}, credentials=${view.permissions.classes.credentials} (${view.permissions.source})`,
  );
  lines.push(
    view.journal.retentionDays === undefined
      ? 'journal retention: none configured (no age bound)'
      : view.journal.retentionDays === 0
        ? `journal retention: off (retentionDays 0, no age bound) (${view.journal.source})`
        : `journal retention: ${view.journal.retentionDays} day(s) = maxAgeMs ${view.journal.maxAgeMs} (${view.journal.source})`,
  );
  lines.push(
    view.journal.outOfScope === undefined
      ? 'journal out-of-scope: none declared — the walk still skips .git/, .kubic/ and .gitignore hits on its own'
      : `journal out-of-scope: ${view.journal.outOfScope.length} path(s) excluded from the baseline and the sweep (self + children): ${view.journal.outOfScope.join(', ')}`,
  );
  lines.push(compactionSummaryLine(view.compaction));
  lines.push(
    `project layer: ${view.projectTrusted ? 'trusted' : "distrusted (refused pre-trust; run 'kubic trust' to accept this project, or set KUBIC_TRUST_PROJECT=1 for this invocation)"}`,
  );
  lines.push(
    view.overriddenAttempts.length === 0
      ? 'overridden attempts: none'
      : `overridden attempts (reported, never applied): ${view.overriddenAttempts.join(', ')}`,
  );
  return lines;
}
