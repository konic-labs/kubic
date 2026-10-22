// The replicated state a presentation projector would produce, built
// directly: the app renders this state.
import type {
  KubicPresentationState,
  LaneSnapshot,
} from '@kubic/core/presentation';

export const SESSION = 'sess-1';

// The app renders replicated state, so a test builds the state a
// projector would produce (the projector itself lives in host).
export function presentation(
  over: Partial<LaneSnapshot> = {},
): KubicPresentationState {
  return {
    session: { sessionId: SESSION, approvalsSkipped: false },
    lane: {
      status: 'running',
      tools: [],
      queued: [],
      compacting: false,
      ...over,
    },
    approvals: [],
    usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 },
    connection: { status: 'connected' },
  };
}
