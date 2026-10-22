// `kubic policy --tool <name> [--json]`.
// A routing offer only: the command reports the enterprise allow/deny for
// one tool and enforces nothing, mutates nothing. The effective policy
// arrives injected (faux in tests); deny-by-default holds — a tool with no
// enterprise allow is denied.

import { describeUnsupported } from '@kubic/agent/permissions';
import {
  type CommandResult,
  EXIT_OK,
  EXIT_USAGE,
} from '@kubic/core/cli/exit-codes';
import { createLineLogger } from '@kubic/core/cli/logger';
import { formatJson } from '@kubic/core/cli/output';
import { type CliTheme, createCliTheme } from '@kubic/core/cli/theme';
import { redactSecretShapes } from '@kubic/core/secret-shapes';
import { isToolAllowed } from './gates.js';
import { resolveEffectivePolicy } from './resolve.js';
import type { EffectivePolicy } from './types.js';
import { normalizeToolName } from './validate.js';

// The parsed `kubic policy` options (commander's `opts()`). `command` names
// a subcommand (`explain`, `pull`, `sign`); without one, `tool` is the query,
// refused here when it is missing.
export interface PolicyOptions {
  readonly command?: 'explain' | 'pull' | 'sign';
  readonly tool?: string;
  readonly json?: boolean;
  // `sign`: the private key and the file it signs.
  readonly key?: string;
  readonly file?: string;
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
  // The installed classes' levels the tool set cannot
  // express. Each is named — a `warn:` line on stderr, or the `unsupported`
  // array in `--json` — so the decision never reads as a restriction the
  // lane does not enforce. Absent means none.
  unsupported?: () => readonly UnsupportedLevelView[];
}

interface UnsupportedLevelView {
  readonly class: string;
  readonly level: string;
  readonly enforcedAs: string;
  readonly reason: string;
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

// The policy a run from THIS workspace actually installs: the
// Enterprise/product/… policy INTERSECTED with the installed class
// allowlist. Denies and provenance survive; a tool the enterprise allows but
// the classes withhold is refused (and vice versa) — `kubic policy` never
// reports a tool the lane would not register.
export function policyWithInstalledAllowlist(
  policy: EffectivePolicy,
  allowlist: readonly string[],
): EffectivePolicy {
  const installed = new Set(allowlist.map(normalizeToolName));
  const allow =
    policy.tools.allow === undefined
      ? [...allowlist]
      : policy.tools.allow.filter((tool) =>
          installed.has(normalizeToolName(tool)),
        );
  return {
    ...policy,
    tools: {
      ...policy.tools,
      allow,
      // The installed allowlist is supplied as the session layer, so the
      // displayed source reads 'installed' unless a higher layer set allow.
      allowSource:
        policy.tools.allow === undefined ? 'session' : policy.tools.allowSource,
    },
  };
}

// The layer that decided the offer: an explicit deny first, then the allow
// list's own setter, then the engine default. 'session' is the projection's
// marker for the installed class allowlist, so it reads 'installed'.
function decisionSource(
  policy: EffectivePolicy,
  normalizedTool: string,
  decision: 'allow' | 'deny',
): string {
  const source =
    decision === 'allow'
      ? (policy.tools.allowSource ?? 'defaults')
      : (policy.tools.denySources[normalizedTool] ??
        policy.tools.allowSource ??
        'defaults');
  return source === 'session' ? 'installed' : source;
}

// `kubic policy` over parsed options: commander (apps/kubic/src/commands/
// analysis.ts) owns argv syntax — unknown flags, a missing value, the
// required --tool, `--help`; this handler owns the tool name's emptiness
// check and the decision.
export async function runPolicyCommand(
  options: PolicyOptions,
  deps: PolicyCommandDeps,
): Promise<CommandResult> {
  const json = options.json === true;
  const theme = json ? PLAIN : (deps.theme ?? PLAIN);
  const log = createLineLogger(deps.err, {
    theme: json ? PLAIN : (deps.errTheme ?? PLAIN),
  });
  if (options.tool === undefined) {
    log.error("required option '--tool <name>' not specified");
    return { exitCode: EXIT_USAGE };
  }
  const tool = options.tool.trim();
  if (tool === '') {
    log.error('--tool needs a non-empty value');
    return { exitCode: EXIT_USAGE };
  }
  const policy = await deps.resolvePolicy();
  const decision = isToolAllowed(policy, tool) ? 'allow' : 'deny';
  const source = decisionSource(policy, normalizeToolName(tool), decision);
  // Fail-closed echo: the tool name is free-form argv and may carry
  // secret-shaped material — the offer names the decision, never the secret.
  const safeTool = redactSecretShapes(tool);
  const unsupported = [...(deps.unsupported?.() ?? [])];
  if (json) {
    deps.out(
      formatJson({
        tool: safeTool,
        decision,
        source,
        ...(unsupported.length === 0 ? {} : { unsupported }),
      }),
    );
    return { exitCode: EXIT_OK };
  }
  for (const entry of unsupported) log.warn(describeUnsupported(entry));
  const word =
    decision === 'allow' ? theme.success(decision) : theme.error(decision);
  deps.out(`${word} ${safeTool} (${source})`);
  return { exitCode: EXIT_OK };
}
