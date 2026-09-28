// `kubic policy --tool <name> [--json]` (issue #79; §58).
// A routing offer only: the command reports the enterprise allow/deny for
// one tool and enforces nothing, mutates nothing. The effective policy
// arrives injected (faux in tests); deny-by-default holds — a tool with no
// enterprise allow is denied.

import { answerHelp } from '../../../core/src/cli-help.js';
import { type FlagSpec, parseFlagArgs } from '../../../core/src/flags.js';
import {
  type EffectivePolicy,
  isToolAllowed,
  resolveEffectivePolicy,
} from './enterprise.js';
import { redactSecretShapes } from './secret-shapes.js';

export const POLICY_EXIT_OK = 0;
export const POLICY_EXIT_USAGE = 2;

export interface PolicyCommandDeps {
  resolvePolicy: () => EffectivePolicy | Promise<EffectivePolicy>;
  out: (line: string) => void;
}

// The effective policy for an installed allowlist (the tools a run's
// permission classes grant): allow exactly those, deny everything else.
export function policyFromInstalledAllowlist(
  allowlist: readonly string[],
): EffectivePolicy {
  return resolveEffectivePolicy([
    { layer: 'session', policy: { tools: { allow: [...allowlist] } } },
  ]).policy;
}

export const POLICY_USAGE = 'usage: kubic policy --tool <name> [--json]';

function usage(out: (line: string) => void): number {
  out(POLICY_USAGE);
  return POLICY_EXIT_USAGE;
}

// Issue #127: the shared parser replaces the hand-rolled loop. Missing
// values keep their line; unknown flags and stray operands keep the bare
// usage exit; the tool name's emptiness check stays this command's
// semantics.
const POLICY_FLAG_SPEC: readonly FlagSpec[] = [
  { name: '--json', takes: 'boolean' },
  { name: '--tool', takes: 'value' },
];

export async function runPolicyCommand(
  args: string[],
  deps: PolicyCommandDeps,
): Promise<number> {
  // `--help`/`-h` prints the usage line and exits 0 (issue #100).
  const help = answerHelp(args, deps.out, POLICY_USAGE);
  if (help !== null) return help;
  const flags = parseFlagArgs(args, POLICY_FLAG_SPEC);
  if (flags.missing.includes('--tool')) {
    deps.out('error: --tool needs a value');
    return usage(deps.out);
  }
  if (flags.unknown.length > 0 || flags.positional.length > 0) {
    return usage(deps.out);
  }
  const json = flags.values['--json'] === true;
  const toolRaw = flags.values['--tool'] as string | undefined;
  if (toolRaw === undefined) return usage(deps.out);
  const tool = toolRaw.trim();
  if (tool === '') {
    deps.out('error: --tool needs a non-empty value');
    return usage(deps.out);
  }
  const policy = await deps.resolvePolicy();
  const decision = isToolAllowed(policy, tool) ? 'allow' : 'deny';
  // Fail-closed echo: the tool name is free-form argv and may carry
  // secret-shaped material — the offer names the decision, never the secret.
  const safeTool = redactSecretShapes(tool);
  if (json) {
    deps.out(JSON.stringify({ tool: safeTool, decision }, null, 2));
    return POLICY_EXIT_OK;
  }
  deps.out(`${decision} ${safeTool}`);
  return POLICY_EXIT_OK;
}
