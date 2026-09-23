// (7) escalation discipline (issue #56; §62 lever 7).
// Escalation is one-way and recorded: a step up the ladder appends a
// {from, to, reason, at} record. De-escalation is refused on the same
// ladder — a cheaper model needs a new agent/session. Value rule: three
// cheap failures cost more than one expensive win, so cheap-3x-fail
// escalates. Pure, faux-only.

export interface CostEscalationRecord {
  from: string;
  to: string;
  reason: string;
  at: number;
}

export interface CostLadder {
  readonly steps: readonly string[];
  readonly record: readonly CostEscalationRecord[];
}

export class CostEscalationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CostEscalationError';
  }
}

export function createCostLadder(steps: string[]): CostLadder {
  if (steps.length === 0) {
    throw new CostEscalationError('cost ladder must not be empty');
  }
  return {
    steps: Object.freeze([...steps]),
    record: Object.freeze([] as CostEscalationRecord[]),
  };
}

export function escalateCost(
  ladder: CostLadder,
  from: string,
  to: string,
  reason: string,
): { to: string } {
  const fromAt = ladder.steps.indexOf(from);
  const toAt = ladder.steps.indexOf(to);
  if (fromAt === -1 || toAt === -1) {
    throw new CostEscalationError(
      `escalation off-ladder refused ('${from}' → '${to}'): steps are ${ladder.steps.join(' < ')}`,
    );
  }
  if (toAt <= fromAt) {
    throw new CostEscalationError(
      `escalation is one-way ('${from}' → '${to}' refused): de-escalation needs a new agent/session`,
    );
  }
  const entry: CostEscalationRecord = { from, to, reason, at: Date.now() };
  (ladder as { record: readonly CostEscalationRecord[] }).record =
    Object.freeze([...ladder.record, entry]);
  return { to };
}

export function requiresFreshSessionForDeescalation(): boolean {
  return true;
}

export function compareEscalationValue(input: {
  cheapFails: number;
  cheapCost: number;
  expensiveWinCost: number;
}): 'escalate' | 'stay' {
  // Three cheap failures escalate on their own: cheapBurn is
  // cheapFails * cheapCost, so comparing the burn against 3x the cheap
  // cost restates the count check. Keep the count check only.
  if (input.cheapFails >= 3) return 'escalate';
  const cheapBurn = input.cheapFails * input.cheapCost;
  if (cheapBurn >= input.expensiveWinCost) return 'escalate';
  return 'stay';
}
