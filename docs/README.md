# Kubic documentation

Every Kubic feature has one home here, separated by area so architecture
rationale, package APIs and CLI behaviour never mix.

| Area | Directory | Belongs here | Does not belong here |
| --- | --- | --- | --- |
| Architecture | [architecture/](architecture/README.md) | Topology and why: the in-process runtime, the change journal, the approvals safety model, the package map | API signatures, CLI flags, config keys |
| Packages | [packages/](packages/README.md) | One page per package: public API, contracts, dependency neighbours | Architecture rationale, CLI usage |
| CLI & operations | [cli/](cli/README.md) | Commands, flags, exit codes, configuration, `doctor` diagnostics | Package internals |
| Contributing | [contributing.md](contributing.md) | Workflow, Conventional Commits, the docs-update rule | Feature documentation |
| UI design | [ui/](ui/README.md) | The terminal design system: colour tokens, glyphs, key map, screen mockups | Implementation details, CLI flags |

## Pages

### Architecture

| Page | Covers |
| --- | --- |
| [overview.md](architecture/overview.md) | System overview and package map |
| [in-process.md](architecture/in-process.md) | The in-process runtime: a single trust zone, no isolation |
| [journal-and-safety.md](architecture/journal-and-safety.md) | The change journal and the approvals safety model |

### Packages

| Package | Docs page |
| --- | --- |
| `packages/core` | [packages/core.md](packages/core.md) |
| `packages/exec` | [packages/exec.md](packages/exec.md) |
| `packages/agent` | [agent.md](packages/agent.md) |
| `packages/host` | [packages/host.md](packages/host.md) |
| `packages/trajectory` | [packages/trajectory.md](packages/trajectory.md) |
| `packages/eval` | [packages/eval.md](packages/eval.md) |
| `packages/tui` | [packages/tui.md](packages/tui.md) |
| `apps/kubic` (composition root) | [cli/commands.md](cli/commands.md) |

### CLI & operations

| Page | Covers |
| --- | --- |
| [commands.md](cli/commands.md) | Every `kubic` command and flag |
| [exit-codes.md](cli/exit-codes.md) | The exit-code table |
| [configuration.md](cli/configuration.md) | Config precedence and secrets |
| [doctor-and-debug.md](cli/doctor-and-debug.md) | `kubic doctor` diagnostics and debugging |
| [tools.md](cli/tools.md) | The tools the model calls |
| [trust.md](cli/trust.md) | Project trust |
| [skills.md](cli/skills.md) | `kubic skills`: which skills loaded and why any were left out |
| [contributing.md](contributing.md) | Contributor workflow |
| [contributing-cli.md](contributing-cli.md) | Building CLI commands: the commander registry, exit codes, `--json`, output helpers |

## Standards

1. **One page per area, one area per page.** Architecture pages explain
   why; package pages specify APIs and contracts; CLI pages specify the
   behaviour operators see. Cross-link instead of duplicating.
2. **Docs change with the code.** A behaviour change ships its docs page
   in the same commit. See [contributing.md](contributing.md).
3. **No broken internal links.** `npm run docs:check` must pass. External
   URLs and same-page anchors are exempt.
4. **Honest limits, stated plainly.** Kubic has no isolation, and the
   docs never imply otherwise.

Package-level contracts live with their code and are quoted, not copied,
by the package pages: `packages/trajectory/CONTRACT.md` and
`packages/eval/COMMUNITY.md`.
