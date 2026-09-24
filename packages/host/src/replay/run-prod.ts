// Prod replay re-execution runner (issue #78): the composition root's
// `ReplayRunRequest` handler for the deterministic/live tiers. The
// recorded objective is re-run through the injected lane prompt runner
// (the binary's standard lane path — the same one `kubic run` drives);
// the settled lane terminus is mapped into replay's §78 subset
// (0/1/2/5/6): the four known termini pass through, anything coarser
// (budget/approval/usage) coarsens to failed with the summary preserved
// — the envelope still says exactly why the re-execution did not
// complete. A throwing lane maps to failed (never a rejection past the
// CLI), and an empty objective is refused before the lane is touched.
import type { TrajectoryExport } from '../../../trajectory/src/schema.js';
import type {
  ReplayRunRequest,
  ReplayRunResult,
  ReplayRunTerminus,
} from './replay.js';

export interface LanePromptOutcome {
  terminus: string;
  summary: string;
}

export interface ProdReplayRunDeps {
  loadTrajectory: (path: string) => TrajectoryExport;
  runPrompt: (prompt: string, model: string) => Promise<LanePromptOutcome>;
}

function mapTerminus(terminus: string): ReplayRunTerminus {
  switch (terminus) {
    case 'completed':
    case 'failed':
    case 'workspace_unavailable':
    case 'provider_probe_failed':
      return terminus;
    default:
      return 'failed';
  }
}

export function createProdReplayRun(
  deps: ProdReplayRunDeps,
): (request: ReplayRunRequest) => Promise<ReplayRunResult> {
  return async (request: ReplayRunRequest): Promise<ReplayRunResult> => {
    const trajectory = deps.loadTrajectory(request.trajectory);
    const objective = trajectory.task.objective.trim();
    if (objective === '') {
      return {
        terminus: 'failed',
        summary:
          'trajectory carries no task objective — refusing an empty re-execution',
      };
    }
    let outcome: LanePromptOutcome;
    try {
      outcome = await deps.runPrompt(objective, request.model);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { terminus: 'failed', summary: message };
    }
    return {
      terminus: mapTerminus(outcome.terminus),
      summary: outcome.summary,
    };
  };
}
