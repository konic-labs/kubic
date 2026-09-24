// `kubic cost [--session <id>] [--json]` (issue #79; §62).
// Presentation only over per-agent cost rows: one TUI row per agent plus
// the task total, or the in-code `toCostJson` shape under --json. Rows
// arrive injected (faux in tests); the prod loader below reads real
// session stats out of the session store — this module never invents
// costs, and the task total is always Σ(per-agent) by construction.

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
import {
  type AgentCostInput,
  formatAgentCostRow,
  summarizePerAgentCost,
  toCostJson,
} from './per-agent-cost.js';

export const COST_EXIT_OK = 0;
export const COST_EXIT_FAIL = 1;
export const COST_EXIT_USAGE = 2;

export interface CostCommandDeps {
  loadRows: (
    sessionId?: string,
  ) => AgentCostInput[] | Promise<AgentCostInput[]>;
  out: (line: string) => void;
}

function usage(out: (line: string) => void): number {
  out('usage: kubic cost [--session <id>] [--json]');
  return COST_EXIT_USAGE;
}

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
      });
    } finally {
      await session.close(BACKGROUND_CONTEXT);
    }
  }
  return rows;
}

export async function runCostCommand(
  args: string[],
  deps: CostCommandDeps,
): Promise<number> {
  let json = false;
  let sessionId: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--json') {
      json = true;
    } else if (arg === '--session') {
      const value = args[i + 1];
      if (value === undefined || value.startsWith('--')) {
        deps.out('error: --session needs a value');
        return usage(deps.out);
      }
      if (!SESSION_ID_PATTERN.test(value)) {
        // Fail-closed echo: the rejected id is argv-controlled and may
        // carry secret-shaped material (e.g. a bearer token with spaces).
        deps.out(
          `error: invalid --session id ${redactSecretShapes(JSON.stringify(value))} (use [A-Za-z0-9_-])`,
        );
        return usage(deps.out);
      }
      sessionId = value;
      i++;
    } else {
      return usage(deps.out);
    }
  }
  let rows: AgentCostInput[];
  try {
    rows = await deps.loadRows(sessionId);
  } catch (error) {
    if (error instanceof Error && error.name === 'SessionAttachError') {
      // SESSION_ID_PATTERN admits sk-shaped strings, so the validated id
      // echoing back here may carry secret-shaped material — redact it.
      deps.out(
        `error: unknown session: ${redactSecretShapes(sessionId ?? '')}`,
      );
      return COST_EXIT_FAIL;
    }
    // Store failures name the failure, never the secret: the message is
    // store-controlled and may echo ids, paths, or tokens.
    deps.out(
      `error: ${redactSecretShapes(error instanceof Error ? error.message : String(error))}`,
    );
    return COST_EXIT_FAIL;
  }
  const summary = summarizePerAgentCost(rows);
  if (json) {
    deps.out(JSON.stringify(toCostJson(summary), null, 2));
    return COST_EXIT_OK;
  }
  if (rows.length === 0) {
    deps.out('no cost rows');
    return COST_EXIT_OK;
  }
  for (const entry of summary.perAgent) {
    deps.out(formatAgentCostRow(entry));
  }
  deps.out(
    `task total $${summary.taskTotal.toFixed(2)} (${summary.perAgent.length} agents)`,
  );
  return COST_EXIT_OK;
}
