# Project trust

> Design ref: §35 ("Project-local configuration requires project trust";
> `.kubic/config.toml` committed), §35.1. Implementation:
> `packages/host/src/config/trust-store.ts` (the store + the one trust
> report), `packages/host/src/trust-cli.ts` (`kubic trust`),
> `apps/kubic/src/config-runtime.ts` (the prompt and the load gate).
> Issue [#228](https://github.com/konic-labs/kubic/issues/228).

A repository can commit `.kubic/config.toml`, and that file is
configuration: it can change the model, the approval policy, the permission
classes and the journal retention a run executes under. A cloned repository
must not be able to set those by itself, so the project layer is gated.
Before the project is trusted, an existing `.kubic/config.toml` is
**refused by path before it is read** — never silently ignored, never
half-applied — and the refusal names the remedies:

```
error: project-local config refused pre-trust: <path>/.kubic/config.toml — run 'kubic trust' to accept this project, or set KUBIC_TRUST_PROJECT=1 for this invocation
```

The same gate covers the project `models.json` and trusted-ancestor project
skills, so a repository cannot point a provider — and your API key — at its
own URL either. The decision is threaded to every consuming lane (`run`,
`tui`, `replay`, `models`, `doctor`, and orchestrate worker children).

## `kubic trust`

| Invocation | Effect |
| --- | --- |
| `kubic trust` | Records trust for the current directory. |
| `kubic trust <path>` | Records trust for that directory (must exist). |
| `kubic trust --revoke` | Removes the recorded decision; the refusal comes back. |
| `kubic trust --list` | Prints every recorded decision (`trusted <path>` / `declined <path>`), sorted. |

Grant output names the canonical path, the store file, and whether a
project config is waiting there:

```
$ kubic trust
trusted project /Users/you/src/app (store: /Users/you/.kubic/trust.json)
project config /Users/you/src/app/.kubic/config.toml will load
```

Exit codes: **0** recorded, revoked or listed; **1** an unreadable or
corrupt store (the file is named — fix or delete it and run the command
again); **2** a usage error (a path that is not a directory, `--list`
combined with `--revoke` or a path). `kubic trust --help` prints the
generated usage — [commands](commands.md#kubic-trust---revoke---list-path).

## The store

Decisions live in one user-owned file, `~/.kubic/trust.json`:

```json
{
  "/Users/you/src/app": true,
  "/Users/you/src/experiment": false
}
```

- **Keys are canonical paths**: the realpath when the directory exists, so
  a symlinked path and its target share one decision.
- **Values are `true` (trusted) or `false` (declined)**; an absent key is
  "no decision yet". A `null` value is accepted and read as "no decision".
- **Trust is exact-path.** It never applies to a parent or a sibling
  directory: trusting `/a` does not trust `/a-sibling`, and a child
  directory has its own decision. This is stricter than an ancestor walk on
  purpose.
- **Writes are atomic**: a locked read → tmp+rename update (the same
  primitive the orchestrator state files use), keys sorted, so two
  concurrent grants cannot lose one another.
- **A broken store fails closed**: reads treat it as "no decision" (every
  command refuses the project layer by name), while `kubic trust` reports
  the broken file and exits 1 instead of overwriting it.

The store is under your home directory, not the repository: a cloned
repository cannot write it, and `kubic trust` is the only writer.

## The interactive prompt

`kubic tui` — and a bare `kubic` on an interactive terminal — resolves
trust before the config load and before the alt-screen opens. When a
project `config.toml` is present and no decision is recorded, it asks once:

```
Trust project /Users/you/src/app? Kubic will load
/Users/you/src/app/.kubic/config.toml, which can set the model, approvals, permissions and journal retention for runs in this project.
```

(One line on screen — wrapped here for readability.)

- **Accept** records `true` and boots the lane with the project layer.
- **Decline** records `false` and the lane stops on the refusal (exit 1).
- **Cancel** (Ctrl-C / Esc) records nothing and fails closed; the next
  `kubic tui` asks again.
- A recorded decision — accept or decline — is never asked again.
  `kubic trust --revoke` removes it if you want the question back.
- `kubic run` never prompts: it is the non-interactive lane, so an
  untrusted project config refuses with the remedies named. Scripts use
  `KUBIC_TRUST_PROJECT=1` or a prior `kubic trust`.

The prompt only appears when stdin *and* stdout are TTYs. Piped or CI
invocations keep the refusal, so nothing hangs on a question nobody sees.

## `KUBIC_TRUST_PROJECT=1`

The environment variable still works and sits **above** the store: it
accepts the project layer for one invocation and records nothing. Anything
other than `1`/`true` contributes nothing (the store's decision, if any,
still applies). This is the escape hatch for scripts and CI; `kubic trust`
is the durable form.

`kubic orchestrate` inherits this to its worker children: when the manager
is trusted (by the store or the env var), each child is spawned with
`KUBIC_TRUST_PROJECT=1` unless it was already exported, because a child runs
in its own worktree — a different path from the manager's recorded decision.

## Reporting

- `kubic config` prints the project layer's state
  (`trusted` / `distrusted (refused pre-trust; …)`).
- `kubic doctor`'s `config-load` check names how the layer was trusted:
  `project layer trusted (recorded in ~/.kubic/trust.json)`,
  `project layer trusted (KUBIC_TRUST_PROJECT=1)`,
  `project layer not trusted (declined in …; run 'kubic trust' to accept)`
  or `project layer not trusted (no decision recorded; …)`.
- `kubic models` and `kubic doctor` report the project `models.json` as
  `loaded` or `ignored, untrusted` under the same decision.

## Out of scope

Enterprise-managed allowlists are not implemented: trust is a per-user,
per-path decision. See [configuration](configuration.md) for the layer
precedence and [exit codes](exit-codes.md) for the code table.
