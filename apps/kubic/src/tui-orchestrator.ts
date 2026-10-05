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
  MergeApprovalVerdict,
  OrchestrateCliOptions,
  OrchestrateCommandDeps,
} from '../../../packages/host/src/orchestrate-cli.js';
import { runOrchestrateCommand } from '../../../packages/host/src/orchestrate-cli.js';
import type { OrchestratorApprovalRequest } from '../../../packages/host/src/orchestrator/approvals/request.js';
import type { OrchestratorVerdict } from '../../../packages/host/src/orchestrator/approvals/routing.js';
import type {
  WorkerAskSeat,
  WorkerQuestionSeat,
} from '../../../packages/host/src/orchestrator/approvals/worker-asks.js';
import type { ApprovalSnapshot } from '../../../packages/host/src/orchestrator/merge/conflicts.js';
import type { EffectivePolicy } from '../../../packages/host/src/policy/enterprise.js';
import type { WorkerProjectionEvent } from '../../../packages/host/src/presentation/projector.js';
import type { RoleLayerInput } from '../../../packages/host/src/roles/resolver.js';
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
  // Issue #232: the seat the router consults gets the asker's AbortSignal and
  // withdraws the ask when it aborts.
  signal?: AbortSignal,
) => Promise<ApprovalVerdict | undefined>;

// The worker's ask, rendered by the TUI's approval overlay. The trigger IS
// the capability vocabulary (request.ts keeps the two in sync), the summary
// names the worker so the operator knows whose step is asking, and the full
// command rides through untouched — the dialog is where the decision is
// made on what will run.
export function workerAskSeatFromAnswer(answer: TuiAskSeat): WorkerAskSeat {
  return async (
    request: OrchestratorApprovalRequest,
    signal?: AbortSignal,
  ): Promise<OrchestratorVerdict> => {
    // Issue #409: the router's abort reaches the overlay, which withdraws
    // exactly this ask (the #232 withdrawal) when the bound expires.
    const decision = await answer(
      {
        key: request.key,
        capability: request.trigger,
        toolName: request.toolName,
        summary: `worker '${request.agentId}': ${request.summary}`,
        ...(request.command === undefined ? {} : { command: request.command }),
        justification: request.justification,
      },
      signal,
    );
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

// The merge gate's seat on the TUI's approval surface (issue #327). Without
// `--yes` the orchestrator asks per worker before it merges the worker's
// branch; the shipped decider is a readline over the raw stdin/stderr, which
// the TUI owns — the prompt would land in the alt-screen and closing it
// pauses stdin, killing input. This routes the same ask through the same
// answer seat a worker's ask uses, and a seat that answers nothing is not
// consent.
export function mergeSeatFromAnswer(
  answer: TuiAskSeat,
): NonNullable<OrchestrateRunOptions['mergeApproval']> {
  return async (input): Promise<MergeApprovalVerdict> => {
    const decision = await answer({
      key: `merge:${input.branch}`,
      capability: 'merge',
      toolName: 'merge',
      summary: `merge worker '${input.agentId}' (${input.branch}) into your working branch`,
    });
    return decision?.approved === true
      ? { verdict: 'approve' }
      : { verdict: 'deny' };
  };
}

// The merge gate a TUI run falls to when no seat is wired: closed. The stdio
// readline is never an option under the TUI (issue #327).
const denyMergeClosed: NonNullable<
  OrchestrateRunOptions['mergeApproval']
> = async (): Promise<MergeApprovalVerdict> => ({ verdict: 'deny' });

export interface ProdTuiOrchestratorOptions {
  // The TUI session. Each turn's orchestrator session is derived from it
  // (`<sessionId>-o<stamp>`) — worktree scoping and run state key on that.
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
  // The merge gate's seat (`mergeSeatFromAnswer` over the TUI's approval
  // surface). Absent means every merge denies closed — never the readline.
  mergeSeat?: NonNullable<OrchestrateRunOptions['mergeApproval']>;
  // The TUI's per-root project-trust check (issue #228, §35.1): the store's
  // decision for an exact directory plus the env opt-in. The run evaluates
  // it for the models root it loads, so a `kubic trust` grant for a
  // subdirectory never stands in for the repo root's. Absent leaves the run's
  // own default (the env opt-in only).
  projectTrust?: (path: string) => boolean;
  // The clock the per-turn orchestrator session stamp derives from. Test
  // seam; defaults to `Date.now`.
  now?: () => number;
  // The manager lane's approval snapshot (delegated conflict resolvers).
  approvalPolicy?: ApprovalSnapshot;
  // The §58 enterprise policy (issue #288): the same object `kubic
  // orchestrate` hands the manager, which refuses (`role_refused`) an
  // assignment whose role declares a denied tool before anything spawns.
  toolPolicy?: EffectivePolicy;
  // The config `[roles.<name>]` layers, so a role is judged as the worker's
  // own `kubic run --role` resolves it.
  roleLayers?: RoleLayerInput[];
  // A frozen enterprise `[model]` is the effective pin (issue #295; §35.1):
  // every worker runs it whatever KUBIC_MODEL says. It outranks
  // `currentModel`.
  frozenModel?: { provider: string; id: string };
  // The lane's CURRENT model (issue #202): read per turn, so a `/model`
  // switch becomes the delegation's `parentModel` and TUI workers inherit
  // the model the session is actually running — the same §38.1 level
  // `kubic orchestrate` passes from its own resolved pin. Absent means no
  // pin (workers keep their own selection default).
  currentModel?: () =>
    | Promise<{ provider: string; id: string } | undefined>
    | { provider: string; id: string }
    | undefined;
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
// orphan reconciliation) — and a session that never toggles into
// orchestrator mode pays nothing.
//
// Every turn is its OWN orchestrator session (issue #327): worktrees and
// branches (`kubic/<session>/<agent>`) are retained after a run, so reusing
// the TUI session id for a second delegation would fail closed on the first
// turn's retained `worker-1` (`worktree_exists`). The id is the TUI session
// plus a base-36 millisecond stamp, forced strictly increasing within the
// process; the wall clock keeps a later process — `--resume` of the TUI
// session — clear of every id an earlier one minted, without persisting a
// counter. `kubic clean` lists them under their own names.
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
  const now = options.now ?? Date.now;
  let lastStamp = 0;
  // Issue #342: the orchestrator view's feed — one listener, registered by
  // the TUI loop; every turn's workers report through it.
  let onWorker: ((event: WorkerProjectionEvent) => void) | undefined;
  // Issue #154: the late-bound question seat (the app's dialog).
  let questionSeat: WorkerQuestionSeat | undefined;
  const nextSessionId = (): string => {
    lastStamp = Math.max(now(), lastStamp + 1);
    return `${options.sessionId}-o${lastStamp.toString(36)}`;
  };
  return {
    watchWorkers(listener) {
      onWorker = listener;
    },
    setQuestionSeat(seat) {
      questionSeat = seat;
    },
    async run(objective, onReport): Promise<TuiTurnOutcome> {
      sink = onReport ?? options.out;
      try {
        // The model the workers inherit: the frozen enterprise pin when one
        // is in force, else the lane's current model (issue #202) — read per
        // turn, so a `/model` switch reaches the next delegation.
        const currentModel =
          options.frozenModel ?? (await options.currentModel?.());
        const deps = await createDeps({
          out: report,
          err: options.err ?? report,
          debug: options.debug ?? report,
          ...(options.seat === undefined
            ? {}
            : { approvalsSeat: options.seat }),
          // Issue #154: worker questions reach the TUI dialog; with no seat
          // bound yet they go unanswered (the worker's bound names them).
          questionSeat: (question, signal) =>
            questionSeat === undefined
              ? Promise.resolve(undefined)
              : questionSeat(question, signal),
          mergeApproval: options.mergeSeat ?? denyMergeClosed,
          // No `--yes` in the TUI: a merge refusal must not name it.
          yesHint: false,
          ...(options.projectTrust === undefined
            ? {}
            : { projectTrust: options.projectTrust }),
          ...(options.approvalPolicy === undefined
            ? {}
            : { approvalPolicy: options.approvalPolicy }),
          ...(options.toolPolicy === undefined
            ? {}
            : { toolPolicy: options.toolPolicy }),
          ...(options.roleLayers === undefined
            ? {}
            : { roleLayers: options.roleLayers }),
          ...(currentModel === undefined
            ? {}
            : {
                model: currentModel,
                ...(options.frozenModel === undefined
                  ? {}
                  : { modelPinFrozen: true }),
              }),
          ...(options.orchestrator === undefined
            ? {}
            : { orchestrator: options.orchestrator }),
          ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
          ...(options.sessionsRoot === undefined
            ? {}
            : { sessionsRoot: options.sessionsRoot }),
        });
        const code = await runCommand(
          { prompt: objective, session: nextSessionId() },
          observeWorkers(deps, (event) => onWorker?.(event)),
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

// Issue #342 (§18): wraps the run's `runWorker` so each worker reports its
// start (role, worktree, model, generation — a replacement of the same agent
// is the next generation) and its end (the result's status and spend), the
// facts the orchestrator view renders. The run itself is untouched.
export function observeWorkers(
  deps: OrchestrateCommandDeps,
  emit: (event: WorkerProjectionEvent) => void,
): OrchestrateCommandDeps {
  const generations = new Map<string, number>();
  const runWorker = deps.runWorker;
  return {
    ...deps,
    runWorker: async (agentId, worktree, prompt, info) => {
      const generation = (generations.get(agentId) ?? 0) + 1;
      generations.set(agentId, generation);
      emit({
        type: 'worker-start',
        workerId: agentId,
        status: 'running',
        generation,
        workspace: worktree.path,
        ...(info?.role === undefined ? {} : { role: info.role }),
        ...(info?.modelRef === undefined ? {} : { model: info.modelRef }),
      });
      try {
        const output = await runWorker(agentId, worktree, prompt, info);
        const result = Array.isArray(output) ? undefined : output.result;
        emit({
          type: 'worker-update',
          workerId: agentId,
          status: result?.status ?? 'completed',
          ...(result === undefined
            ? {}
            : {
                inputTokens: result.metrics.inputTokens,
                outputTokens: result.metrics.outputTokens,
                ...(result.metrics.costUsd === undefined
                  ? {}
                  : { costUsd: result.metrics.costUsd }),
              }),
        });
        return output;
      } catch (error) {
        emit({ type: 'worker-update', workerId: agentId, status: 'failed' });
        throw error;
      }
    },
  };
}
