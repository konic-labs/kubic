// Tool policy enforcement on the lane.
// Layer-1 shaping: allowlist the conversation to the class-derived set and
// refuse contradictory configurations with named reasons, never silent.
//
// Pi 1.0: the lane is a root conversation, so the allowlist is
// a `conversation.configure({ tools: [...] })` — pi-durable stores tool
// NAMES from the registration objects, and an array offers exactly those.

import type { PermissionClasses } from '../permissions.js';
import {
  checkAgreement,
  checkGrantable,
  toolsForClasses,
  validateClasses,
} from '../permissions.js';
import type {
  Context,
  Conversation,
  Registry,
  ToolRegistration,
} from '../pi-boundary.js';

export type { PermissionClasses };

// Name → registration lookup over the live registry: pi-durable's
// configure() takes ToolRegistration objects and stores their names, so
// every name-based allowlist is mapped here. Names the registry does not
// offer are dropped (the harness drops them anyway); the boot filters its
// prompt `tools:` line to the same set, so the model is never told about a
// tool it cannot call.
export function toolsForNames(
  registry: Registry,
  names: readonly string[],
): ToolRegistration[] {
  const byName = new Map<string, ToolRegistration>();
  for (const { tool } of registry.snapshot().tools()) {
    byName.set(tool.name, tool);
  }
  const found: ToolRegistration[] = [];
  for (const name of names) {
    const tool = byName.get(name);
    if (tool !== undefined) found.push(tool);
  }
  return found;
}

export async function applyToolPolicy(
  registry: Registry,
  conversation: Conversation,
  classes: PermissionClasses,
  context: Context,
): Promise<string[]> {
  // validateClasses runs here (not just at the config edge) so unvalidated
  // objects reaching the lane are still rejected with named reasons, and
  // partial inputs merge over DEFAULT_PERMISSIONS.
  const valid = validateClasses({ ...classes });
  const registered = registry
    .snapshot()
    .tools()
    .map(({ tool }) => tool.name);
  // Agreement is a role-time check: a declared tool set must not
  // contradict the classes. The lane always registers the full set
  // and narrows via configure(), so here we enforce the grantable half —
  // classes must never demand a tool that is not registered.
  const grantable = checkGrantable(valid, registered);
  if (!grantable.agree) {
    throw new PolicyRefusedError(grantable.reason);
  }
  const allowed = toolsForClasses(valid);
  // Invariant pin: the derived allowlist must agree with the classes it
  // was derived from. Tautological today, load-bearing the day someone
  // edits toolsForClasses without updating the agreement rules.
  const agreement = checkAgreement(valid, allowed);
  if (!agreement.agree) {
    throw new PolicyRefusedError(agreement.reason);
  }
  await conversation.configure(
    { tools: toolsForNames(registry, allowed) },
    context,
  );
  return allowed;
}

export class PolicyRefusedError extends Error {
  constructor(reason: string) {
    super(`tool policy refused: ${reason}`);
    this.name = 'PolicyRefusedError';
  }
}
