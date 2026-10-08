# Building CLI commands

Kubic's command line is built on a small, pinned stack. Use it — never
hand-roll argv parsing, colours, tables, or prompts.

| Concern | Library | Kubic wrapper |
| --- | --- | --- |
| Commands, options, help | `commander` via `@commander-js/extra-typings` | `apps/kubic/src/cli/program.ts` |
| Exit codes | — | `packages/core/src/cli/exit-codes.ts` |
| Colour | — (shared tokens, `packages/core/src/ui`) | `packages/core/src/cli/theme.ts` |
| Leveled logs | `consola` | `packages/core/src/cli/logger.ts` |
| Tables | — | `packages/core/src/cli/table.ts` |
| Output kit (headings, marks, receipts, errors, spinner) | — | `packages/core/src/cli/kit.ts`, `spinner.ts`, `width.ts` |
| Prompts | `@clack/prompts` | `packages/core/src/cli/prompt.ts` |
| `--json` / output mode | — | `packages/core/src/cli/output.ts` |

The four packages are exact-pinned in the root `package.json` (it owns the
`kubic` bin and `dist/`, so the runtime resolves them from the root
`node_modules`); `npm run check:pi` rejects ranges on any dependency and
`scripts/license.test.mjs` rejects a non-permissive runtime licence.
See [NOTICE.md](../NOTICE.md).

## Adding or migrating a command

Each command group owns one module under `apps/kubic/src/commands/`:

| Module | Commands |
| --- | --- |
| `solo.ts` | run, tui, doctor, models, config, sessions |
| `journal.ts` | diff, undo, log, status, journal prune, git |
| `analysis.ts` | cost, policy, audit, eval, benchmark, replay, export |

A module exports `register<Group>Commands: CommandRegistrar`, i.e.
`(program: KubicProgram, ctx: CommandContext) => void`. The context carries
the process-wide config load (`ctx.config`), the injected runners
(`ctx.runners`), the `out`/`err` line channels, and `ctx.setExitCode(code)`.

Every command is a real commander definition; the hand-rolled parser
(`flags.ts`) and help convention (`cli-help.ts`) are gone, and
`scripts/flag-parser-gate.test.mjs` keeps them from coming back.

The analysis group (`commands/analysis.ts`) is the reference to copy:

- it declares typed runners (`AnalysisRunners`, parsed options in), which
  `DispatchRunners` extends;
- its handlers take `{ out, err, theme?, fancy? }`;
- its tests are in `commands/analysis.test.ts`.

A new command is a real definition:

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

Commander owns `--help`, `--flag=value`, `--`, and unknown-option errors;
the handler takes the parsed options, never argv. Update the command's
`docs/cli/` page in the same commit.

## Exit codes

The table is [docs/cli/exit-codes.md](cli/exit-codes.md); use the named
constants (`EXIT_OK` 0, `EXIT_FAILED` 1, `EXIT_USAGE` 2, `EXIT_BUDGET` 3,
`EXIT_APPROVAL` 4, `EXIT_WORKSPACE` 5, `EXIT_PROVIDER` 6). A module's own
named codes (`RUN_EXIT_*`, `EVAL_EXIT_*`, …) are aliases of these, never
new literals.

- commander parse failures (unknown option, missing value, bad argument,
  excess operands) exit **2** with commander's one `error: …` line on
  stderr — `exitCodeForParseError` maps them; never commander's default 1.
- `--help` / `-h` exits 0 on every command; commander answers it before
  any action runs, so a help request is side-effect free — no lane boot, no
  runtime-exclude write, no extension load. `--version` / `-V`
  is root-only.
- Throw `CliUsageError(message)` from an action for a semantic usage error
  (exit 2) or `CliExitError(code, message)` for any other documented code:
  the program prints `error: <message>` on stderr and exits with the code.
- Anything else thrown reaches the root catch-all: one `error: <message>`
  line, exit 1, the stack only with `KUBIC_DEBUG=1`.
- An unknown top-level command or root option is a usage error reported on stderr with a did-you-mean or prompt hint (issue
  ); a bare `kubic` off a TTY prints the root help and exits 1 (POSIX
  usage-on-no-args); a bare `kubic` on a TTY opens the TUI.
- **Errors on a terminal**: the logger's level prefixes become
  status marks on a colour stderr (`✕`, `▲`, `ℹ`, `✓`; plain `error:` /
  `warn:` / `info:` / `ok:` words otherwise), commander usage errors are an
  `errorBlock`, and name lookups use `suggest()` (`packages/core/src/suggest.ts`)
  for a "did you mean" hint.

## Output rules

- **stdout is data, stderr is diagnostics.** Reports, tables and JSON go
  through `ctx.out`; progress and warnings go through the logger
  (`createLineLogger(err, { debug, theme })` over the stderr line channel),
  which writes every level to stderr as `<level>: <message>`. `debug`
  shows only under `KUBIC_DEBUG=1`, or a command's own `--debug` where it
  declares one (`run`) — there is no global `--debug`
  (`debugEnabled`). Refusals such as a broken config are diagnostics too.
- **Diagnostics colour follows stderr**: the logger's theme comes from
  `themeFor(process.stderr)` (a handler's `errTheme`), never from the
  stdout report theme, so a redirected stderr gets no ANSI escapes.
- **`--json` prints exactly one document on stdout** via `formatJson`, and
  nothing else there. Under `--json`: no colour, no tables, no prompts (`outputModeFor({ json, stdinTTY, stdoutTTY, colorEnabled })`
  computes `interactive` and `fancy`).
- **Colour** comes from `themeFor(stream)` / `createCliTheme(level)`: it
  honours `NO_COLOR`, `FORCE_COLOR`, `TERM=dumb`, and is off on a non-TTY.
  The palette is the shared design tokens (`docs/ui/README.md`); new output
  styles through `theme.ui` roles (`fg2`, `accent`, `ok`, …), never raw hex.
- **Tables**: `renderTable(rows, columns, { fancy, theme, markers })` — the
  kit's borderless table when `fancy` (muted header, faint rule, optional
  row markers such as `●` for a default row), plain space-aligned text
  otherwise (pipes, CI, NO_COLOR), aligned by terminal display width (wide
  CJK cells count 2).
- **The output kit** (`packages/core/src/cli/kit.ts`) is the TTY
  layer for human-facing output (``): `brandHeading`,
  `sectionLabel`, `statusMark` (✓ ▲ ✕ ○ ℹ and the spinner frame),
  `alignedRows`, `receipt`, `nextActions`, `errorBlock`, `hintLine`
  (backtick spans highlighted) and `kvLine`. Use it only when
  `isFancy(stream)` is true; otherwise print the command's plain text — the
  binary contract and scripts depend on it.
- **Progress**: `createSpinner(stream, theme)` animates only on a TTY
  (`start`, `update`, `print` a settled line above it, `stop`); on any other
  stream it writes nothing. It hides the cursor while spinning and restores
  it on stop and on process exit.
- **Prompts** (`promptConfirm`) take an explicit `interactive` flag and a
  required `nonInteractive` answer; they never prompt off a TTY or under
  `--json`. A cancelled prompt resolves to `null`. `@clack/prompts` loads lazily
  (first prompt), so scripted calls skip its import cost.

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
