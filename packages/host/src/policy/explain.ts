// `kubic policy explain`: the effective policy with the layer behind each
// value — every `[policy]` key (set or not), the audit sinks, the config keys
// the enterprise and product layers set (they hold against every lower layer
// and every override), and where the managed config came from: its file,
// whether its signature verified, and the remote policy merged into it.
//
// Presentation over the one runtime load: nothing here re-derives a value, so
// explain can never name a value a run would not use.

import {
  CONFIG_SECTIONS,
  type ConfigKey,
  type ManagedReport,
  type RuntimeConfig,
} from '../config/index.js';

interface PolicyExplainRow {
  readonly key: string;
  // The value as TOML would spell it; `(not set)` for an unset key.
  readonly value: string;
  // The layer that set it (`enterprise`, …); several, named per entry, for
  // the accumulating `denied_tools`; `-` when nothing set it.
  readonly source: string;
}

export interface PolicyExplanation {
  readonly policy: readonly PolicyExplainRow[];
  readonly audit: readonly PolicyExplainRow[];
  readonly enforced: readonly PolicyExplainRow[];
  readonly managed?: ManagedReport;
}

const UNSET = '(not set)';

function toml(value: unknown): string {
  if (typeof value === 'string') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(toml).join(', ')}]`;
  if (typeof value === 'object' && value !== null) {
    return `{ ${Object.entries(value)
      .map(([key, entry]) => `${key} = ${toml(entry)}`)
      .join(', ')} }`;
  }
  return String(value);
}

function flatLeaves(
  value: unknown,
  prefix: string,
  out: Array<[string, unknown]>,
): void {
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    for (const [key, child] of Object.entries(value)) {
      flatLeaves(child, prefix === '' ? key : `${prefix}.${key}`, out);
    }
    return;
  }
  out.push([prefix, value]);
}

function policyRows(runtime: RuntimeConfig): PolicyExplainRow[] {
  const section = CONFIG_SECTIONS.find((entry) => entry.name === 'policy');
  const set = (runtime.config.policy ?? {}) as Record<string, unknown>;
  return ((section?.keys ?? []) as readonly ConfigKey[]).map((key) => {
    const field = key.field ?? key.name;
    if (key.name === 'denied_tools') {
      // Denials accumulate from every layer: each tool names its own.
      const deny = runtime.policy.tools.deny;
      if (deny.length === 0)
        return { key: key.name, value: UNSET, source: '-' };
      const sources = new Set(
        deny.map((tool) => runtime.policy.tools.denySources[tool] ?? '-'),
      );
      return {
        key: key.name,
        value: toml(deny),
        source:
          sources.size === 1
            ? [...sources][0]
            : deny
                .map(
                  (tool) =>
                    `${tool}: ${runtime.policy.tools.denySources[tool] ?? '-'}`,
                )
                .join(', '),
      };
    }
    const value = set[field];
    return value === undefined
      ? { key: key.name, value: UNSET, source: '-' }
      : {
          key: key.name,
          value: toml(value),
          source: runtime.sources[`policy.${field}`] ?? '-',
        };
  });
}

/** The explanation of the effective policy of one runtime load. */
export function explainPolicy(runtime: RuntimeConfig): PolicyExplanation {
  const audit = (runtime.config.audit ?? []).map((table, index) => ({
    key: `audit[${index}]`,
    value: toml(table),
    source: runtime.sources.audit ?? '-',
  }));
  const leaves: Array<[string, unknown]> = [];
  flatLeaves(runtime.config, '', leaves);
  const enforced = leaves
    .filter(([key]) => !key.startsWith('policy.') && key !== 'audit')
    .flatMap(([key, value]) => {
      const source = runtime.sources[key];
      return source === 'enterprise' || source === 'product'
        ? [{ key, value: toml(value), source }]
        : [];
    })
    .sort((a, b) => (a.key < b.key ? -1 : 1));
  return {
    policy: policyRows(runtime),
    audit,
    enforced,
    ...(runtime.managed === undefined ? {} : { managed: runtime.managed }),
  };
}

function rows(entries: readonly PolicyExplainRow[]): string[] {
  const width = Math.max(0, ...entries.map((entry) => entry.key.length));
  return entries.map(
    (entry) =>
      `  ${entry.key.padEnd(width)}  ${entry.value}${entry.source === '-' ? '' : `  (${entry.source})`}`,
  );
}

/** The explanation as lines, one fact each. */
export function renderPolicyExplain(explanation: PolicyExplanation): string[] {
  const lines = ['policy:', ...rows(explanation.policy)];
  lines.push(
    'audit sinks:',
    ...(explanation.audit.length === 0
      ? ['  none configured (the repo ledger records every row)']
      : rows(explanation.audit)),
  );
  lines.push(
    'set by the enterprise and product layers (no lower layer or override changes them):',
    ...(explanation.enforced.length === 0
      ? ['  none']
      : rows(explanation.enforced)),
  );
  const managed = explanation.managed;
  if (managed === undefined) {
    lines.push('managed config: none');
  } else {
    lines.push(
      `managed config: ${managed.configPath} (${managed.signed ? 'signature verified' : 'not signed'})`,
    );
    if (managed.remote !== undefined) {
      lines.push(
        `remote policy: ${managed.remote.url} (fetched ${managed.remote.fetchedAt}, signature verified; cached at ${managed.remote.cachePath})`,
      );
    }
  }
  return lines;
}
