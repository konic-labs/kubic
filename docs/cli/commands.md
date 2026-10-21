# CLI commands

> Every `kubic` command, by group. Package internals live on the
> [packages pages](../packages/README.md).

`kubic --version` (or `-V`) prints `kubic <version> (license: MIT)` —
the version comes from the nearest `kubic` package manifest
(the repo root's `package.json`, for src and `dist/` runs alike) —
and exits 0.

**`--help` is uniform across the commands.** Every command below answers
`kubic <command> --help` (or `-h`) with **exit 0**. Every command is
parsed by commander (`apps/kubic/src/commands/*.ts`) and prints its
generated help — `Usage: kubic <command> [options]`, every option with its
description, and examples where useful (the analysis commands share
[these rules](analysis.md#analysis-commands-shared-rules)). Usage *errors* keep their
own exit codes (a bad flag is still an error; a help request is not): an
unknown option, a missing value, a value the command's rules refuse, or a
stray operand prints one `error: …` line on **stderr** and exits **2**
(no `Did you mean …?` follow-up line). A value option never takes a
following `--flag` or the `--` terminator as its value: `kubic diff
--session --json` is a missing value
(`option '…' argument missing`, exit 2, nothing runs). A value that really
starts with `--` goes in the attached form (`--session=…`, `-p--…`).

The **root dispatcher** follows the same convention:
`kubic --help` / `kubic -h` prints the grouped root help below and exits 0.
On an interactive colour terminal the same text is coloured (brand, muted
labels, command names); piped, redirected or under `NO_COLOR` it is plain. A **bare `kubic`** (no command) on
an interactive terminal (stdin and stdout both a TTY) opens the TUI, exactly
as `kubic tui`. Off a TTY (a pipe, CI, a script) it prints the *identical*
listing and exits 1: usage-on-no-args is the deliberate POSIX posture, so
only the exit code differs between the two paths.
`scripts/binary-contract.mjs` pins both exits and the plain text itself, so
the dispatcher and its help cannot drift apart. The command groups are also
the dispatcher's routing table (`apps/kubic/src/cli/root-help.ts`), so a
command cannot ship without a place in the help.

```text
■ kubic — terminal coding agent by Konic

USAGE      kubic                       open the TUI (on a terminal)
           kubic "<prompt>"            run one prompt, like kubic run -p
           kubic <command> [options]

SESSION    run · tui · resume · attach · sessions                work with the agent
CHANGES    diff · undo · log · status · commit · git · journal   review and revert what it did
SETUP      setup · models · config · trust · doctor · skills     providers, project, health
ANALYSIS   cost · eval · benchmark · replay · export · policy · audit

EXAMPLES   kubic "fix the failing test"
           kubic run -p "add tests for titleCase" --json
           kubic diff && kubic undo

kubic <command> --help for options · docs/cli/README.md
```

A command's own help keeps commander's layout (`Usage: kubic <command>
[options]`, then `Arguments:` and `Options:`); on a colour terminal the
titles and option terms are styled, and the text is otherwise unchanged. `kubic --version` exits 0.

**Every command's own `--help`/`-h` is side-effect free**:
commander answers it before the action runs, so `kubic run|tui --help`
prints that command's usage and exits 0 without booting a lane or writing
the runtime exclude rules.

Build first (`npm run build`), then invoke `./bin/kubic.js` (or
`npm run kubic -- …`); anything else dispatches below; an unknown command
is a usage error (exit **2**) reported on stderr:
`error: unknown command '<name>'`, then `hint: did you mean kubic
<command>?` for a near miss or `hint: to run it as a prompt: kubic run -p
'<word>'` for any other word, then `hint: kubic --help lists the commands`
(an error block on a colour terminal; see [exit codes](exit-codes.md)),
while the bare invocation keeps the POSIX usage-on-no-args posture: the
root help, exit 1.

**The headline prompt form**: a single argv token that
contains whitespace is a prompt — `kubic "fix the authentication bug"` is
exactly `kubic run -p "fix the authentication bug"`, headless
(no alt-screen). Trailing flags pass
through (`kubic "do x" --json`). A **single-word** token has no whitespace
to tell it from a typo'd command, so it stays an unknown command (exit 2)
with the hint above. A token that reads exactly as a command — every word
the command name, one of its subcommands or an option, as in
`kubic "sessions list"` from a script or an alias — is refused the same way
(`error: quoted command 'sessions list'`, exit 2, with the unquoted command
and the prompt form as hints), so it never starts a model run; a prompt that
only starts with a command word (`kubic "commit the staged changes"`) still
runs. Kubic runs in-process with your user authority: no
isolation, no containment — approvals plus the journal are the controls.

## Commands by page

| Page | Commands |
| --- | --- |
| [Running a task](run.md) | `kubic run`, `kubic attach`, `kubic resume` |
| [The terminal UI](tui.md) | `kubic tui` ([keys](tui-keys.md), [approvals](approvals.md)) |
| [Sessions](sessions.md) | `kubic sessions` |
| [Reviewing and reverting changes](journal.md) | `kubic diff`, `undo`, `log`, `status`, `git`, `commit`, `journal prune` |
| [Models and providers](models.md) | `kubic models`, `kubic setup`, `kubic keys` |
| [Configuration](configuration.md) | `kubic config` |
| [Project trust](trust.md) | `kubic trust` |
| [Doctor and debug](doctor-and-debug.md) | `kubic doctor` |
| [Skills](skills.md) | `kubic skills` |
| [Analysis](analysis.md) | `kubic cost`, `eval`, `benchmark`, `replay`, `export`, `policy`, `audit` |
