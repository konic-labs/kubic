// Command dispatch seam for the kubic CLI (issue #135): the routing table
// `main()` used to hold inline — which command runs which runner, which
// exit code a refused config yields, and the front-door special cases
// (help, version, the contract crash probe, the usage fallthrough). The
// runners arrive injected (production wiring: ./prod-runners.js), so this
// module holds no lanes, no fs and no process state of its own — the
// routing is exercised directly by dispatch.test.ts.
//
// Behavior-identical by construction: every branch is the moved `main()`
// branch with the inline production object replaced by its injected
// runner, and the check order (config load → refusal → runtime exclude →
// help → version → crash probe → commands → usage) is the moved order.

import {
  HELP_EXIT_OK,
  HELP_FLAGS,
} from '../../../packages/core/src/cli-help.js';
import { formatVersionLine } from '../../../packages/core/src/license.js';
import {
  type CliConfigResult,
  configRefusalExit,
  runtimeExcludeEntriesFor,
} from './config-runtime.js';

// The root dispatcher's usage line (issue #128): one string, printed by
// `--help`/`-h` (exit 0 — a help request is a successful invocation) and by
// the bare/unknown-command fallthrough (exit 1 — usage-on-no-args is the
// deliberate POSIX posture). Both exits are pinned by
// scripts/binary-contract.mjs; the two paths must never drift apart.
export const ROOT_USAGE =
  'usage: kubic <sessions | git | models | diff | undo | log | status | run | orchestrate | clean | tui | doctor | config | workers | eval | benchmark | replay | export | cost | perf | policy | audit>';

// One runner per command in the if-chain. `rest` is the argv after the
// command name — journal commands receive `[command, ...rest]`, exactly
// the argv the root passed before the extraction; `config` is the one
// process-wide config load, so every runner that needs the effective
// configuration reads the same result the refusal gate saw.
export type CommandRunner = (
  rest: readonly string[],
  config: CliConfigResult,
) => number | Promise<number>;

export interface DispatchRunners {
  readonly sessions: CommandRunner;
  readonly git: CommandRunner;
  readonly journal: CommandRunner;
  readonly models: CommandRunner;
  readonly run: CommandRunner;
  readonly tui: CommandRunner;
  readonly doctor: CommandRunner;
  readonly orchestrate: CommandRunner;
  readonly clean: CommandRunner;
  readonly cost: CommandRunner;
  readonly perf: CommandRunner;
  readonly policy: CommandRunner;
  readonly config: CommandRunner;
  readonly audit: CommandRunner;
  readonly workers: CommandRunner;
  readonly eval: CommandRunner;
  readonly benchmark: CommandRunner;
  readonly replay: CommandRunner;
  readonly export: CommandRunner;
}

export interface DispatchDeps {
  // The process's stdout channel (console.log in prod): the usage lines,
  // the refusal reason, and the version line all print through it.
  readonly out: (line: string) => void;
  // One config load for the whole process, injected so the dispatch can be
  // exercised over loaded and refused results alike.
  readonly loadConfig: () => CliConfigResult;
  // The version half of `--version` (the license half is core's): the root
  // reads this app's manifest through the exec FileBridge.
  readonly version: () => string;
  // `.kubic/` runtime ignore rules (issue #91), shipped before the modes
  // that create runtime state; injected because it touches the repo. The
  // entries are derived from the loaded config (issue #133): a configured
  // `[orchestrator].root` joins the shipped prefixes, so the worktree parent
  // never dirties the tree the run merges into.
  readonly ensureRuntimeExclude: (entries: readonly string[]) => void;
  readonly runners: DispatchRunners;
}

export async function dispatchCommand(
  command: string | undefined,
  rest: readonly string[],
  deps: DispatchDeps,
): Promise<number> {
  // Issue #90 (design §35.1): one config load for the whole process — paths
  // per §35.1, the project layer behind the trust gate, documented env
  // overrides, fail-closed on unknown/unsupported keys, budget keys and
  // secret refs. Commands below consume it through the injected runners;
  // nothing here re-derives a default by hand.
  const cliConfig = deps.loadConfig();
  // A refused config stops the agent-executing modes: they may not run on
  // built-in defaults while the user believes their config file is in force.
  // `config` and `doctor` still run so the named reason can be reported.
  const refusalExit = configRefusalExit(cliConfig, command);
  if (refusalExit !== undefined) {
    deps.out(`error: ${cliConfig.error ?? 'config refused'}`);
    return refusalExit;
  }
  // Issue #91 (design §35, D34/D35): `.kubic/` runtime state must never
  // reach a user repo's commit path. Before either mode that creates it,
  // ship the runtime ignore rules into the repo-local exclude file
  // (idempotent, fail-open, never dirties a committed .gitignore) — so the
  // first run/orchestrate leaves `git status` clean while `.kubic/roles`
  // and `config.toml` stay trackable. Skipped outside a git repo.
  if (command === 'run' || command === 'orchestrate' || command === 'tui') {
    deps.ensureRuntimeExclude(
      runtimeExcludeEntriesFor(cliConfig.runtime?.orchestrator.root),
    );
  }
  // Root-level help (issue #128): the #100 convention — one implementation in
  // core/cli-help.ts, applied before argv validation — reaches the dispatcher
  // too. Same line as the bare fallthrough below; only the exit code differs.
  if (HELP_FLAGS.includes(command ?? '')) {
    deps.out(ROOT_USAGE);
    return HELP_EXIT_OK;
  }
  if (command === '--version' || command === '-V') {
    deps.out(formatVersionLine(deps.version()));
    return 0;
  }
  // Deliberate failure seam for the shipped-artifact contract (issue #128):
  // `kubic __crash-probe` throws a plain Error so the top-level catch-all's
  // `error: <message>` / KUBIC_DEBUG behavior is asserted end to end against
  // the real binary by scripts/binary-contract.mjs. Internal — not a
  // supported command, deliberately absent from ROOT_USAGE, and gated on the
  // contract's own env var (named like __KUBIC_CONTRACT_NODE_STUB) so
  // arbitrary user argv cannot reach it: without the gate the command falls
  // through to the unknown-command path below.
  if (
    command === '__crash-probe' &&
    process.env.__KUBIC_CONTRACT_CRASH_PROBE === '1'
  ) {
    throw new Error('injected probe failure');
  }
  if (command === 'sessions') {
    return deps.runners.sessions(rest, cliConfig);
  }
  if (command === 'git') {
    return deps.runners.git(rest, cliConfig);
  }
  if (
    command === 'diff' ||
    command === 'undo' ||
    command === 'log' ||
    command === 'status'
  ) {
    return deps.runners.journal([command, ...rest], cliConfig);
  }
  if (command === 'models') {
    return deps.runners.models(rest, cliConfig);
  }
  if (command === 'run') {
    return deps.runners.run(rest, cliConfig);
  }
  if (command === 'tui') {
    return deps.runners.tui(rest, cliConfig);
  }
  if (command === 'doctor') {
    return deps.runners.doctor(rest, cliConfig);
  }
  if (command === 'orchestrate') {
    return deps.runners.orchestrate(rest, cliConfig);
  }
  if (command === 'clean') {
    return deps.runners.clean(rest, cliConfig);
  }
  if (command === 'cost') {
    return deps.runners.cost(rest, cliConfig);
  }
  if (command === 'perf') {
    return deps.runners.perf(rest, cliConfig);
  }
  if (command === 'policy') {
    return deps.runners.policy(rest, cliConfig);
  }
  if (command === 'config') {
    return deps.runners.config(rest, cliConfig);
  }
  if (command === 'audit') {
    return deps.runners.audit(rest, cliConfig);
  }
  if (command === 'workers') {
    const code = await deps.runners.workers(rest, cliConfig);
    // runWorkersCommand reports usage as 1; the binary surfaces §78
    // usage errors as 2 (issue #77).
    return code === 1 ? 2 : code;
  }
  if (command === 'eval') {
    return deps.runners.eval(rest, cliConfig);
  }
  if (command === 'benchmark') {
    return deps.runners.benchmark(rest, cliConfig);
  }
  if (command === 'replay') {
    return deps.runners.replay(rest, cliConfig);
  }
  if (command === 'export') {
    return deps.runners.export(rest, cliConfig);
  }
  deps.out(ROOT_USAGE);
  return 1;
}
