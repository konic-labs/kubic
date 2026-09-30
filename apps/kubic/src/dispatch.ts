// Command dispatch seam for the kubic CLI (issue #135): the routing table
// `main()` used to hold inline — which command runs which runner, which
// exit code a refused config yields, and the front-door special cases
// (help, version, the contract crash probe, the usage fallthrough). The
// runners arrive injected (production wiring: ./prod-runners.js), so this
// module holds no lanes, no fs and no process state of its own — the
// routing is exercised directly by dispatch.test.ts.
//
// Routing is commander (./cli/program.ts): each command group registers
// itself from its own module under ./commands/ (docs/contributing-cli.md).
// The check order is unchanged: config load → refusal → runtime exclude →
// usage fallthrough → commander (help, version, crash probe, commands).

import { formatVersionLine } from '../../../packages/core/src/license.js';
import {
  type ModelSelection,
  parseModelFlag,
} from '../../../packages/worker/src/model-select.js';
import type {
  CommandContext,
  CommandRegistrar,
  DispatchRunners,
} from './cli/context.js';
import { createKubicProgram, runKubicProgram } from './cli/program.js';
import { registerAnalysisCommands } from './commands/analysis.js';
import { registerJournalCommands } from './commands/journal.js';
import { registerOrchestratorCommands } from './commands/orchestrator.js';
import { registerSoloCommands } from './commands/solo.js';
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
  'usage: kubic <sessions | git | models | diff | undo | log | status | run | orchestrate | clean | tui | doctor | config | trust | workers | eval | benchmark | replay | export | cost | perf | policy | audit>';

// The supported command names, read off the usage line so the routing
// table and the listing can never drift apart (dispatch.test.ts also pins
// that the registered commander commands are exactly these).
export const COMMAND_NAMES: ReadonlySet<string> = new Set(
  ROOT_USAGE.slice(
    ROOT_USAGE.indexOf('<') + 1,
    ROOT_USAGE.lastIndexOf('>'),
  ).split(' | '),
);

// The modes that create `.kubic/` runtime state (issue #91).
const STATE_CREATING_COMMANDS: ReadonlySet<string> = new Set([
  'run',
  'orchestrate',
  'tui',
]);

// The interactive lane whose boot asks the project-trust question (issue
// #228): the explicit `tui` command and the bare invocation it becomes.
const INTERACTIVE_TRUST_COMMANDS: ReadonlySet<string> = new Set(['tui']);

// A help request must never block on a question (issue #228): commander
// answers `--help`/`-h` after this point, so the trust prompt is skipped
// when the invocation is asking for usage rather than booting the lane.
const HELP_TOKENS: ReadonlySet<string> = new Set(['--help', '-h']);

// The contract's internal failure seam (issue #128), never listed.
const CRASH_PROBE = '__crash-probe';

// Root options commander answers before any command name.
const ROOT_OPTIONS: ReadonlySet<string> = new Set([
  '--help',
  '-h',
  '--version',
  '-V',
]);

// Runner and registry types live with the command registry (./cli/context.ts);
// re-exported here because the dispatch seam is what callers wire.
export type { CommandRunner, DispatchRunners } from './cli/context.js';

// Issue #227 (§38.1): commands whose `--model <provider/id>` is the `cli`
// config layer. The flag is an input to the ONE config load dispatch
// performs before commander runs, so it is read from the raw argv here.
const CLI_MODEL_COMMANDS: ReadonlySet<string> = new Set([
  'run',
  'tui',
  'config',
]);

function tryParseCliModel(value: string): ModelSelection | undefined {
  try {
    return parseModelFlag(value);
  } catch {
    return undefined;
  }
}

// Read the session model override exactly once, from the raw argv, for the
// commands that own the flag. A `--` ends the scan (the rest are operands);
// only well-formed `provider/id` values are forwarded — a malformed one is
// left to commander, whose own option rule refuses it with exit 2 before any
// runner runs. Later occurrences win, matching commander's repetition
// behaviour, so the load sees the same value the parser will.
export function cliModelFromArgs(
  command: string | undefined,
  rest: readonly string[],
): ModelSelection | undefined {
  if (command === undefined || !CLI_MODEL_COMMANDS.has(command)) {
    return undefined;
  }
  let found: ModelSelection | undefined;
  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index] as string;
    if (token === '--') break;
    if (token === '--model') {
      const value = rest[index + 1];
      if (value !== undefined) {
        const parsed = tryParseCliModel(value);
        if (parsed !== undefined) found = parsed;
      }
      continue;
    }
    if (token.startsWith('--model=')) {
      const parsed = tryParseCliModel(token.slice('--model='.length));
      if (parsed !== undefined) found = parsed;
    }
  }
  return found;
}

// Every command module registers its own commander commands, so parallel
// command migrations never edit the same file.
const REGISTRARS: readonly CommandRegistrar[] = [
  registerSoloCommands,
  registerOrchestratorCommands,
  registerJournalCommands,
  registerAnalysisCommands,
];

export interface DispatchDeps {
  // The process's stdout channel (console.log in prod): the usage lines
  // and the version line print through it.
  readonly out: (line: string) => void;
  // The stderr channel (console.error in prod): commander's one-line parse
  // errors, the config refusal, and `error: …` lines from
  // CliUsageError/CliExitError. Absent
  // means stdout (the fakes in dispatch.test.ts capture one channel).
  readonly err?: (line: string) => void;
  // One config load for the whole process, injected so the dispatch can be
  // exercised over loaded and refused results alike. The `cli` model input
  // (issue #227) and the interactive trust decision (issue #228) are inputs
  // to the same load — never a post-load patch.
  readonly loadConfig: (options?: {
    model?: ModelSelection;
    projectTrusted?: boolean;
  }) => CliConfigResult;
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
  // §78/§80 "interactive by default": true when stdin AND stdout are a TTY.
  // Only consulted for the bare invocation; absent means non-interactive.
  readonly isInteractive?: () => boolean;
  // Issue #228 (§35.1): the interactive trust question for `kubic tui` / the
  // bare interactive invocation, run once BEFORE the config load. `undefined`
  // means "nothing to ask" (no project config, or a decision already
  // recorded); true/false is the effective decision threaded into the load.
  // Absent means the path asks nobody — a non-TTY caller keeps the refusal.
  readonly resolveProjectTrust?: () => Promise<boolean | undefined>;
}

const BARE_SKIP_FLAG = '--dangerously-skip-approvals';
// Issue #327: `kubic --orchestrator` is the bare invocation's explicit
// orchestrator entry — on a TTY it is `kubic tui --orchestrator`; off a TTY
// it keeps the bare usage + exit 1 posture like the other bare flags.
const BARE_ORCHESTRATOR_FLAG = '--orchestrator';

export async function dispatchCommand(
  requested: string | undefined,
  rest: readonly string[],
  deps: DispatchDeps,
): Promise<number> {
  // §78/§80: a bare `kubic` on an interactive terminal IS `kubic tui` — the
  // same refusal gate, runtime-exclude shipping and runner. Off a TTY (a
  // pipe, CI, a script) the bare invocation keeps the POSIX usage + exit 1
  // posture pinned by scripts/binary-contract.mjs.
  // Issue #295: `kubic --model <provider/id>` on a TTY is
  // `kubic tui --model …` — the bare form takes the TUI's model pin too.
  // Issue #308 (§41.4, §78): `kubic --dangerously-skip-approvals` is the
  // bare invocation with the session-scoped full-access flag — on a TTY it is
  // `kubic tui --dangerously-skip-approvals`; off a TTY it keeps the bare
  // usage + exit 1 posture.
  const interactive = deps.isInteractive?.() === true;
  const bareModel =
    requested !== undefined &&
    (requested === '--model' || requested.startsWith('--model=')) &&
    interactive;
  const bareSkip = requested === BARE_SKIP_FLAG && interactive;
  const bareOrchestrator = requested === BARE_ORCHESTRATOR_FLAG && interactive;
  // One bare-flag form of the TUI: every bare flag is `kubic tui <flag>` on
  // a terminal (and keeps the usage + exit 1 posture off one).
  const bareFlag = bareSkip || bareModel || bareOrchestrator;
  const command =
    (requested === undefined && interactive) || bareFlag ? 'tui' : requested;
  const args = bareFlag ? [String(requested), ...rest] : rest;
  // Issue #228 (§35.1): the interactive trust gate runs BEFORE the one
  // process-wide config load. Only the interactive TUI path asks; the
  // resolver persists the answer and this same invocation loads on it, so
  // the lane either boots trusted or stops on the ordinary refusal — whose
  // message names `kubic trust` and KUBIC_TRUST_PROJECT=1.
  const trust =
    command !== undefined &&
    interactive &&
    !rest.some((token) => HELP_TOKENS.has(token)) &&
    INTERACTIVE_TRUST_COMMANDS.has(command)
      ? await deps.resolveProjectTrust?.()
      : undefined;
  // Issue #90 (design §35.1): one config load for the whole process — paths
  // per §35.1, the project layer behind the trust gate, documented env
  // overrides, fail-closed on unknown/unsupported keys, budget keys and
  // secret refs. Commands below consume it through the injected runners;
  // nothing here re-derives a default by hand. The `--model` override is
  // read from the raw argv (issue #227) and becomes the `cli` layer of this
  // same load; the interactive trust answer (issue #228) is an explicit gate
  // on that same load.
  const cliModel = cliModelFromArgs(command, args);
  const cliConfig = deps.loadConfig(
    cliModel === undefined && trust === undefined
      ? undefined
      : {
          ...(cliModel === undefined ? {} : { model: cliModel }),
          ...(trust === undefined ? {} : { projectTrusted: trust }),
        },
  );
  // A refused config stops the agent-executing modes: they may not run on
  // built-in defaults while the user believes their config file is in force.
  // `config` and `doctor` still run so the named reason can be reported.
  const refusalExit = configRefusalExit(cliConfig, command);
  if (refusalExit !== undefined) {
    // A diagnostic, so stderr: a `--json` consumer's stdout stays empty.
    (deps.err ?? deps.out)(`error: ${cliConfig.error ?? 'config refused'}`);
    return refusalExit;
  }
  // Issue #91 (design §35, D34/D35): `.kubic/` runtime state must never
  // reach a user repo's commit path. Before either mode that creates it,
  // ship the runtime ignore rules into the repo-local exclude file
  // (idempotent, fail-open, never dirties a committed .gitignore) — so the
  // first run/orchestrate leaves `git status` clean while `.kubic/roles`
  // and `config.toml` stay trackable. Skipped outside a git repo.
  if (command !== undefined && STATE_CREATING_COMMANDS.has(command)) {
    deps.ensureRuntimeExclude(
      runtimeExcludeEntriesFor(cliConfig.runtime?.orchestrator.root),
    );
  }
  // Unknown commands and the bare invocation keep the POSIX usage + exit 1
  // posture pinned by scripts/binary-contract.mjs — decided before commander
  // parses, so they print the one usage line on stdout rather than
  // commander's stderr message. Root options (`--help`, `-V`, …) go on to
  // the parser. The contract crash probe (issue #128) is registered only
  // under its env gate, so an ungated `__crash-probe` lands here too.
  const crashProbe = process.env.__KUBIC_CONTRACT_CRASH_PROBE === '1';
  const known =
    command !== undefined &&
    (ROOT_OPTIONS.has(command) ||
      COMMAND_NAMES.has(command) ||
      (crashProbe && command === CRASH_PROBE));
  if (!known) {
    deps.out(ROOT_USAGE);
    return 1;
  }
  const io = { out: deps.out, err: deps.err ?? deps.out };
  const program = createKubicProgram(io, {
    versionLine: formatVersionLine(deps.version()),
    rootHelp: ROOT_USAGE,
  });
  let exitCode = 0;
  const ctx: CommandContext = {
    config: cliConfig,
    runners: deps.runners,
    rest: args,
    out: io.out,
    err: io.err,
    setExitCode: (code) => {
      exitCode = code;
    },
  };
  for (const register of REGISTRARS) register(program, ctx);
  if (crashProbe) {
    // Deliberate failure seam for the shipped-artifact contract (issue
    // #128): throws a plain Error so the top-level catch-all's `error:
    // <message>` / KUBIC_DEBUG behavior is asserted end to end against the
    // real binary. Internal, hidden, and absent from ROOT_USAGE.
    program
      .command(CRASH_PROBE, { hidden: true })
      .helpOption(false)
      .allowUnknownOption()
      .allowExcessArguments()
      .action(() => {
        throw new Error('injected probe failure');
      });
  }
  return runKubicProgram(program, [command, ...args], io, {
    code: () => exitCode,
  });
}
