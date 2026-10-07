# Project trust

> Project-local configuration requires project trust (`.kubic/config.toml`
> is committed). Implementation:
> `packages/host/src/config/trust-store.ts` (the store + the one trust
> report), `packages/host/src/trust-cli.ts` (`kubic trust`),
> `apps/kubic/src/config-runtime.ts` (the prompt and the load gate).

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

The same gate covers the project `models.json`, ancestor project skills,
and the project role documents, so a repository cannot point
a provider — and your API key — at its own URL, nor inject lane instructions,
either. The flip side is what a grant means: **one `yes` covers all four**.
A trusted project's `models.json` may name any `*_API_KEY` (or `KUBIC_*`)
variable as its provider's key, and that key — the real one, if you have it
set — is sent to the provider URL the file names; trusted project skills
and role documents are instructions the model follows. Grant trust only to
a repository whose `models.json`, skills and roles you would run yourself.
Those consumers resolve their files by walking up to the repository
root, so the decision is checked against **the directory the file lives
in**: a grant for `/repo` covers `/repo`'s committed `models.json` and
skills even when a run starts in `/repo/pkg`, while a grant for `/repo/pkg`
never reaches `/repo`. Outside a repository only the cwd itself is
searched, and a user skill root is never reported as a project skill.
The decision is threaded to every consuming command (`run`, `tui`,
`replay`, `models` and `doctor`).

## `kubic trust`

| Invocation | Effect |
| --- | --- |
| `kubic trust` | Records trust for the current directory. |
| `kubic trust <path>` | Records trust for that directory (must exist and be a directory; a symlink to one is followed and recorded under its resolved path). |
| `kubic trust --revoke` | Removes the recorded decision; the refusal comes back. |
| `kubic trust --list` | Prints every recorded decision (`trusted <path>` / `declined <path>`), sorted. |

Grant output names the canonical path, the store file, and whether a
project config is waiting there:

```
$ kubic trust
trusted project /Users/you/src/app (store: /Users/you/.kubic/trust.json)
project config /Users/you/src/app/.kubic/config.toml will load
this grant also covers the project's models.json (provider URLs, sent the key of any *_API_KEY or KUBIC_* variable it names — KUBIC_API_KEY by default), its project skills and its project role documents
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
- **Trust is exact-path.** A decision names the tree its files live in; it
  never applies to a parent or a sibling directory: trusting `/a` does not
  trust `/a-sibling`, and a grant for `/a/b` never unlocks files committed
  at `/a`. Ancestor-resolving consumers (the project `models.json`, project
  skills) check the store for the directory they resolved, so a grant for
  `/a` still applies to `/a`'s own files from any subdirectory.
- **Writes are atomic**: a locked read → tmp+rename update, keys sorted,
  so two concurrent grants cannot lose one another.
- **A broken store fails closed**: reads treat it as "no decision" (every
  command refuses the project layer by name), while `kubic trust` reports
  the broken file and exits 1 instead of overwriting it.

The store is under your home directory, not the repository: a cloned
repository cannot write it, and `kubic trust` is the only writer.

## The interactive prompt

`kubic tui` — and a bare `kubic` on an interactive terminal — resolves
trust before the config load and before the alt-screen opens. When a
project `config.toml` is present and no decision is recorded, it asks once,
as one row in the first screen's language, answered with one
key:

```
  ◆ trust        ~/src/app/.kubic/config.toml found — load project config?
                 This lets the project's own files take effect for runs here:
                 its config.toml sets the model, approvals, permissions and
                 journal retention; its models.json names provider URLs that are
                 sent the key of any *_API_KEY or KUBIC_* variable it names
                 (KUBIC_API_KEY by default); its project skills and role
                 documents are instructions the model follows.
                 y  yes   n  not now   v  view file
```

- **`y` yes** records `true` and boots the lane with the project layer; the
  first screen's trust row then reads `.kubic/config.toml loaded`.
- **`v` view file** prints the config (its first 40 lines, control bytes
  removed) and asks again.
- **`n` not now** records nothing: the lane stops on the refusal (exit 1),
  and the next `kubic tui` asks again.
- **Cancel** (Ctrl-C / Esc) records nothing and fails closed the same way.
- A recorded decision is never asked again. `kubic trust --revoke` removes
  it if you want the question back; `kubic trust` records a grant without
  the question.
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

## Reporting

- `kubic config` prints the project layer's state
  (`trusted` / `distrusted (refused pre-trust; …)`).
- `kubic doctor`'s `config-load` check names how the layer was trusted:
  `project layer trusted (recorded in ~/.kubic/trust.json)`,
  `project layer trusted (KUBIC_TRUST_PROJECT=1)`,
  `project layer not trusted (declined in …; run 'kubic trust' to accept)`
  or `project layer not trusted (no decision recorded; …)`. A store that
  exists but cannot be read or parsed is named there
  (`project layer not trusted (trust store …)`) instead of being passed off
  as an undecided project.
- `kubic models` and `kubic doctor` report the project `models.json` as
  `loaded` or `ignored, untrusted` under the same decision.

## Out of scope

Enterprise-managed allowlists are not implemented: trust is a per-user,
per-path decision. See [configuration](configuration.md) for the layer
precedence and [exit codes](exit-codes.md) for the code table.
