# CLI commands

> Design ref: §84 flows; `apps/kubic/src/main.ts` is the composition root.
> Every command and flag below was verified live against its
> `run*Command` implementation (exit codes included) — nothing here is
> documented from memory. Behaviour operators see only; package
> internals live on the [packages pages](../packages/README.md).

`kubic --version` (or `-V`) prints `kubic <version> (license: MIT)` —
the version comes from the nearest `kubic` package manifest
(`apps/kubic/package.json` for src runs, the repo root for `dist/` runs) —
and exits 0.
Build first (`npm run build`), then invoke `./bin/kubic.js` (or
|`npm run kubic -- …`); anything else dispatches below; an unknown command prints
`usage: kubic <sessions | git | models | diff | undo | log | status | run | doctor | workers>`
and exits 1. Solo mode runs in-process with your user authority: no
isolation, no containment — approvals plus the journal are the controls.

## `kubic run -p <prompt> [--session <id>] [--json]`

Non-interactive solo run: no alt-screen, no prompt, consumable output.

| Flag | Meaning |
| --- | --- |
| `-p`, `--prompt <text>` | **Required.** The prompt to run headless. |
| `--session <id>` | Resume into an existing session. Ids accept only `[A-Za-z0-9_-]` — anything else exits 2 before any store is touched. |
| `--json` | Emit one JSON envelope (`ok`, `exitCode`, `sessionId`, `status`, `result`, `journal`/`usage`/`trajectory` refs, optional `error`) instead of human lines. |

Text output prints `result:`, `session:`, `journal:` (`journal:<id>`),
`usage:` (`usage:<id>`), `trajectory:` (`trajectory:<id>`); on failure an
`error:` line comes first. Exit code is the §78 terminus map — see
[exit codes](exit-codes.md). Missing `-p`, a `-p`/`--session` without a
value, an invalid `--session` id, or an unknown flag all exit 2.

## `kubic sessions`

Sessions live under `~/.kubic/sessions` by default.

```
usage: kubic sessions <create [--cwd <path>] [--dangerously-skip-approvals] | list | attach <id> [--tail <n>]>
```

| Subcommand | Meaning |
| --- | --- |
| `create [--cwd <path>] [--dangerously-skip-approvals]` | Create a session, print its id. `--cwd` sets the session directory (default: current directory). `--dangerously-skip-approvals` records session-scoped full-access in the session dir and prints a warning — fresh sessions start safe, the flag must be passed explicitly every time. |
| `list` | One `<id>  <cwd>` line per session. |
| `attach <id> [--tail <n>]` | Print session metadata, the approvals posture (`approvals enforced` or `full-access …`), then the last `--tail` transcript entries (default 10) truncated to 300 chars each. `--tail` needs a non-negative integer. |

Missing subcommand exits 1 with the usage line; `attach` without an id
or with an id outside `[A-Za-z0-9_-]` exits 1; attaching a missing
session exits 1.

## `kubic git`

Thin over git ops. Outside a repo every subcommand exits 1 with
`not a git repository — kubic diff/undo still work without git` — the
journal path never needs git.

```
usage: kubic git <status [--json] | log [--max <n>] [--json] | stage <path...> | commit -m <message>>
```

| Subcommand | Meaning |
| --- | --- |
| `status [--json]` | Branch (plus ahead/behind when non-zero), `staged:`/`modified:`/`untracked:` lines, or `clean`. |
| `log [--max <n>] [--json]` | `<sha8> <date> <author>: <message>` per commit, or `no commits`. `--max` needs a positive integer. |
| `stage <path...>` | Stage paths, print `staged <p>` per path. Needs at least one path. |
| `commit -m <message>` | Commit, print `committed <sha8> (<n> file(s))`. Needs `-m <message>`. |

## `kubic diff | undo | log | status`

VCS-independent change journal over `<root>/.kubic/journal` — works
without git.

```
usage: kubic <diff [--path <p>] [--agent <id>] [--json] | undo [<path>] [--step] [--dry-run] | log | status>
```

| Subcommand | Meaning |
| --- | --- |
| `diff [--path <p>] [--agent <id>] [--json]` | Rendered diff of journaled changes (`no changes` + exit 0 when empty). `--path`/`--agent` filter; `--json` prints the raw change array. A `--path`/`--agent` without a value exits 1. |
| `undo [<path>] [--step] [--dry-run]` | Restore journaled changes. Positional `<path>` limits scope; `--step` restores one step; `--dry-run` prints `would restore N step(s)…` and exits 0 without touching anything. Real runs print `restored <p>` per path plus `undo: N restored, M non-reversible`. `nothing to undo` exits 0. **Exit 2 when any step was skipped as non-reversible** (`non-reversible (skipped): <p>`). |
| `log [--json]` | One line per journal entry (`journal is empty` + exit 0 when empty); `--json` prints the raw entries array. |
| `status` | `entries: N (reversible: R, non-reversible: M)` plus repo line: `repo: non-repo directory (journal works without git)` or `repo: branch <b>, dirty: yes|no|unknown`. |

## `kubic models`

Catalog readout over built-ins plus `models.json` customs in the
current directory (absent or invalid `models.json` is reported as a
`loaded models.json: …` / `models.json ignored: …` note, never fatal).

| Flag | Meaning |
| --- | --- |
| (none) | `provider <id> (<name>)` plus one `  <model> — thinking: <levels> — $in/$out per 1M in/out` line per model; `no providers registered (add models.json or set provider env keys)` when empty. Exits 0. |
| `--json` | The same catalog as JSON. Exits 0. |
| `--resolve <provider/id>` | Print `selected <provider>/<id> (thinking: …)` or `error: …`. Needs a value; resolution failure exits 1. |

## `kubic doctor`

Health readout — see [doctor and debug](doctor-and-debug.md).

| Flag | Meaning |
| --- | --- |
| `--skip <id[,id…]>` | Mark checks skipped (comma-separated). An id that matches no check exits 2; `--skip` without a value exits 2. |
| `--json` | Emit `{ok, exitCode, checks}` instead of human lines. Same exit code either way. |

Unknown flags exit 2. Full exit-code contract is on the
[exit-codes page](exit-codes.md).

## `kubic workers [--json] [--debug]`

Live worker list over the process registry: one line per worker with
the §13 status verbatim, age, owner, pid, startup span ms, and
resources (`skills=… templates=…`, `-` when none). A one-shot CLI
carries no orchestrator, so the registry is empty — no output, exit 0.

| Flag | Meaning |
| --- | --- |
| (none) | `<id>  <status>  gen=<n>  age=<age>  owner=<owner>  pid=<pid>  startup=<ms>  resources=<…>` per worker. |
| `--json` | The same rows as JSON (`workerId`, `sessionId`, `generation`, `status`, `ageMs`, `owner`, `resources`, `pid`, `startupMs`) — field-for-field with the text view. |
| `--debug` | `[worker] spawn …` per row plus `[exit] code=0 exited cleanly` on stderr. Spawn env values are always redacted (`KUBIC_ROLE_*` never prints). |

An unknown flag prints `usage: kubic workers [--json] [--debug]` and
exits 2 (no stack trace).

Back to the [docs index](../README.md). See also
[exit codes](exit-codes.md), [configuration](configuration.md), and
[doctor and debug](doctor-and-debug.md).
