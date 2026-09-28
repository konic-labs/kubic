// `kubic policy --tool <name> [--json]` (issue #79; §58).
// A routing offer only: the command reports the enterprise allow/deny for
// one tool and enforces nothing, mutates nothing. The effective policy
// arrives injected (faux in tests); deny-by-default holds — a tool with no
// enterprise allow is denied.

import { EXIT_OK, EXIT_USAGE } from '../../../core/src/cli/exit-codes.js';
import { createLineLogger } from '../../../core/src/cli/logger.js';
import { formatJson } from '../../../core/src/cli/output.js';
import { type CliTheme, createCliTheme } from '../../../core/src/cli/theme.js';
import {
  type EffectivePolicy,
  isToolAllowed,
  resolveEffectivePolicy,
} from './enterprise.js';
import { redactSecretShapes } from './secret-shapes.js';

// The parsed `kubic policy` options (commander's `opts()`); `tool` is a
// required option there, still checked here for direct callers.
export interface PolicyOptions {
  readonly tool?: string;
  readonly json?: boolean;
}

export interface PolicyCommandDeps {
  resolvePolicy: () => EffectivePolicy | Promise<EffectivePolicy>;
  // stdout: the decision line or the one `--json` document.
  out: (line: string) => void;
  // stderr: diagnostics, one `error: …` line each (core/cli/logger).
  err: (line: string) => void;
  // Colours the decision word; absent means plain.
  theme?: CliTheme;
  // Colour of the stderr diagnostics, from stderr's own TTY state (never
  // stdout's); absent means plain.
  errTheme?: CliTheme;
}

const PLAIN = createCliTheme('none');

// The effective policy for an installed allowlist (the tools a run's
// permission classes grant): allow exactly those, deny everything else.
export function policyFromInstalledAllowlist(
  allowlist: readonly string[],
): EffectivePolicy {
  return resolveEffectivePolicy([
    { layer: 'session', policy: { tools: { allow: [...allowlist] } } },
  ]).policy;
}

// `kubic policy` over parsed options: commander (apps/kubic/src/commands/
// analysis.ts) owns argv syntax — unknown flags, a missing value, the
// required --tool, `--help`; this handler owns the tool name's emptiness
// check and the decision.
export async function runPolicyCommand(
  options: PolicyOptions,
  deps: PolicyCommandDeps,
): Promise<number> {
  const json = options.json === true;
  const theme = json ? PLAIN : (deps.theme ?? PLAIN);
  const log = createLineLogger(deps.err, {
    theme: json ? PLAIN : (deps.errTheme ?? PLAIN),
  });
  if (options.tool === undefined) {
    log.error("required option '--tool <name>' not specified");
    return EXIT_USAGE;
  }
  const tool = options.tool.trim();
  if (tool === '') {
    log.error('--tool needs a non-empty value');
    return EXIT_USAGE;
  }
  const policy = await deps.resolvePolicy();
  const decision = isToolAllowed(policy, tool) ? 'allow' : 'deny';
  // Fail-closed echo: the tool name is free-form argv and may carry
  // secret-shaped material — the offer names the decision, never the secret.
  const safeTool = redactSecretShapes(tool);
  if (json) {
    deps.out(formatJson({ tool: safeTool, decision }));
    return EXIT_OK;
  }
  const word =
    decision === 'allow' ? theme.success(decision) : theme.error(decision);
  deps.out(`${word} ${safeTool}`);
  return EXIT_OK;
}
