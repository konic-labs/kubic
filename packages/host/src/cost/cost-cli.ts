import { join } from 'node:path';
import {
  listSessions,
  openSessionStore,
  SESSION_ID_PATTERN,
  SessionAttachError,
  SessionLockError,
  sessionLockIsLive,
} from '@kubic/agent/lane/session-store';
import {
  entriesToTranscript,
  readSessionEntries,
} from '@kubic/agent/lane/transcript';
import type { Storage } from '@kubic/agent/pi-boundary';
import { BACKGROUND_CONTEXT } from '@kubic/agent/pi-boundary';
import type { CommandResult } from '@kubic/core/cli/exit-codes';
import { EXIT_FAILED, EXIT_OK, EXIT_USAGE } from '@kubic/core/cli/exit-codes';
import { createLineLogger } from '@kubic/core/cli/logger';
import { formatJson } from '@kubic/core/cli/output';
import { renderTable } from '@kubic/core/cli/table';
import type { CliTheme } from '@kubic/core/cli/theme';
import { createCliTheme } from '@kubic/core/cli/theme';
import { redactSecretShapes } from '@kubic/core/secret-shapes';
import { createNodeFileBridge } from '@kubic/exec/file-bridge';
import { stripUnsafeCharacters } from '@kubic/exec/runtime-exclude';
import type { RunUsage } from '../run/index.js';
import {
  defaultSessionsRoot,
  num,
  openReadOnlySessionStorage,
  readSessionUsage,
  totalSessionUsage,
  touchesWorkspace,
} from '../sessions/index.js';
import { transparentCachingNote } from './cache.js';
import type {
  CostGroupBy,
  SessionCostInput,
  SessionCostSummary,
} from './session-cost.js';
import {
  DEFAULT_COST_GROUP_BY,
  formatCostUsd,
  groupCostRows,
  isCostGroupBy,
  summarizeSessionCost,
  toCostJson,
} from './session-cost.js';

// The parsed `kubic cost` options (commander's `opts()`).
export interface CostOptions {
  readonly session?: string;
  readonly json?: boolean;
  // `--all` lifts the default project scope; `--by`
  // picks the aggregation level (default session).
  readonly all?: boolean;
  readonly by?: string;
}

// What the loader filters and aggregates on: the argv flags plus the
// invoking workspace (which never comes from argv).
export interface CostQuery {
  readonly workspace?: string;
  readonly all?: boolean;
  readonly by?: CostGroupBy;
}

export interface CostCommandDeps {
  loadRows: (
    sessionId?: string,
    query?: CostQuery,
  ) => SessionCostInput[] | Promise<SessionCostInput[]>;
  // The invoking workspace (the composition root's cwd): the default
  // project scope filters to sessions touching it. Absent means unscoped
  // (tests); prod always sets it.
  workspace?: string;
  // stdout: the report or the one `--json` document.
  out: (line: string) => void;
  // stderr: diagnostics, one `error: …` line each (core/cli/logger).
  err: (line: string) => void;
  // Colour and the kit table for the human report; absent means plain.
  theme?: CliTheme;
  // Colour of the stderr diagnostics, from stderr's own TTY state (never
  // stdout's); absent means plain.
  errTheme?: CliTheme;
  fancy?: boolean;
}

const PLAIN = createCliTheme('none');

// A session's tool calls: one per committed tool result, the count a run's
// `--json` usage reports.
function toolCallsOf(items: ReturnType<typeof entriesToTranscript>): number {
  let count = 0;
  for (const item of items) if (item.kind === 'tool-result') count += 1;
  return count;
}

// Prod loader: usage facts out of the session store, aggregated to the
// `--by` level (default session). One base fact per session
// per usage bucket (each `provider/model`, and each tool that reported its
// own spend, labelled `tool:<name>`), so the task total is still exactly
// Σ(rows).
// A session whose storage another live run owns is SKIPPED, never opened
// (pi-durable: one process per storage), and reported as a zero row so the
// operator sees what the readout could not read.
//
// The read path is lock-free by construction. Sessions are
// classified by `listSessions` (header reads only) and a live holder is
// detected by the read-only `sessionLockIsLive` probe — `attachSession`
// never appears here, so `kubic cost` creates no `lock.json`, removes none,
// leaves every session dir mtime (the prune age signal) untouched, and a
// concurrent `kubic run --session` is never blocked. Unreadable sessions
// report a zero marker row instead of failing the report.
export async function loadSessionCostRows(
  sessionsRoot: string = defaultSessionsRoot(),
  sessionId?: string,
  query?: CostQuery,
): Promise<SessionCostInput[]> {
  const by = query?.by ?? DEFAULT_COST_GROUP_BY;
  const store = openSessionStore(
    sessionsRoot,
    createNodeFileBridge(sessionsRoot),
  );
  const all = await listSessions(store, BACKGROUND_CONTEXT);
  // A named session is explicit and ignores the project scope; it keeps
  // its contract (unknown/locked escape, never a marker row).
  const named =
    sessionId === undefined
      ? undefined
      : all.find((entry) => entry.id === sessionId);
  if (sessionId !== undefined && named === undefined) {
    throw new SessionAttachError(sessionId);
  }
  // The default scope is the invoking project — sessions
  // touching its workspace — with `--all` for the machine-global total the
  // command prints.
  const workspace = query?.workspace;
  const scoped =
    named !== undefined
      ? [named]
      : query?.all === true || workspace === undefined
        ? all
        : all.filter((entry) =>
            touchesWorkspace(
              entry.meta?.workspace ?? entry.meta?.cwd,
              workspace,
            ),
          );
  const rows: SessionCostInput[] = [];
  for (const entry of scoped) {
    const isNamed = named !== undefined && entry.id === named.id;
    const project = entry.meta?.workspace ?? entry.meta?.cwd;
    // Base identity every row below carries: the session and the project
    // (its recorded workspace) locate the fact.
    const identity = {
      session: entry.id,
      ...(project === undefined ? {} : { project }),
    } as const;
    const live = sessionLockIsLive(join(sessionsRoot, entry.id));
    if (live !== undefined) {
      // A session the operator NAMED is never silently skipped: a live
      // lock escapes so `runCostCommand` prints the refusal and exits 1.
      // Marker rows are for the listing sweep only.
      if (isNamed) {
        throw new SessionLockError(entry.id, {
          pid: live.pid,
          startedAt: live.startedAt ?? 0,
        });
      }
      // Never opened: a live run owns this storage (pi-durable: one
      // process per storage).
      rows.push({
        ...identity,
        model: '(locked)',
        costUsd: 0,
        input: 0,
        output: 0,
      });
      continue;
    }
    let storage: Storage;
    try {
      storage = await openReadOnlySessionStorage(sessionsRoot, entry.id);
    } catch (error) {
      if (isNamed) throw error;
      if (error instanceof SessionAttachError) {
        rows.push({
          ...identity,
          model: '(unreadable)',
          costUsd: 0,
          input: 0,
          output: 0,
        });
        continue;
      }
      throw error;
    }
    // The race the pre-read probe cannot see. Between the
    // probe above and the reads below, the session can go live — cost
    // then reads a store another process is appending to. The torn tail
    // needs no handling here (the JSONL core truncates a partial trailing
    // record before it parses — the in-flight commit is skipped,
    // never a parse error), but the rows may be partial, so the lock is
    // re-probed AFTER the read and a live session gets a zero marker row
    // beside its rows — the same convention as `(locked)`/`(unreadable)`.
    let wentLive = false;
    try {
      // One row per assistant entry that
      // carries its response's usage — the model spend of that request.
      // Tools that report their own spend aggregate at the higher levels;
      // a request row never invents their attribution.
      if (by === 'request') {
        const items = entriesToTranscript(
          await readSessionEntries(storage, BACKGROUND_CONTEXT),
        );
        for (const item of items) {
          if (item.kind !== 'assistant' || item.usage === undefined) continue;
          rows.push({
            ...identity,
            request: item.entryId,
            model:
              item.provider !== undefined && item.model !== undefined
                ? `${item.provider}/${item.model}`
                : 'unknown',
            costUsd: num(item.usage.cost?.total),
            input: num(item.usage.input),
            output: num(item.usage.output),
            cacheRead: item.usage.cacheRead,
            cacheWrite: item.usage.cacheWrite,
          });
        }
      } else {
        for (const row of await readSessionUsage(storage, BACKGROUND_CONTEXT)) {
          rows.push({
            ...identity,
            // A tool bucket has no provider/model identity: it is labelled
            // `tool:<name>` so the readout never looks like a model row.
            model: row.kind === 'tool' ? `tool:${row.key}` : row.key,
            costUsd: num(row.usage.cost?.total),
            input: row.usage.input,
            output: row.usage.output,
            // The real prefix-cache counters off the
            // session's usage rollup.
            cacheRead: row.usage.cacheRead,
            cacheWrite: row.usage.cacheWrite,
          });
        }
      }
    } finally {
      // No lock was taken, so there is none to give back: closing the
      // storage is the whole release.
      await storage.close(BACKGROUND_CONTEXT);
      wentLive = sessionLockIsLive(join(sessionsRoot, entry.id)) !== undefined;
    }
    if (wentLive) {
      rows.push({
        ...identity,
        model: '(live)',
        costUsd: 0,
        input: 0,
        output: 0,
      });
    }
  }
  // Marker rows (`(locked)`, `(unreadable)`, `(live)`) carry zero counters, so
  // grouping keeps the task total exactly Σ(rows); at project level they
  // merge into the project sum, at the other levels they stay visible.
  return groupCostRows(rows, by);
}

// One run's usage as its `--json` report carries it: the session's own
// usage rollup (the numbers `kubic cost` reads), the tool calls it executed,
// and the `provider/id` of the model that answered last — never invented
// zeros.
export async function readSessionRunUsage(
  sessionsRoot: string,
  sessionId: string,
): Promise<{ usage: RunUsage; model?: string }> {
  const store = openSessionStore(
    sessionsRoot,
    createNodeFileBridge(sessionsRoot),
  );
  // The same lock-free contract as `loadSessionCostRows` — a
  // named unknown id and a live lock escape exactly as `attachSession`
  // reported them, but nothing is ever locked.
  const found = (await listSessions(store, BACKGROUND_CONTEXT)).find(
    (entry) => entry.id === sessionId,
  );
  if (found === undefined) throw new SessionAttachError(sessionId);
  const live = sessionLockIsLive(join(sessionsRoot, sessionId));
  if (live !== undefined) {
    throw new SessionLockError(sessionId, {
      pid: live.pid,
      startedAt: live.startedAt ?? 0,
    });
  }
  const storage = await openReadOnlySessionStorage(sessionsRoot, sessionId);
  try {
    const totals = totalSessionUsage(
      await readSessionUsage(storage, BACKGROUND_CONTEXT),
    );
    const items = entriesToTranscript(
      await readSessionEntries(storage, BACKGROUND_CONTEXT),
    );
    const toolCalls = toolCallsOf(items);
    let model: string | undefined;
    for (const item of items) {
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

// Presentation over the grouped rows: the group column
// names the `--by` level, then the model, and the separate
// in/out/cacheRead/cacheWrite counters the old combined-tokens column hid.
// The kit table only on a coloured terminal, plain aligned text otherwise.
// Model values are model-authored, so the display strips control characters
// (the stored rows keep them raw, exactly like `sessions attach`).
function costTable(
  summary: SessionCostSummary,
  deps: CostCommandDeps,
  by: CostGroupBy,
): string {
  const groupHeader =
    by === 'request' ? 'REQUEST' : by === 'session' ? 'SESSION' : 'PROJECT';
  const groupOf = (entry: SessionCostInput): string => {
    if (by === 'request') return `#${entry.request ?? '?'}`;
    if (by === 'session') return entry.session ?? '(unknown)';
    return entry.project ?? '(unknown)';
  };
  const cell = (value: string): string =>
    stripUnsafeCharacters(value).replace(/\s+/g, ' ');
  const rows = summary.rows.map((entry) => [
    cell(groupOf(entry)),
    cell(entry.model),
    String(entry.input),
    String(entry.output),
    String(entry.cacheRead ?? 0),
    String(entry.cacheWrite ?? 0),
    formatCostUsd(entry.costUsd),
  ]);
  return renderTable(
    rows,
    [
      { header: groupHeader },
      { header: 'MODEL' },
      { header: 'IN', align: 'right' },
      { header: 'OUT', align: 'right' },
      { header: 'CACHE-R', align: 'right' },
      { header: 'CACHE-W', align: 'right' },
      { header: 'COST', align: 'right' },
    ],
    { fancy: deps.fancy === true, theme: deps.theme ?? PLAIN },
  );
}

// The noun a level's count is reported in: `(1 session)`, `(2 sessions)`.
function unitNoun(by: CostGroupBy, count: number): string {
  const noun =
    by === 'request' ? 'request' : by === 'session' ? 'session' : 'project';
  return count === 1 ? noun : `${noun}s`;
}

// `kubic cost` over parsed options: commander (apps/kubic/src/commands/
// analysis.ts) owns argv syntax — unknown flags, missing values, `--help`;
// this handler owns the semantics (the session id pattern, the store).
export async function runCostCommand(
  options: CostOptions,
  deps: CostCommandDeps,
): Promise<CommandResult> {
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
    return { exitCode: EXIT_USAGE };
  }
  // `--by` takes exactly the four levels; anything else is
  // a usage error, and the rejected value is argv-controlled, so it is
  // redacted like the session id above.
  const by =
    options.by === undefined
      ? DEFAULT_COST_GROUP_BY
      : isCostGroupBy(options.by)
        ? options.by
        : undefined;
  if (by === undefined) {
    log.error(
      `invalid --by ${redactSecretShapes(JSON.stringify(options.by))} (use request|session|project)`,
    );
    return { exitCode: EXIT_USAGE };
  }
  let rows: SessionCostInput[];
  try {
    rows = await deps.loadRows(sessionId, {
      all: options.all === true,
      by,
      ...(deps.workspace === undefined ? {} : { workspace: deps.workspace }),
    });
  } catch (error) {
    if (error instanceof Error && error.name === 'SessionAttachError') {
      // SESSION_ID_PATTERN admits sk-shaped strings, so the validated id
      // echoing back here may carry secret-shaped material — redact it.
      log.error(`unknown session: ${redactSecretShapes(sessionId ?? '')}`);
      return { exitCode: EXIT_FAILED };
    }
    // Store failures name the failure, never the secret: the message is
    // store-controlled and may echo ids, paths, or tokens.
    log.error(
      redactSecretShapes(
        error instanceof Error ? error.message : String(error),
      ),
    );
    return { exitCode: EXIT_FAILED };
  }
  const summary = summarizeSessionCost(rows, by);
  if (json) {
    deps.out(formatJson(toCostJson(summary)));
    return { exitCode: EXIT_OK };
  }
  if (rows.length === 0) {
    deps.out('no cost rows');
    return { exitCode: EXIT_OK };
  }
  deps.out(costTable(summary, deps, by));
  deps.out(
    theme.bold(
      `task total ${formatCostUsd(summary.taskTotal)} (${summary.units} ${unitNoun(by, summary.units)})`,
    ),
  );
  // Prefix-cache readout over real usage rows: reported only when the
  // rows actually carried cache counters, so an unmeasured readout never
  // shows a fabricated 0%.
  if (summary.cache !== null) {
    deps.out(
      `cache: ${summary.cache.hits}/${summary.cache.total} ${unitNoun(by, summary.cache.total)} with prefix hits ` +
        `(${Math.round(summary.cache.rate * 100)}%)`,
    );
    deps.out(theme.muted(transparentCachingNote()));
  }
  return { exitCode: EXIT_OK };
}
