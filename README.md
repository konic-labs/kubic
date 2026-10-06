# Kubic

Kubic is Konic's open-source terminal coding agent: model-agnostic, built directly on the Pi agent
harness, with a change journal that makes every edit reviewable and reversible, and an optional
orchestrator mode that delegates to subagents in their own worktrees.

**Status: implemented.** A fresh clone plus Node >= 22.19 is enough to
build a working `kubic` binary — see [Install](#install). Every command the
binary dispatches is shipped and specified under [`docs/cli/`](docs/cli/):
solo (`run`, `sessions`, `git`, `models`, `diff` / `undo` / `log` /
`status`, `doctor`, `tui`), orchestrator mode (`orchestrate`, `clean`,
`workers`), and the analysis surfaces (`eval`, `benchmark`, `replay`,
`export`, `cost`, `perf`, `policy`, `audit`). The design document, decision
registry, and review tooling live in `docs/design/` (local-only, gitignored).

What is still open is refinement, not reach: [EPIC I](https://github.com/konic-labs/kubic/issues/73)
tracks the remaining wiring gaps (config layers read at runtime, the
extensions bundle at startup, TUI input and views, journal reconciliation),
each with its own issue. Out of scope for the install story: npm publishing,
auto-update, installers.

## What Kubic is

**One agent, full tool set, working directly in your directory.** Every change it makes is recorded
in a version-control-independent journal, so `kubic diff` and `kubic undo` work in a monorepo and in
`~/Downloads` alike. Dangerous operations are approved by you.

**Orchestrator mode is opt-in and session-scoped.** Turn it on and the `kubic orchestrate`
command plays the manager: it registers the §40 manager toolset, plans one step per worker,
fans one worker process plus one git worktree per subagent out, then merges what they produce.
Each worker runs its own plan step under an assigned role, and a worker's dangerous calls are
routed to you for approval. The mode requires a git repository.

There is no sandbox. Solo mode has no isolation at all, and the design says so plainly rather than
implying otherwise — see §59.1 of the document.

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
| [`docs/design/`](docs/design/) | Everything about the design — document, decisions, config, tooling, generated explorer. Start at [`docs/design/README.md`](docs/design/README.md). |
| [`docs/design/kubic-overview.md`](docs/design/kubic-overview.md) | The design document. Source of truth. |
| [`docs/design/design-decisions.json`](docs/design/design-decisions.json) | Settled and open decisions, with alternatives and rationale. |
| [`docs/design/design-explorer.html`](docs/design/design-explorer.html) | Generated, self-contained explorer for reading and annotating the design. |
| [`docs/design/tools/`](docs/design/tools/) | Generator for the explorer. Vendored from the `ege-designer` skill. |
| `~/.kubic/sessions/` | Session state — one state dir per session (`journal/`, `spans.jsonl`, approvals posture, the session lock) plus pi's transcript files. Nothing prunes the state dirs for you: `kubic sessions prune` lists candidates by default and deletes only with `--yes` (a live-locked session is never touched; `[session] retentionDays` supplies the default keep window); with `[session] retentionDays` set, `kubic log --session` also self-heals aged journal entries as it reads them. |
| `pi/` | Read-only reference clone of the Pi agent harness. Gitignored; not part of Kubic. |

There is no top-level `tools/` folder on purpose: the only tooling here serves the design, so it
lives inside the design folder rather than in a second tree that would exist to hold three files.

`pi/` is upstream code kept locally so the design can cite real interfaces instead of guesses.
It is never built, modified, or tested here, and it will be removed once Kubic stands on its own.

## Reviewing the design

Open `docs/design/design-explorer.html` in a browser — no server or install needed. Annotate any
line, paragraph, table, or section, then click **Save for agent** to write
`docs/design/kubic-annotations.json` and ask the agent to address the open notes.

Rebuild the explorer after editing the document or the decision registry:

```bash
node docs/design/tools/build-explorer.mjs --config docs/design/explorer.config.json
```

The document is Markdown; the explorer is a build artifact of it. Edit the Markdown, not the HTML.

## Conventions

- **Commits** follow [Conventional Commits](https://www.conventionalcommits.org/):
  `type(scope): summary`, e.g. `docs(design): scope workspace behaviour to the mode`.
- **The design document is the source of truth.** Decisions are recorded in
  `design-decisions.json`; their rationale lives with the sections that encode them.
- **Cross-references use `§`** followed by the section number (`§59.1`). The design-explorer build
  validates them and **exits non-zero on a dangling reference** — a typo in a section number
  fails the build instead of shipping a dead link into the explorer.

## License

MIT — see [LICENSE](LICENSE) (Copyright (c) 2026 Konic Labs). Third-party
attribution (Pi agent harness) lives in [NOTICE.md](NOTICE.md). Every
`package.json` declares `"license": "MIT"`, and the CLI reports it via
`kubic --version` and the `license:kubic` doctor check.

The repository is private and unreleased; the private-to-public gate
(`docs/design/` and `pi/` stay local, secret/history sweep) is recorded in
[docs/publish-checklist.md](docs/publish-checklist.md) — see §75.1 of the
design document.
