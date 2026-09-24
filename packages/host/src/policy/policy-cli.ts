// `kubic policy --tool <name> [--json]` (issue #79; §58).
// A routing offer only: the command reports the enterprise allow/deny for
// one tool and enforces nothing, mutates nothing. The effective policy
// arrives injected (faux in tests); deny-by-default holds — a tool with no
// enterprise allow is denied.

import { type EffectivePolicy, isToolAllowed } from './enterprise.js';

export const POLICY_EXIT_OK = 0;
export const POLICY_EXIT_USAGE = 2;

export interface PolicyCommandDeps {
  resolvePolicy: () => EffectivePolicy | Promise<EffectivePolicy>;
  out: (line: string) => void;
}

function usage(out: (line: string) => void): number {
  out('usage: kubic policy --tool <name> [--json]');
  return POLICY_EXIT_USAGE;
}

export async function runPolicyCommand(
  args: string[],
  deps: PolicyCommandDeps,
): Promise<number> {
  let json = false;
  let tool: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--json') {
      json = true;
    } else if (arg === '--tool') {
      const value = args[i + 1];
      if (value === undefined || value.startsWith('--')) {
        deps.out('error: --tool needs a value');
        return usage(deps.out);
      }
      tool = value.trim();
      if (tool === '') {
        deps.out('error: --tool needs a non-empty value');
        return usage(deps.out);
      }
      i++;
    } else {
      return usage(deps.out);
    }
  }
  if (tool === undefined) return usage(deps.out);
  const policy = await deps.resolvePolicy();
  const decision = isToolAllowed(policy, tool) ? 'allow' : 'deny';
  if (json) {
    deps.out(JSON.stringify({ tool, decision }, null, 2));
    return POLICY_EXIT_OK;
  }
  deps.out(`${decision} ${tool}`);
  return POLICY_EXIT_OK;
}
