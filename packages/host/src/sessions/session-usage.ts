import type { Context, Storage, Usage } from '@kubic/agent/pi-boundary';
import { UsageDoc } from '@kubic/agent/pi-boundary';

// A usage counter as a number: anything but a finite number counts as 0.
export function num(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

// One usage bucket read from a conversation's `pi.usage` document: a model
// (`provider/modelId`) or a tool name, and the counters it accumulated.
export interface SessionUsageRow {
  key: string;
  kind: 'model' | 'tool';
  usage: Usage;
}

// The session's own token/cost totals, summed over every conversation's
// usage document — the same numbers `Harness.usage()` reports.
export interface SessionUsageTotals {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  costUsd: number;
}

function addCounters(total: Usage, usage: Usage): void {
  total.input += num(usage.input);
  total.output += num(usage.output);
  total.cacheRead += num(usage.cacheRead);
  total.cacheWrite += num(usage.cacheWrite);
  total.totalTokens += num(usage.totalTokens);
  const cost = (usage.cost ?? {}) as Partial<Usage['cost']>;
  total.cost.input += num(cost.input);
  total.cost.output += num(cost.output);
  total.cost.cacheRead += num(cost.cacheRead);
  total.cost.cacheWrite += num(cost.cacheWrite);
  total.cost.total += num(cost.total);
}

function emptyUsage(): Usage {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

// Every usage bucket of one session, read straight from its Storage:
// one `pi.usage` document per conversation, summed by bucket key. No harness
// is booted and nothing is written — `kubic cost` reads sessions it must not
// open as a run.
export async function readSessionUsage(
  storage: Storage,
  context: Context,
): Promise<SessionUsageRow[]> {
  const rows = new Map<string, SessionUsageRow>();
  // Bounded paged scan, no unbounded query; the cursor's type comes from the
  // storage's own signature.
  const buckets: Array<
    Awaited<ReturnType<Storage['scanConversations']>>['items'][number]
  > = [];
  let cursor: Awaited<ReturnType<Storage['scanConversations']>>['next'];
  for (;;) {
    const page = await storage.scanConversations({}, 256, cursor, context);
    buckets.push(...page.items);
    if (page.next === undefined) break;
    cursor = page.next;
  }
  for (const conversation of buckets) {
    const record = await storage.findDocument(
      {
        kind: UsageDoc.definition.kind,
        scope: { kind: 'conversation', conversationId: conversation.id },
      },
      'current',
      context,
    );
    if (record === undefined) continue;
    const stored = await storage.document(record.id, 'current', context);
    const state = stored?.value as
      | { models?: Record<string, unknown>; tools?: Record<string, unknown> }
      | undefined;
    if (state === undefined) continue;
    for (const [kind, map] of [
      ['model', state.models],
      ['tool', state.tools],
    ] as const) {
      for (const [key, raw] of Object.entries(map ?? {})) {
        // A stored bucket is untrusted JSON: a torn or foreign value is
        // skipped, never merged into the totals (and never a crash).
        if (typeof raw !== 'object' || raw === null) continue;
        const id = `${kind}:${key}`;
        const row = rows.get(id) ?? {
          key,
          kind,
          usage: emptyUsage(),
        };
        addCounters(row.usage, raw as Usage);
        rows.set(id, row);
      }
    }
  }
  // Deterministic readout order: models, then tools, each alphabetically.
  return [...rows.values()].sort(
    (left, right) =>
      left.kind.localeCompare(right.kind) || left.key.localeCompare(right.key),
  );
}

// The session's totals over every bucket it holds.
export function totalSessionUsage(
  rows: readonly SessionUsageRow[],
): SessionUsageTotals {
  const total = emptyUsage();
  for (const row of rows) addCounters(total, row.usage);
  return {
    input: total.input,
    output: total.output,
    cacheRead: total.cacheRead,
    cacheWrite: total.cacheWrite,
    costUsd: total.cost.total,
  };
}
