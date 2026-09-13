# Kubic

Kubic is Konic's open-source terminal coding agent: model-agnostic, multi-agent, built directly
on the Pi agent harness, with a sandboxed worker process per executing subagent and a terminal UI
on `pi-tui`.

**Status: design.** There is no implementation yet. This repository currently holds the design
document, the decision registry, and the tooling used to review them.

## Where things are

| Path | What it is |
| --- | --- |
| [`docs/design/`](docs/design/) | The design. Start at [`docs/design/README.md`](docs/design/README.md). |
| [`docs/design/kubic-overview.md`](docs/design/kubic-overview.md) | The design document. Source of truth. |
| [`docs/design/design-decisions.json`](docs/design/design-decisions.json) | Settled and open decisions, with alternatives and rationale. |
| [`docs/design/design-explorer.html`](docs/design/design-explorer.html) | Generated, self-contained explorer for reading and annotating the design. |
| `tools/design-explorer/` | Generator for the explorer. Vendored from the `ege-designer` skill. |
| `pi/` | Read-only reference clone of the Pi agent harness. Gitignored; not part of Kubic. |

`pi/` is upstream code kept locally so the design can cite real interfaces instead of guesses.
It is never built, modified, or tested here, and it will be removed once Kubic stands on its own.

## Reviewing the design

Open `docs/design/design-explorer.html` in a browser — no server or install needed. Annotate any
line, paragraph, table, or section, then click **Save for agent** to write
`docs/design/kubic-annotations.json` and ask the agent to address the open notes.

Rebuild the explorer after editing the document or the decision registry:

```bash
node tools/design-explorer/build-explorer.mjs --config docs/design/explorer.config.json
```

The document is Markdown; the explorer is a build artifact of it. Edit the Markdown, not the HTML.

## Conventions

- **Commits** follow [Conventional Commits](https://www.conventionalcommits.org/):
  `type(scope): summary`, e.g. `docs(design): lock sandbox backend decision`.
- **The design document is the source of truth.** Decisions are recorded in
  `design-decisions.json`; their rationale lives with the sections that encode them.
- **Cross-references use `§`** followed by the section number (`§40.11`). The build validates them
  and fails loudly on dangling references.

## License

TBD.
