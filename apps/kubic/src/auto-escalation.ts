// The single automatic escalation trigger: N
// consecutive tool-failure turns climb the lane one rung — once per run,
// never back. A pure state machine plus the reporting mappers; the boots
// own the climb itself (recordTurn on the TUI lane, where turns repeat —
// `kubic run` settles one turn per invocation, so the headless lane never
// reaches the threshold and carries no counter).

// "Repeated tool failure" made concrete: one failure is noise, five is a
// session nobody finishes — three is the streak that says the model, not
// the tools, is stuck. A named export, not config: the ladder and
// maxEscalations are config; the trigger threshold is fixed.
export const AUTO_ESCALATION_TOOL_FAILURES = 3;

// The execution failures that count: the tool ran (or was
// reached) and failed. tool_invalid_args is deliberately absent — bad
// arguments are the model's own defect, retryable by correction, never a
// reason to switch models. Everything else (model, provider, run limits,
// approval, context, aborts, completions) resets the streak.
const TOOL_FAILURE_CODES: ReadonlySet<string> = new Set([
  'tool_failed',
  'tool_timeout',
  'tool_unavailable',
]);

export interface AutoEscalationState {
  consecutiveToolFailures: number;
  autoClimbed: boolean;
}

export function createAutoEscalation(): AutoEscalationState {
  return { consecutiveToolFailures: 0, autoClimbed: false };
}

export function noteAutoEscalationTurn(
  state: AutoEscalationState,
  reason: string | undefined,
): void {
  if (reason !== undefined && TOOL_FAILURE_CODES.has(reason)) {
    state.consecutiveToolFailures += 1;
    return;
  }
  state.consecutiveToolFailures = 0;
}

export function shouldAutoEscalate(state: AutoEscalationState): boolean {
  return (
    !state.autoClimbed &&
    state.consecutiveToolFailures >= AUTO_ESCALATION_TOOL_FAILURES
  );
}

export function markAutoEscalated(state: AutoEscalationState): void {
  state.autoClimbed = true;
  state.consecutiveToolFailures = 0;
}

// An explicit (/model, /escalate) climb moves the streak's model out from
// under it: the count restarts on the new model, but the single auto slot
// is independent of explicit climbs (they share only the maxEscalations
// budget) and stays available.
export function resetAutoEscalation(state: AutoEscalationState): void {
  state.consecutiveToolFailures = 0;
}

// The rung above the live model, or undefined at the top (no climb to
// attempt) and off the ladder (never invent a target the ladder forbids).
export function nextLadderRung(
  steps: readonly string[],
  liveRef: string,
): string | undefined {
  const at = steps.indexOf(liveRef);
  if (at === -1) return undefined;
  return steps[at + 1];
}

export function formatEscalationRow(event: {
  from: string;
  to: string;
  reason: string;
}): string {
  return `escalation: ${event.from} → ${event.to} (${event.reason})`;
}

// The lane's ModelEscalationEvent onto the trajectory schema: the
// target model is required on write (the exporter refuses an unattributed
// escalation), the thinking level is unknown at record time and stays
// null — the trajectory's model.thinking already names the end state.
export function toTrajectoryEscalation(
  event: {
    reason: string;
    at: number;
    from: string;
    to: string;
  },
  thinking: string | null,
): {
  reason: string;
  at: string;
  fromModel: string;
  toModel: string;
  thinking: string | null;
} {
  return {
    reason: event.reason,
    at: new Date(event.at).toISOString(),
    fromModel: event.from,
    toModel: event.to,
    thinking,
  };
}
