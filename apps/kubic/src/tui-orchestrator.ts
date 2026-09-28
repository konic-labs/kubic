// The TUI's orchestrator lane (issue #327; §17, §81).
//
// Two pieces live here, both composition-root concerns:
//
//   workerAskSeatFromAnswer — the bridge that turns an orchestrator worker's
//     approval ask (packages/host/src/orchestrator/approvals/worker-asks.ts)
//     into a request the TUI's approval surface renders, and the surface's
//     verdict back into the shape the router answers the worker with. The
//     approvals run writes that answer to the mailbox, which is what unblocks
//     the worker's bounded wait.
//
//   createProdTuiOrchestrator — the manager-lane drive a TUI orchestrator
//     session submits to: the same `runOrchestrateCommand` +
//     `orchestrateDepsWithDefaults` pair `kubic orchestrate` runs, with the
//     TUI's seat attached so worker asks reach the overlay instead of the
//     stdio prompt. The deps are built lazily: a session that never toggles
//     into orchestrator mode pays nothing.

import type {
  ApprovalRequest,
  ApprovalVerdict,
} from '../../../packages/host/src/approvals.js';
import type { RuntimeOrchestrator } from '../../../packages/host/src/config/runtime.js';
import type {
  OrchestrateCliOptions,
  OrchestrateCommandDeps,
} from '../../../packages/host/src/orchestrate-cli.js';
import { runOrchestrateCommand } from '../../../packages/host/src/orchestrate-cli.js';
import type { OrchestratorApprovalRequest } from '../../../packages/host/src/orchestrator/approvals/request.js';
import type { OrchestratorVerdict } from '../../../packages/host/src/orchestrator/approvals/routing.js';
import type { WorkerAskSeat } from '../../../packages/host/src/orchestrator/approvals/worker-asks.js';
import type { ApprovalSnapshot } from '../../../packages/host/src/orchestrator/merge/conflicts.js';
import {
  type OrchestrateRunOptions,
  orchestrateDepsWithDefaults,
} from './orchestrate-run.js';
import type { TuiOrchestratorRun, TuiTurnOutcome } from './tui-run.js';

// The TUI's own ask collector: the approval surface's seat
// (`ApprovalSurface.seat`, packages/tui/src/approval-surface.ts) satisfies
// this structurally — it takes the host request shape and answers with the
// host verdict shape. Named so both the composition root and tests agree.
export type TuiAskSeat = (
  request: ApprovalRequest,
) => Promise<ApprovalVerdict | undefined>;

// The worker's ask, rendered by the TUI's approval overlay. The trigger IS
// the capability vocabulary (request.ts keeps the two in sync), the summary
// names the worker so the operator knows whose step is asking, and the full
// command rides through untouched — the dialog is where the decision is
// made on what will run.
export function workerAskSeatFromAnswer(answer: TuiAskSeat): WorkerAskSeat {
  return async (
    request: OrchestratorApprovalRequest,
  ): Promise<OrchestratorVerdict> => {
    const decision = await answer({
      key: request.key,
      capability: request.trigger,
      toolName: request.toolName,
      summary: `worker '${request.agentId}': ${request.summary}`,
      ...(request.command === undefined ? {} : { command: request.command }),
      justification: request.justification,
    });
    if (decision === undefined) {
      // A seat that answers nothing is not consent; deny by name so the
      // worker unblocks instead of waiting out its own bound.
      return { approved: false, reason: 'the approval was never answered' };
    }
    return decision.approved
      ? // The router's approval vocabulary is by:'user' ONLY (§41.2): the
        // overlay's 'allow-once' / 'allow-session' labels are the solo
        // lane's own and would be refused as a non-user grant ("only the
        // user decider may approve"). The verdict here IS the operator's.
        { approved: true, by: 'user' }
      : { approved: false, reason: decision.reason };
  };
}

export interface ProdTuiOrchestratorOptions {
  // The TUI session the run is scoped to (worktree scoping, run state).
  sessionId: string;
  cwd?: string;
  // Worker sessions root. Absent means the user sessions root.
  sessionsRoot?: string;
  // The per-turn report sink (the runner routes it into the transcript).
  out: (line: string) => void;
  // Diagnostics (the orchestrator's own error/debug lines). Absent means the
  // report sink: on the alt-screen stderr would corrupt the display.
  err?: (line: string) => void;
  debug?: (line: string) => void;
  // The worker-ask seat the approvals run consults. Absent means asks deny
  // closed on their bound (a boot with no surface attached).
  seat?: WorkerAskSeat;
  // The manager lane's approval snapshot (delegated conflict resolvers).
  approvalPolicy?: ApprovalSnapshot;
  // The `[orchestrator]` projection (worktree parent + worker cap).
  orchestrator?: RuntimeOrchestrator;
  // Test seams: the deps factory and the command function. Absent means the
  // prod pair (orchestrateDepsWithDefaults + runOrchestrateCommand).
  createDeps?: (
    options: OrchestrateRunOptions,
  ) => Promise<OrchestrateCommandDeps>;
  runCommand?: (
    options: OrchestrateCliOptions,
    deps: OrchestrateCommandDeps,
  ) => Promise<number>;
}

// One objective in, one settle out: the manager-lane path `kubic
// orchestrate` runs, with the TUI's report sink and worker-ask seat wired in.
// Deps are built per turn and never reused: each `kubic orchestrate`
// invocation constructs its own run state (registry, worktree cache,
// orphan reconciliation), so a second objective in the same TUI session gets
// the same fresh start a second CLI run would — and a session that never
// toggles into orchestrator mode pays nothing.
export function createProdTuiOrchestrator(
  options: ProdTuiOrchestratorOptions,
): TuiOrchestratorRun {
  // The report sink is per-turn (the runner hands a fresh callback); the
  // stable forwarder keeps the deps' output connected to it.
  let sink = options.out;
  const report = (line: string): void => {
    sink(line);
  };
  const createDeps = options.createDeps ?? orchestrateDepsWithDefaults;
  const runCommand = options.runCommand ?? runOrchestrateCommand;
  return {
    async run(objective, onReport): Promise<TuiTurnOutcome> {
      sink = onReport ?? options.out;
      try {
        const deps = await createDeps({
          out: report,
          err: options.err ?? report,
          debug: options.debug ?? report,
          ...(options.seat === undefined
            ? {}
            : { approvalsSeat: options.seat }),
          ...(options.approvalPolicy === undefined
            ? {}
            : { approvalPolicy: options.approvalPolicy }),
          ...(options.orchestrator === undefined
            ? {}
            : { orchestrator: options.orchestrator }),
          ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
          ...(options.sessionsRoot === undefined
            ? {}
            : { sessionsRoot: options.sessionsRoot }),
        });
        const code = await runCommand(
          { prompt: objective, session: options.sessionId },
          deps,
        );
        return code === 0
          ? { status: 'completed' }
          : {
              status: 'failed',
              detail: `the orchestrator run failed (exit ${code})`,
            };
      } catch (error) {
        return {
          status: 'failed',
          detail: error instanceof Error ? error.message : String(error),
        };
      }
    },
  };
}
