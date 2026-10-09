# Kubic documentation

Every Kubic feature has one home here, separated by area so architecture
rationale, package APIs and CLI behaviour never mix.

| Area | Directory | Belongs here | Does not belong here |
| --- | --- | --- | --- |
| Architecture | [architecture/](architecture/README.md) | Topology and why: the in-process runtime, the change journal, the approvals safety model, the package map | API signatures, CLI flags, config keys |
| Packages | [packages/](packages/README.md) | One page per package: public API, contracts, dependency neighbours | Architecture rationale, CLI usage |
| CLI & operations | [cli/](cli/README.md) | Commands, flags, exit codes, configuration, `doctor` diagnostics | Package internals |
| Contributing | [contributing.md](contributing.md) | Workflow, Conventional Commits, the docs-update rule | Feature documentation |

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
| [commands.md](cli/commands.md) | The command index: global behaviour and where each command is documented |
| [run.md](cli/run.md) | `kubic run`, `kubic attach`, `kubic resume` |
| [tui.md](cli/tui.md) | `kubic tui`: the interactive surface |
| [tui-keys.md](cli/tui-keys.md) | The TUI's screen layout, keys and keybindings file |
| [approvals.md](cli/approvals.md) | The approval card and what each trigger detects |
| [sessions.md](cli/sessions.md) | `kubic sessions`: listing, forking and pruning sessions |
| [journal.md](cli/journal.md) | `kubic diff`, `undo`, `log`, `status`, `git`, `commit`, `journal prune` |
| [models.md](cli/models.md) | `kubic models`, `kubic setup`, `models.json` and provider keys |
| [analysis.md](cli/analysis.md) | `kubic cost`, `eval`, `benchmark`, `replay`, `export`, `policy`, `audit` |
| [exit-codes.md](cli/exit-codes.md) | The exit-code table |
| [configuration.md](cli/configuration.md) | Config layers, keys and `kubic config` |
| [enterprise.md](cli/enterprise.md) | The managed `[policy]` layer and its audit sinks |
| [doctor-and-debug.md](cli/doctor-and-debug.md) | `kubic doctor` diagnostics and debugging |
| [tools.md](cli/tools.md) | The tools the model calls |
| [trust.md](cli/trust.md) | Project trust and `kubic trust` |
| [skills.md](cli/skills.md) | `kubic skills`: which skills loaded and why any were left out |
| [contributing.md](contributing.md) | Contributor workflow |
| [contributing-cli.md](contributing-cli.md) | Building CLI commands: the commander registry, exit codes, `--json`, output helpers |

## Standards

1. **One page per area, one area per page.** Architecture pages explain
   why; package pages specify APIs and contracts; CLI pages specify the
   behaviour operators see. Cross-link instead of duplicating.
2. **Docs change with the code.** A behaviour change ships its docs page
   in the same commit. See [contributing.md](contributing.md).
3. **No broken internal links.** `npm run docs:check` must pass: every
   relative link resolves, and every anchor names a heading on its page.
   External URLs are not fetched.
4. **Honest limits, stated plainly.** Kubic has no isolation, and the
   docs never imply otherwise.

Package-level contracts live with their code and are quoted, not copied,
by the package pages: `packages/trajectory/CONTRACT.md` and
`packages/eval/COMMUNITY.md`.
