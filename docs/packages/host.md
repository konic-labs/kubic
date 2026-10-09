# `@kubic/host`

> The host runtime: approvals, config, roles, doctor and the command
> implementations.
> Source: `packages/host/src`.

`@kubic/host` is everything around the agent lane that decides, records
and reports: the approval safety model, layered config and project trust,
role resolution, `kubic doctor`, the audit ledger, spans and the debug
channel, and the implementations behind the CLI commands. Kubic has
no isolation — docs and code must never imply otherwise.

## Entry points

The package is a set of concern folders. Each folder's `index.ts` is its
public entry and the package export `@kubic/host/<folder>`; a module in one
folder reaches another folder only through that entry (`npm run lint:deps`
rejects a deep import into another folder's modules). Entry exports that
exist only for tests are tagged `@internal`.

| Folder | Owns |
| --- | --- |
| `approvals/` | The approval policy and its posture, the stores and the decider service, full access, the trigger detectors over the shell lexer, control-plane refusal, the credential-path detector and what an approval card shows |
| `audit/` | The audit ledger (location, redacting append, reads), its records, the configured sinks and the syslog transport, and `kubic audit` |
| `cli/` | Shared command plumbing: the output channels and theme, and project-root discovery |
| `config/` | Layered TOML config and its validation, the runtime load every command runs on, comment-preserving edits, project trust, and `kubic config`, `setup` and `trust`; `config/schema` declares every key once, and the parser, the runtime, `example.toml` and the configuration docs derive from it |
| `cost/` | `kubic cost`: per-session cost rows, the prompt-cache hit rate and the usage a headless run reports |
| `doctor/` | `kubic doctor`: the checks in report order, the grouped summary, the honest-limit checks and the no-isolation notice |
| `git/` | `kubic git` (status, log, stage, commit) over the agent's git operations |
| `journal/` | `kubic diff`, `undo`, `log`, `status` and `journal prune` |
| `models/` | The model catalogue (built-ins plus `models.json`), provider probes, the `faux` testing provider, key hints and `kubic models` |
| `policy/` | The enterprise policy: layer validation, resolution, the tool, model and provider gates, its doctor checks and `kubic policy` |
| `presentation/` | Folds lane events and approval facts into the `KubicPresentationState` the TUI renders |
| `replay/` | `kubic replay` over trajectory exports, and the re-execution runner |
| `roles/` | The built-in roles, role documents and their layer merge, and loading `.kubic/roles/*.md` |
| `run/` | `kubic run`: argument parsing, the result envelope and exit codes, spans, the run trajectory, and the `[verify]` gates whose results become `signal:<gate>` labels |
| `secret-refs/` | Request-time secret references (`$ENV_VAR`, `!command`), the model key resolver and redaction of resolved secrets |
| `sessions/` | `kubic sessions` and pruning, read-only session access for listings and cost, per-session summaries and usage |
| `skills/` | The skills boot the lane runs, and `kubic skills` |
| `test-support/` | Test-only fixtures; the dependency lint keeps them out of production code |

`config/` and `approvals/` stay folders rather than packages: `config/`
validates the `[approvals]` table with the approval policy and reads the
enterprise policy, and `approvals/` writes the audit ledger, so either
package would depend back on the rest of the host.

## Invariants

- **An approval asks; it never grants silently.** The lane awaits the ask
  in its `ToolTask.beforeTool` hook, before the tool's intent is committed:
  an unanswered ask is denied after `maxPendingMs`, and a crash mid-ask
  raises it again on resume. The bash detectors over-trigger on purpose,
  since a raised capability becomes an ask. `kubic-state-write` always asks,
  and writes into `.kubic/journal|audit|sessions` (the workspace's, an
  ancestor's, `~/.kubic`'s, or the session root in use) are refused outright.
  The capabilities and triggers are on the [approvals page](../cli/approvals.md).
- **The committed/ignored split is derived, not kept twice.**
  `GITIGNORE_REQUIRED_ENTRIES` comes from `@kubic/exec`'s runtime-exclude
  list, and `.kubic/` itself is never ignored, so `config.toml` and
  `roles/*.md` stay committable. An `[mcp]` table fails closed.
- **Spans go to two places:** stderr behind `kubic run --debug`, and
  `spans.jsonl` in the session directory. A tool span opens in the
  `kubic.spans` extension's `beforeTool` hook, which runs after
  `kubic.policy`, so a blocked call opens no span. A call that never settled
  is closed by `endRun` with an error, not written open. See
  [where the spans go](../cli/run.md#where-the-spans-go).
- **Doctor discloses; it does not block.** `session:overlap` (two sessions
  on one workspace) and `state:permissions` (a group- or world-readable
  sessions root) are warnings, and a probe that throws reports itself
  unverified. Exit codes: 0 clean, 6 provider down, 1 any other failure,
  2 usage ([doctor](../cli/doctor-and-debug.md)).
- **Pruning is opt-in twice.** `kubic sessions prune` is a dry run without
  `--yes`, and the keep window must be given (`--keep-days` or
  `session.retentionDays`). A session holding a live lock is never a
  candidate, and the lock is checked again right before each delete. Only
  `<sessions-root>/<id>/` state directories are touched
  ([retention](../cli/sessions.md#session-retention-prune)).

## Neighbours

- Imports: core, exec, [agent](agent.md) and
  [trajectory](trajectory.md) (replay and the run trajectory); never
  [tui](tui.md).
- Imported by: `apps/kubic`, the composition root that wires host and tui.

```text
core + exec ──→ agent ──→ @kubic/host ──→ apps/kubic
                               ↑
                          trajectory
```

Back to the [docs index](../README.md).
