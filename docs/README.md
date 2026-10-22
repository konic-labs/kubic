# Kubic documentation

> Start with the guide, then look things up in the reference.

Examples write `kubic`. From a source checkout that is `bin/kubic.js`, or
`kubic` after `npm link` (see [install](getting-started.md#install)).

## Start here

- [Getting started](getting-started.md): install Kubic, connect a model, run a
  first task, review and undo it, and come back to the session.
- [The TUI](cli/tui.md): the screen, the panels and the slash commands.

## Guides

| Page | Covers |
| --- | --- |
| [Approvals](cli/approvals.md) | What asks before it runs, and the approval card |
| [Reviewing and reverting changes](cli/journal.md) | `kubic diff`, `undo`, `log`, `status`, `git`, `commit` and `journal prune` |
| [Sessions](cli/sessions.md) | Listing, resuming, forking and pruning sessions |
| [Models and providers](cli/models.md) | `kubic models`, `setup` and `keys`, `models.json`, and where keys come from |
| [Project trust](cli/trust.md) | When a project's own config applies, and `kubic trust` |
| [Skills](cli/skills.md) | Which skills load, and why any were left out |
| [For teams](cli/enterprise.md) | Managed policy, audit, spend caps, the bash sandbox and corporate networks |
| [Analysis](cli/analysis.md) | `kubic cost`, `eval`, `benchmark`, `replay`, `export`, `policy` and `audit` |
| [The GitHub Action](cli/github-action.md) | Running Kubic in a workflow |

## Reference

| Page | Covers |
| --- | --- |
| [Commands](cli/commands.md) | Every command by group, and the rules they share |
| [`kubic run`](cli/run.md) | `kubic run`, `attach` and `resume` |
| [TUI keys](cli/tui-keys.md) | Every key, and the keybindings file |
| [Configuration](cli/configuration.md) | Config layers, every key, and `kubic config` |
| [Tools](cli/tools.md) | The tools the model calls: arguments and results |
| [Exit codes](cli/exit-codes.md) | What each exit code means |
| [Doctor and debug](cli/doctor-and-debug.md) | `kubic doctor` and debugging a run |

## Architecture

| Page | Covers |
| --- | --- |
| [Overview](architecture/overview.md) | The system and its package map |
| [In-process runtime](architecture/in-process.md) | One trust zone, no isolation, and the controls instead |
| [Journal and safety](architecture/journal-and-safety.md) | The change journal and the approval model |
| [Threat model](architecture/threat-model.md) | What Kubic defends, against whom, and what is out of scope |
| [Packages](packages/README.md) | One page per package: entry points, invariants and neighbours |

## Contributing

| Page | Covers |
| --- | --- |
| [Contributing](contributing.md) | Setup, the checks, tests, the docs images and the docs style |
| [Building CLI commands](contributing-cli.md) | The command registry, exit codes, `--json` and output helpers |
| [Support policy](support-policy.md) | Supported versions and platforms, and security fixes |
| [Release trust](release-trust.md) | Provenance, the SBOM, signed checksums and code scanning |

Package contracts live with their code: `packages/trajectory/CONTRACT.md` and
`packages/eval/COMMUNITY.md`.
