# Building CLI commands

Kubic's command line is built on a small, pinned stack. Use it — never
hand-roll argv parsing, colours, tables, or prompts.

| Concern | Library | Kubic wrapper |
| --- | --- | --- |
| Commands, options, help | `commander` via `@commander-js/extra-typings` | `apps/kubic/src/cli/program.ts` |
| Exit codes | — | `packages/core/src/cli/exit-codes.ts` |
| Colour | `chalk` | `packages/core/src/cli/theme.ts` |
| Leveled logs | `consola` | `packages/core/src/cli/logger.ts` |
| Tables | `cli-table3` | `packages/core/src/cli/table.ts` |
| Prompts, spinners | `@clack/prompts` | `packages/core/src/cli/prompt.ts` |
| `--json` / output mode | — | `packages/core/src/cli/output.ts` |

All six packages are exact-pinned in the root `package.json` (it owns the
`kubic` bin and `dist/`, so the runtime resolves them from the root
`node_modules`); `npm run check:pi` rejects ranges on any dependency and
`scripts/license.test.mjs` rejects a non-permissive runtime licence.
See [NOTICE.md](../NOTICE.md).

## Adding or migrating a command

Each command group owns one module under `apps/kubic/src/commands/`:

| Module | Commands |
| --- | --- |
| `solo.ts` | run, tui, doctor, models, config, sessions |
| `orchestrator.ts` | orchestrate, clean, workers |
| `journal.ts` | diff, undo, log, status, git |
| `analysis.ts` | cost, perf, policy, audit, eval, benchmark, replay, export |

A module exports `register<Group>Commands: CommandRegistrar`, i.e.
`(program: KubicProgram, ctx: CommandContext) => void`. The context carries
the process-wide config load (`ctx.config`), the injected runners
(`ctx.runners`), the `out`/`err` line channels, and `ctx.setExitCode(code)`.

A command that is not migrated yet is a pass-through forwarder
(`registerForwarder`): it hands the raw argv to the legacy handler, which
still parses it with the deprecated `packages/core/src/flags.ts`.

The analysis group (`commands/analysis.ts`) is migrated and is the
reference to copy:

- it declares typed runners (`AnalysisRunners`, parsed options in), which
  `DispatchRunners` extends;
- its handlers take `{ out, err, theme?, fancy? }`;
- its tests are in `commands/analysis.test.ts`.

Migrating a command means replacing its forwarder with a real
definition:

```ts
program
  .command('cost')
  .description('report token and dollar cost')
  .option('--session <id>', 'one session only')
  .option('--json', 'print one JSON document')
  .action(async (opts) => {
    ctx.setExitCode(await runCost({ ...opts, out: ctx.out }));
  });
```

Then delete the handler's `parseFlagArgs` / `answerHelp` calls — commander
now owns `--help`, `--flag=value`, `--`, and unknown-option errors. Update
the command's `docs/cli/` page in the same commit. When the last handler
stops importing `flags.ts`, delete it and its gate exemption in
`scripts/flag-parser-gate.test.mjs`.

## Exit codes

The table is [docs/cli/exit-codes.md](cli/exit-codes.md); use the named
constants (`EXIT_OK` 0, `EXIT_FAILED` 1, `EXIT_USAGE` 2, `EXIT_BUDGET` 3,
`EXIT_APPROVAL` 4, `EXIT_WORKSPACE` 5, `EXIT_PROVIDER` 6).

- commander parse failures (unknown option, missing value, bad argument,
  excess operands) exit **2** with commander's one `error: …` line on
  stderr — `exitCodeForParseError` maps them; never commander's default 1.
- `--help` / `-h` exits 0 on every command; `--version` / `-V` is root-only.
- Throw `CliUsageError(message)` from an action for a semantic usage error
  (exit 2) or `CliExitError(code, message)` for any other documented code:
  the program prints `error: <message>` on stderr and exits with the code.
- Anything else thrown reaches the root catch-all: one `error: <message>`
  line, exit 1, the stack only with `KUBIC_DEBUG=1`.
- An unknown top-level command and a bare `kubic` off a TTY print the root
  usage line and exit 1; a bare `kubic` on a TTY opens the TUI.

## Output rules

- **stdout is data, stderr is diagnostics.** Reports, tables and JSON go
  through `ctx.out`; progress and warnings go through the logger
  (`createLogger({ write, debug, theme })`), which writes every level to
  stderr as `<level>: <message>`. `debug` shows only under `--debug` or
  `KUBIC_DEBUG=1` (`debugEnabled`).
- **`--json` prints exactly one document on stdout** via `formatJson`, and
  nothing else there. Under `--json`: no colour, no tables, no spinners,
  no prompts (`outputModeFor({ json, stdinTTY, stdoutTTY, colorEnabled })`
  computes `interactive` and `fancy`).
- **Colour** comes from `themeFor(stream)` / `createCliTheme(level)`: it
  honours `NO_COLOR`, `FORCE_COLOR`, `TERM=dumb`, and is off on a non-TTY.
  The palette is the Konic brand shared with the TUI (`#ff004d` accent).
- **Tables**: `renderTable(rows, columns, { fancy, theme })` — box-drawn
  when `fancy`, plain space-aligned text otherwise (pipes, CI, NO_COLOR).
- **Prompts** (`promptConfirm`, `promptSelect`, `promptText`,
  `startSpinner`) take an explicit `interactive` flag and a required
  `nonInteractive` answer; they never prompt off a TTY or under `--json`.
  A cancelled prompt resolves to `null`.

## Testing

- Drive commands through `runKubicProgram(program, argv, io, exit)` with
  capturing `out`/`err` arrays — see `apps/kubic/src/cli/program.test.ts`.
  Assert exit code, stdout and stderr separately; assert a `--json` run's
  stdout parses as JSON and stderr holds any logs.
- Build themes with an explicit level (`createCliTheme('none')`) so
  snapshots are byte-stable; never depend on the test runner's TTY.
- Prompt tests mock `@clack/prompts` or pass `interactive: false`.
- The shipped binary's help/version/usage/crash contracts are pinned end to
  end by `scripts/binary-contract.mjs`.
