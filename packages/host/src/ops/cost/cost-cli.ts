// `kubic cost [--session <id>] [--json]` (issue #79; §62, §49.2).
// Presentation only over per-agent cost rows: one table row per agent plus
// the task total, or the in-code `toCostJson` shape under --json. Rows
// arrive injected (faux in tests); the prod loader below reads real
// session stats out of the session store — this module never invents
// costs, and the task total is always Σ(per-agent) by construction.
//
// Issue #98 (criterion 4) wires the §62 cache lever here: the same rows
// that carry tokens and cost also carry `cacheRead`/`cacheWrite`, so the
// prefix hit-rate (§62 lever 2, cache.ts) is measured over real usage rows
// and reported on the readout. No new top-level --json field: the extra
// per-row numbers are additive inside the existing `agents` entries.

import { join } from 'node:path';
import {
  EXIT_FAILED,
  EXIT_OK,
  EXIT_USAGE,
} from '../../../../core/src/cli/exit-codes.js';
import { createLineLogger } from '../../../../core/src/cli/logger.js';
import { formatJson } from '../../../../core/src/cli/output.js';
import { renderTable } from '../../../../core/src/cli/table.js';
import {
  type CliTheme,
  createCliTheme,
} from '../../../../core/src/cli/theme.js';
import { createNodeFileBridge } from '../../../../exec/src/file-bridge.js';
import { bridgeToPiFileSystem } from '../../../../worker/src/lane/session-fs.js';
import {
  listSessions,
  openSessionStore,
  SessionAttachError,
  SessionFormatError,
  SessionLockError,
  sessionLockIsLive,
} from '../../../../worker/src/lane/session-store.js';
import {
  entriesToTranscript,
  readSessionEntries,
} from '../../../../worker/src/lane/transcript.js';
import {
  BACKGROUND_CONTEXT,
  type Context,
  JsonlStorage,
  type Storage,
  type Usage,
  UsageDoc,
} from '../../../../worker/src/pi-boundary.js';
import { redactSecretShapes } from '../../policy/secret-shapes.js';
import { type RunUsage, SESSION_ID_PATTERN } from '../../run-cli.js';
import { defaultSessionsRoot } from '../../sessions-cli.js';
import { transparentCachingNote } from './cache.js';
import {
  type AgentCostInput,
  type PerAgentCostSummary,
  summarizePerAgentCost,
  toCostJson,
} from './per-agent-cost.js';

// The parsed `kubic cost` options (commander's `opts()`).
export interface CostOptions {
  readonly session?: string;
  readonly json?: boolean;
}

export interface CostCommandDeps {
  loadRows: (
    sessionId?: string,
  ) => AgentCostInput[] | Promise<AgentCostInput[]>;
  // stdout: the report or the one `--json` document.
  out: (line: string) => void;
  // stderr: diagnostics, one `error: …` line each (core/cli/logger).
  err: (line: string) => void;
  // Colour and box drawing for the human report; absent means plain.
  theme?: CliTheme;
  // Colour of the stderr diagnostics, from stderr's own TTY state (never
  // stdout's); absent means plain.
  errTheme?: CliTheme;
  fancy?: boolean;
}

const PLAIN = createCliTheme('none');

function num(value: unknown): number {
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
// usage document — the same numbers `Harness.usage()` reports (issue #400).
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

// Every usage bucket of one session, read straight from its Storage (#400):
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

// Issue #251: lock-free read-only open of one session's storage. The
// caller classified the session via `listSessions` and probed no live
// holder via `sessionLockIsLive`, so this never creates or removes
// `lock.json` — the session dir mtime (the prune age signal) is untouched
// and a concurrent attach is never blocked. A missing storage is an
// unknown session, exactly as `attachSession` reports it.
async function openCostReadStorage(
  sessionsRoot: string,
  sessionId: string,
): Promise<Storage> {
  const bridge = createNodeFileBridge(sessionsRoot);
  if (!bridge.exists(join(sessionsRoot, sessionId, 'main.jsonl'))) {
    throw new SessionAttachError(sessionId);
  }
  // The portable core over the exec bridge, never the `/node` entry point:
  // session bytes keep crossing the I/O seam, where the #359 secret
  // scrubbing and the #361 file modes live (see session-fs.ts). fsync stays
  // off — cost never commits, so there is nothing to flush.
  return JsonlStorage.open(
    join(sessionsRoot, sessionId),
    bridgeToPiFileSystem(bridge),
    BACKGROUND_CONTEXT,
    { fsync: false },
  );
}

// Prod loader: one row per real session out of the session store, one row
// per usage bucket the session recorded (each `provider/model`, and each tool
// that reported its own usage), so the task total is still exactly Σ(rows).
// A session whose storage another live run owns is SKIPPED, never opened
// (pi-durable: one process per storage), and reported as a zero row so the
// operator sees what the readout could not read.
//
// Issue #251: the read path is lock-free by construction. Sessions are
// classified by `listSessions` (header reads only) and a live holder is
// detected by the read-only `sessionLockIsLive` probe — `attachSession`
// never appears here, so `kubic cost` creates no `lock.json`, removes none,
// leaves every session dir mtime (the prune age signal) untouched, and a
// concurrent `kubic run --session` is never blocked. Unreadable sessions
// report a zero marker row instead of failing the report.
export async function loadSessionCostRows(
  sessionsRoot: string = defaultSessionsRoot(),
  sessionId?: string,
): Promise<AgentCostInput[]> {
  const store = openSessionStore(
    sessionsRoot,
    createNodeFileBridge(sessionsRoot),
  );
  const all = await listSessions(store, BACKGROUND_CONTEXT);
  // Issue #164 (§23): a NAMED orchestrate session rolls its run up — the
  // manager record plus every session whose metadata names it as parent,
  // so `kubic cost --session <orch>` is the run's total with per-child
  // rows. The named parent keeps its contract (unknown/locked/legacy
  // escape, never a marker row); a child that cannot be opened reports a
  // zero marker row like the listing sweep, so a still-running worker
  // (live lock) reads as `(locked)` instead of failing the report.
  const named =
    sessionId === undefined
      ? undefined
      : all.find((entry) => entry.id === sessionId);
  if (sessionId !== undefined && named === undefined) {
    throw new SessionAttachError(sessionId);
  }
  if (named?.format === 'legacy') {
    throw new SessionFormatError(named.id);
  }
  const children =
    named === undefined
      ? []
      : all.filter(
          (entry) =>
            entry.id !== named.id && entry.meta?.parentSessionId === named.id,
        );
  const entries = named === undefined ? all : [named, ...children];
  const rows: AgentCostInput[] = [];
  for (const entry of entries) {
    const isNamed = named !== undefined && entry.id === named.id;
    if (entry.format === 'legacy') {
      // A named legacy id escaped above; a legacy child of a named run
      // reports like any other unreadable listing entry.
      rows.push({
        agentId: entry.id,
        model: '(unreadable)',
        costUsd: 0,
        input: 0,
        output: 0,
      });
      continue;
    }
    const live = sessionLockIsLive(join(sessionsRoot, entry.id));
    if (live !== undefined) {
      // A session the operator NAMED is never silently skipped: a live
      // lock escapes so `runCostCommand` prints the refusal and exits 1,
      // as it did before the durable store. Marker rows are for the
      // listing sweep — and for the NAMED run's children — only.
      // Review #164: a live run's manager record is lock-held by the run
      // itself — refusing the whole report would leave a running run with
      // no cost view. With children recorded, the parent row is skipped
      // and the report covers the children; without children the named
      // contract below still escapes.
      if (isNamed && children.length > 0) {
        continue;
      }
      if (isNamed) {
        throw new SessionLockError(entry.id, {
          pid: live.pid,
          startedAt: live.startedAt ?? 0,
        });
      }
      // Never opened: a live run owns this storage (pi-durable: one
      // process per storage).
      rows.push({
        agentId: entry.id,
        model: '(locked)',
        costUsd: 0,
        input: 0,
        output: 0,
      });
      continue;
    }
    let storage: Storage;
    try {
      storage = await openCostReadStorage(sessionsRoot, entry.id);
    } catch (error) {
      if (isNamed) throw error;
      if (
        error instanceof SessionAttachError ||
        error instanceof SessionFormatError
      ) {
        rows.push({
          agentId: entry.id,
          model: '(unreadable)',
          costUsd: 0,
          input: 0,
          output: 0,
        });
        continue;
      }
      throw error;
    }
    try {
      for (const row of await readSessionUsage(storage, BACKGROUND_CONTEXT)) {
        rows.push({
          agentId: entry.id,
          // A tool bucket has no provider/model identity: it is labelled
          // `tool:<name>` so the readout never looks like a model row.
          model: row.kind === 'tool' ? `tool:${row.key}` : row.key,
          costUsd: num(row.usage.cost?.total),
          input: row.usage.input,
          output: row.usage.output,
          // §62 lever 2 (issue #98): the real prefix-cache counters off the
          // session's usage rollup.
          cacheRead: row.usage.cacheRead,
          cacheWrite: row.usage.cacheWrite,
        });
      }
    } finally {
      // No lock was taken, so there is none to give back: closing the
      // storage is the whole release.
      await storage.close(BACKGROUND_CONTEXT);
    }
  }
  return rows;
}

// One run's usage as its `--json` report carries it (issue #185; §39,
// §68): the session's own usage rollup (the numbers `kubic cost` reads), the
// tool calls it executed, and the `provider/id` of the model that answered
// last. The orchestrator builds each worker's §68 metrics and provenance
// from this — never invented zeros.
export async function readSessionRunUsage(
  sessionsRoot: string,
  sessionId: string,
): Promise<{ usage: RunUsage; model?: string }> {
  const store = openSessionStore(
    sessionsRoot,
    createNodeFileBridge(sessionsRoot),
  );
  // Issue #251: the same lock-free contract as `loadSessionCostRows` — a
  // named unknown id, a live lock and a 0.87 transcript escape exactly as
  // `attachSession` reported them, but nothing is ever locked.
  const found = (await listSessions(store, BACKGROUND_CONTEXT)).find(
    (entry) => entry.id === sessionId,
  );
  if (found === undefined) throw new SessionAttachError(sessionId);
  if (found.format === 'legacy') throw new SessionFormatError(sessionId);
  const live = sessionLockIsLive(join(sessionsRoot, sessionId));
  if (live !== undefined) {
    throw new SessionLockError(sessionId, {
      pid: live.pid,
      startedAt: live.startedAt ?? 0,
    });
  }
  const storage = await openCostReadStorage(sessionsRoot, sessionId);
  try {
    const totals = totalSessionUsage(
      await readSessionUsage(storage, BACKGROUND_CONTEXT),
    );
    const items = entriesToTranscript(
      await readSessionEntries(storage, BACKGROUND_CONTEXT),
    );
    let toolCalls = 0;
    let model: string | undefined;
    for (const item of items) {
      if (item.kind === 'tool-result') toolCalls += 1;
      if (
        item.kind === 'assistant' &&
        item.provider !== undefined &&
        item.model !== undefined
      ) {
        model = `${item.provider}/${item.model}`;
      }
    }
    return {
      usage: {
        input: totals.input,
        output: totals.output,
        cacheRead: totals.cacheRead,
        cacheWrite: totals.cacheWrite,
        costUsd: totals.costUsd,
        toolCalls,
      },
      ...(model === undefined ? {} : { model }),
    };
  } finally {
    await storage.close(BACKGROUND_CONTEXT);
  }
}

// Presentation over the per-agent rows: a table (box-drawn only on a
// coloured terminal, plain aligned text otherwise), then the task total.
function costTable(
  summary: PerAgentCostSummary,
  deps: CostCommandDeps,
): string {
  const rows = summary.perAgent.map((entry) => [
    entry.agentId,
    entry.model,
    String(entry.input + entry.output),
    `$${entry.costUsd.toFixed(2)}`,
  ]);
  return renderTable(
    rows,
    [
      { header: 'AGENT' },
      { header: 'MODEL' },
      { header: 'TOKENS', align: 'right' },
      { header: 'COST', align: 'right' },
    ],
    { fancy: deps.fancy === true, theme: deps.theme ?? PLAIN },
  );
}

// `kubic cost` over parsed options: commander (apps/kubic/src/commands/
// analysis.ts) owns argv syntax — unknown flags, missing values, `--help`;
// this handler owns the semantics (the session id pattern, the store).
export async function runCostCommand(
  options: CostOptions,
  deps: CostCommandDeps,
): Promise<number> {
  const json = options.json === true;
  const theme = json ? PLAIN : (deps.theme ?? PLAIN);
  const log = createLineLogger(deps.err, {
    theme: json ? PLAIN : (deps.errTheme ?? PLAIN),
  });
  const sessionId = options.session;
  if (sessionId !== undefined && !SESSION_ID_PATTERN.test(sessionId)) {
    // Fail-closed echo: the rejected id is argv-controlled and may
    // carry secret-shaped material (e.g. a bearer token with spaces).
    log.error(
      `invalid --session id ${redactSecretShapes(JSON.stringify(sessionId))} (use [A-Za-z0-9_-])`,
    );
    return EXIT_USAGE;
  }
  let rows: AgentCostInput[];
  try {
    rows = await deps.loadRows(sessionId);
  } catch (error) {
    if (error instanceof Error && error.name === 'SessionAttachError') {
      // SESSION_ID_PATTERN admits sk-shaped strings, so the validated id
      // echoing back here may carry secret-shaped material — redact it.
      log.error(`unknown session: ${redactSecretShapes(sessionId ?? '')}`);
      return EXIT_FAILED;
    }
    // Store failures name the failure, never the secret: the message is
    // store-controlled and may echo ids, paths, or tokens.
    log.error(
      redactSecretShapes(
        error instanceof Error ? error.message : String(error),
      ),
    );
    return EXIT_FAILED;
  }
  const summary = summarizePerAgentCost(rows);
  if (json) {
    deps.out(formatJson(toCostJson(summary)));
    return EXIT_OK;
  }
  if (rows.length === 0) {
    deps.out('no cost rows');
    return EXIT_OK;
  }
  deps.out(costTable(summary, deps));
  deps.out(
    theme.bold(
      `task total $${summary.taskTotal.toFixed(2)} (${summary.perAgent.length} agents)`,
    ),
  );
  // §62 lever 2 over real usage rows (issue #98): reported only when the
  // rows actually carried cache counters, so an unmeasured readout never
  // shows a fabricated 0%.
  if (summary.cache !== null) {
    deps.out(
      `cache: ${summary.cache.hits}/${summary.cache.total} sessions with prefix hits ` +
        `(${Math.round(summary.cache.rate * 100)}%)`,
    );
    deps.out(theme.muted(transparentCachingNote()));
  }
  return EXIT_OK;
}
