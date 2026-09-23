// Tool policy enforcement on the solo lane (issue #15, slice B; §40).
// Layer-1 shaping: allowlist the lane to the class-derived set and refuse
// contradictory configurations with named reasons, never silent.
import type {
  SOLO_DEFAULTS as _SoloDefaults,
  PermissionClasses,
} from '../../../agents/src/policy.js';
import { checkGrantable, toolsForClasses } from '../../../agents/src/policy.js';
import type { AgentHarness, AgentLane, Context } from '../pi-boundary.js';

export {
  PolicyValidationError,
  SOLO_DEFAULTS,
} from '../../../agents/src/policy.js';
export type { PermissionClasses };

export async function applyToolPolicy(
  harness: AgentHarness,
  lane: AgentLane,
  classes: PermissionClasses,
  context: Context,
): Promise<string[]> {
  const registered = await harness.getTools(context);
  const names = registered.map((tool: { name: string }) => tool.name);
  // Agreement (§40.3) is a role-time check: a declared tool set must not
  // contradict the classes. The solo lane always registers the full set
  // and narrows via allowlist, so here we enforce the grantable half —
  // classes must never demand a tool that is not registered.
  const grantable = checkGrantable(classes, names);
  if (!grantable.agree) {
    throw new PolicyRefusedError(grantable.reason);
  }
  const allowed = toolsForClasses(classes);
  await lane.setActiveTools(allowed, context);
  return allowed;
}

export class PolicyRefusedError extends Error {
  constructor(reason: string) {
    super(`tool policy refused: ${reason}`);
    this.name = 'PolicyRefusedError';
  }
}

export const _soloDefaultsMarker: typeof _SoloDefaults | undefined = undefined;
