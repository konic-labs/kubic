# Kubic

Kubic is Konic's open-source terminal coding agent: model-agnostic, built directly on the Pi agent
harness, with a change journal that makes every edit reviewable and reversible, and an optional
orchestrator mode that delegates to subagents in their own worktrees.

**Status: design.** There is no implementation yet. This repository currently holds the design
document, the decision registry, and the tooling used to review them.

## What Kubic is

**One agent, full tool set, working directly in your directory.** Every change it makes is recorded
in a version-control-independent journal, so `kubic diff` and `kubic undo` work in a monorepo and in
`~/Downloads` alike. Dangerous operations are approved by you.

**Orchestrator mode is opt-in.** Turn it on and the same agent becomes a manager: it stops
executing, delegates to subagents that each get their own process and their own git worktree, and
merges what they produce. The mode is session-scoped and requires a git repository.

There is no sandbox. Solo mode has no isolation at all, and the design says so plainly rather than
implying otherwise — see §59.1 of the document.

## Where things are

| Path | What it is |
| --- | --- |
| [`docs/design/`](docs/design/) | Everything about the design — document, decisions, config, tooling, generated explorer. Start at [`docs/design/README.md`](docs/design/README.md). |
| [`docs/design/kubic-overview.md`](docs/design/kubic-overview.md) | The design document. Source of truth. |
| [`docs/design/design-decisions.json`](docs/design/design-decisions.json) | Settled and open decisions, with alternatives and rationale. |
| [`docs/design/design-explorer.html`](docs/design/design-explorer.html) | Generated, self-contained explorer for reading and annotating the design. |
| [`docs/design/tools/`](docs/design/tools/) | Generator for the explorer. Vendored from the `ege-designer` skill. |
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
- **Cross-references use `§`** followed by the section number (`§40.11`). The build validates them
  and fails loudly on dangling references.

## License

MIT is the intended licence. The repository is private and unreleased, so this is tracked as an open
backlog item rather than settled — see §75.1 of the design document.
