# Kubic

Kubic is Konic's open-source terminal coding agent. It is model-agnostic, built on
the Pi agent harness, and runs one agent directly in your directory. Every change
the agent makes is recorded in a journal that does not depend on version control,
so `kubic diff` and `kubic undo` work in a monorepo and in `~/Downloads` alike.

**Status: implemented, not yet published.** A fresh clone plus Node >= 22.19 builds a
working `kubic` binary, and every command listed below is implemented. Kubic is not
on npm yet.

## Quick start

From a fresh clone, run these commands from the repository root:

```bash
npm ci
npm run build
KUBIC_PROVIDER=faux ./bin/kubic.js run -p "hello"
```

Run exactly as shown on a fresh clone with no configuration, the last command exits 0
and prints `result: faux echo: hello`, then `session`, `journal`, `usage` and
`trajectory` references. It also writes three honest-limit warnings and a
`provider: faux/echo` line to stderr; those are expected. `KUBIC_PROVIDER=faux` selects
the built-in test model, which answers without a network connection or an API key.
To use a real model, export a provider key (for example `ANTHROPIC_API_KEY`) and run
`./bin/kubic.js setup` to choose a default. On a terminal, a bare `./bin/kubic.js`
runs setup on first launch and then opens the interactive TUI.

## What it does

- **One agent in your directory.** It reads, writes and edits files, searches with
  `grep`, `find` and `ls`, and runs `bash`. There is no delegation mode: one agent
  does the work.
- **Approvals.** Destructive and network-raising actions need your approval. The
  TUI shows an approval card. `kubic run` cannot ask, so it refuses a challenged
  action instead of running it.
- **A change journal.** `kubic diff` shows what changed, `kubic undo` restores it,
  and `kubic log` and `kubic status` show the record. The journal works without git.
- **Sessions.** Each run belongs to a session. List, attach, fork and resume them
  with `kubic sessions`, `kubic run --session` and `kubic tui --session`.
- **Models.** `kubic models` reads the built-in model catalogue, and `kubic setup`
  picks a default. Provider keys come from your environment.
- **Analysis.** `kubic eval`, `kubic benchmark`, `kubic replay` and `kubic export`
  work on suites, runs and trajectories. `kubic cost` reads usage rows from the
  session store, `kubic policy` answers tool-policy queries, and `kubic audit`
  queries the audit ledger.

The full command reference is in [`docs/cli/`](docs/cli/).

## Honest limits

Kubic is not a sandbox, and its documentation says so plainly. `kubic doctor` reports
the same limits.

- **No isolation.** Kubic runs with your user's authority: your files, your network
  access and your credentials. Approvals and the change journal are the controls.
- **No prompt-injection prevention.** Tool output is treated as data, never as
  instructions, but nothing guarantees that a model will not be steered by what it reads.
- **Policy is routing, not enforcement.** An approval policy decides which actions
  ask. Values it cannot enforce are reported, never honoured.
- **The journal is not a backup.** It is an undo log, and it cannot restore state
  outside the workspace.
- **No third-party tools or MCP servers.** Requests for them are refused.

See [`docs/architecture/in-process.md`](docs/architecture/in-process.md) and
[`docs/architecture/journal-and-safety.md`](docs/architecture/journal-and-safety.md)
for the details.

## Install

Prerequisites: Node >= 22.19 (`node --version`).

From a fresh clone, run these commands from the repository root:

```bash
npm ci
npm run build
./bin/kubic.js --version
```

The last command prints `kubic 0.0.0 (license: MIT)` and exits 0. Equivalent
invocations: `npx kubic --version` (the `bin` entry, no install needed),
`npm run kubic -- --version` (the same binary through npm), and
`node dist/apps/kubic/src/main.js --version` (the build output directly).

On a fresh clone with no provider configured, `./bin/kubic.js doctor` exits 6 and
prints `doctor: 16 pass, 6 warn, 1 fail, 0 skip`. Its one failure is
`FAIL limit:provider-availability (provider-down)`; the six warnings are the five
honest limits and the detection-only policy note. See
[`docs/cli/doctor-and-debug.md`](docs/cli/doctor-and-debug.md). With a provider key
in your environment, `./bin/kubic.js setup` saves a default model to
`~/.kubic/config.toml`; see [`docs/cli/commands.md`](docs/cli/commands.md#kubic-setup).

`dist/` is gitignored `tsc` output (`tsconfig.build.json`); rebuilding is
byte-equivalent.

## Where things are

| Path | What it is |
| --- | --- |
| [`bin/kubic.js`](bin/kubic.js) | Committed `kubic` executable, a wrapper over the `dist/` build output. |
| [`apps/kubic/`](apps/kubic/) | CLI composition root (`src/main.ts` wires the host and the TUI). |
| [`packages/`](docs/packages/) | Feature packages, one overview page per package under `docs/packages/`. |
| [`docs/`](docs/README.md) | Reference docs: the CLI, the architecture, the packages and the contributor guide. |

Session state lives in `~/.kubic/sessions/`, one state directory per session
(`journal/`, `spans.jsonl`, the approvals posture and the session lock), plus the
transcript files. Nothing prunes these for you: `kubic sessions prune` lists
candidates by default and deletes only with `--yes` or a yes at its terminal
prompt. A session that is locked by a live process is never touched.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for setup, the checks to run, and the commit
and docs conventions.

## License

MIT. See [LICENSE](LICENSE) (Copyright (c) 2026 Konic Labs). Third-party attribution
for the Pi agent harness is in [NOTICE.md](NOTICE.md). Every `package.json` declares
`"license": "MIT"`, and the CLI reports the license through `kubic --version` and the
`license:kubic` doctor check.
