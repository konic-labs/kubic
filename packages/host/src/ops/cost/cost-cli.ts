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
import {
  attachSession,
  listSessions,
  openSessionStore,
} from '../../../../worker/src/lane/session-store.js';
import { BACKGROUND_CONTEXT } from '../../../../worker/src/pi-boundary.js';
import { redactSecretShapes } from '../../policy/secret-shapes.js';
import { SESSION_ID_PATTERN } from '../../run-cli.js';
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

// Prod loader: one row per real session out of the session store. Session
// stats carry no per-model split at this seam, so each row is the session
// aggregate (model 'aggregate'); the task total stays exactly Σ(rows).
export async function loadSessionCostRows(
  sessionsRoot: string = defaultSessionsRoot(),
  sessionId?: string,
): Promise<AgentCostInput[]> {
  const store = openSessionStore(
    sessionsRoot,
    createNodeFileBridge(sessionsRoot),
  );
  const ids =
    sessionId === undefined
      ? (await listSessions(store, BACKGROUND_CONTEXT)).map((entry) => entry.id)
      : [sessionId];
  const rows: AgentCostInput[] = [];
  for (const id of ids) {
    const session = await attachSession(store, id, BACKGROUND_CONTEXT);
    try {
      const stats = await session.getStats(BACKGROUND_CONTEXT);
      rows.push({
        agentId: id,
        model: 'aggregate',
        costUsd: stats.usage.cost.total,
        input: stats.usage.input,
        output: stats.usage.output,
        // §62 lever 2 (issue #98): the real prefix-cache counters off the
        // session's usage rollup — this is what makes the reported hit-rate
        // a measurement instead of an assumption.
        cacheRead: stats.usage.cacheRead,
        cacheWrite: stats.usage.cacheWrite,
      });
    } finally {
      await session.close(BACKGROUND_CONTEXT);
    }
  }
  return rows;
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
