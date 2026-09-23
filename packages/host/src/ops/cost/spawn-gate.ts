// (4) subagent selection: spawn-only-needed gate (issue #56; §62 lever 4).
// A subagent spawns only when the work needs one AND concurrency admits it.
// Every denial carries a recorded reason. Pure, faux-only.

export interface SpawnGateInput {
  needed: boolean;
  running: number;
  maxConcurrency: number;
}

export type SpawnGateVerdict =
  | { admitted: true }
  | { admitted: false; reason: string };

export function gateSpawn(input: SpawnGateInput): SpawnGateVerdict {
  if (!input.needed) {
    return { admitted: false, reason: 'spawn denied: subagent not needed' };
  }
  if (input.running >= input.maxConcurrency) {
    return {
      admitted: false,
      reason: `spawn denied: concurrency full (${input.running}/${input.maxConcurrency})`,
    };
  }
  return { admitted: true };
}
