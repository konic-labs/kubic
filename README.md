# Kubic

Kubic is Konic's open-source terminal coding agent: model-agnostic, built directly on the Pi agent
harness, with a change journal that makes every edit reviewable and reversible.

**Status: implemented.** A fresh clone plus Node >= 22.19 is enough to
build a working `kubic` binary — see [Install](#install). Every command the
binary dispatches is shipped and specified under [`docs/cli/`](docs/cli/):
the agent (`run`, `tui`, `sessions`, `models`, `doctor`), the change
journal (`diff` / `undo` / `log` / `status`, `git`, `commit`), and the
analysis surfaces (`eval`, `benchmark`, `replay`, `export`, `cost`,
`policy`, `audit`). Out of scope for the install story: npm publishing,
auto-update, installers.

## What Kubic is

**One agent, full tool set, working directly in your directory.** Every change it makes is recorded
in a version-control-independent journal, so `kubic diff` and `kubic undo` work in a monorepo and in
`~/Downloads` alike. Dangerous operations are approved by you.

There is no sandbox. Kubic runs with no isolation at all, and says so plainly rather than
implying otherwise — see [`docs/architecture/solo.md`](docs/architecture/solo.md).

## Install

Prerequisites: Node >= 22.19 (`node --version`).

From a fresh clone, run these exact commands from the repo root:

```bash
npm ci
npm run build
./bin/kubic.js --version
```

The third prints `kubic 0.0.0 (license: MIT)` and exits 0. Equivalent
invocations: `npx kubic --version` (the `bin` entry, no install needed),
`npm run kubic -- --version` (the same binary through npm), and
`node dist/apps/kubic/src/main.js --version` (the build output directly).
`./bin/kubic.js doctor` reports health; on a clean tree with no provider
configured it exits 6 with a single `provider-down` failure
(`limit:provider-availability`) — see
[`docs/cli/doctor-and-debug.md`](docs/cli/doctor-and-debug.md).
With a provider key in your environment (for example `ANTHROPIC_API_KEY`),
`./bin/kubic.js setup` picks a default model and saves it to
`~/.kubic/config.toml`; a bare `./bin/kubic.js` on a terminal runs the same
setup on first launch, then opens the TUI — see
[`docs/cli/commands.md`](docs/cli/commands.md#kubic-setup).

`dist/` is gitignored tsc output (`tsconfig.build.json`, no hand-rolled
flags); rebuilding is byte-equivalent. Nothing here publishes to npm.

## Where things are

| Path | What it is |
| --- | --- |
| [`bin/kubic.js`](bin/kubic.js) | Committed `kubic` executable — wrapper over the `dist/` build output. |
| [`apps/kubic/`](apps/kubic/) | CLI composition root (`src/main.ts` wires host + tui). |
| [`packages/`](docs/packages/) | Feature packages — one API page per package under `docs/packages/`. |
| `~/.kubic/sessions/` | Session state — one state dir per session (`journal/`, `spans.jsonl`, approvals posture, the session lock) plus pi's transcript files. Nothing prunes the state dirs for you: `kubic sessions prune` lists candidates by default and deletes only with `--yes` (a live-locked session is never touched; `[session] retentionDays` supplies the default keep window); with `[session] retentionDays` set, `kubic log --session` also self-heals aged journal entries as it reads them. |
| `pi/` | Read-only reference clone of the Pi agent harness. Gitignored; not part of Kubic. |

`pi/` is upstream code kept locally as a reference for the Pi interfaces Kubic builds on.
It is never built, modified, or tested here, and it will be removed once Kubic stands on its own.

## Conventions

- **Commits** follow [Conventional Commits](https://www.conventionalcommits.org/):
  `type(scope): summary`, e.g. `fix(journal): judge a blob's freshness in whole milliseconds`.

## License

MIT — see [LICENSE](LICENSE) (Copyright (c) 2026 Konic Labs). Third-party
attribution (Pi agent harness) lives in [NOTICE.md](NOTICE.md). Every
`package.json` declares `"license": "MIT"`, and the CLI reports it via
`kubic --version` and the `license:kubic` doctor check.

The repository is private and unreleased; the private-to-public gate
(`pi/` stays local, secret/history sweep) is recorded in
[docs/publish-checklist.md](docs/publish-checklist.md).
