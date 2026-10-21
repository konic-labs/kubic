# Project trust

> Project-local configuration requires project trust (`.kubic/config.toml`
> is committed). Implementation:
> `packages/host/src/config/trust-store.ts` (the store + the one trust
> report), `packages/host/src/config/trust-cli.ts` (`kubic trust`),
> `apps/kubic/src/config/load.ts` (the prompt and the load gate).

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
the project role documents and the project's `AGENTS.md` files, so a
repository cannot point a provider — and your API key — at its own URL, nor
inject lane instructions, either. The flip side is what a grant means:
**one `yes` covers all five**. A trusted project's `models.json` may name
any `*_API_KEY` (or `KUBIC_*`) variable as its provider's key, and that key
— the real one, if you have it set — is sent to the provider URL the file
names; trusted project skills, role documents and `AGENTS.md` files are
instructions the model follows. Grant trust only to a repository whose
`models.json`, skills, roles and `AGENTS.md` you would run yourself.
Those consumers resolve their files by walking up to the repository
root, so the decision is checked against **the directory the file lives
in**: a grant for `/repo` covers `/repo`'s committed `models.json` and
skills even when a run starts in `/repo/pkg`, while a grant for `/repo/pkg`
never reaches `/repo`. Outside a repository only the cwd itself is
searched, and a user skill root is never reported as a project skill.
The decision is threaded to every consuming command (`run`, `tui`,
`replay`, `models` and `doctor`).

## `kubic trust [--revoke] [--list] [--diff] [path]`

Record, revoke or list the durable project-trust decision that makes a
committed `.kubic/config.toml` usable — see [project trust](trust.md).
`kubic trust` grants trust for the current directory (or the `[path]`
operand — a directory, or a symlink to one: the grant is recorded under the
resolved path), `--revoke` removes the recorded decision so the pre-trust
refusal comes back, and `--list` prints every recorded decision. **One
grant covers the whole project tree**, not only `config.toml`: the
committed `.kubic/config.toml`, the project `models.json` (its provider
URLs are sent the key of any `*_API_KEY` or `KUBIC_*` variable it names,
`KUBIC_API_KEY` when it names none), the project's `AGENTS.md` and the
project skills. The help, the interactive prompt and the grant output all
say so. **A grant covers the content it was given for**: once any of the
project's trust-relevant files changes — a pulled commit, a checked-out
branch, a local edit — the project is untrusted again until you re-confirm
it (see [What a grant covers](#what-a-grant-covers)). Exit 0 on success; a corrupt store is named and exits 1; a path that
is not a directory, or `--list` combined with `--revoke`/a path, exits 2.

## `kubic trust`

| Invocation | Effect |
| --- | --- |
| `kubic trust` | Records trust for the current directory. |
| `kubic trust <path>` | Records trust for that directory (must exist and be a directory; a symlink to one is followed and recorded under its resolved path). |
| `kubic trust --revoke` | Removes the recorded decision; the refusal comes back. |
| `kubic trust --list` | Prints every recorded decision (`trusted <path>`, `changed  <path>` for a grant whose files changed since, `declined <path>`), sorted. |
| `kubic trust --diff [path]` | Prints what changed in the project since its grant and records nothing (see [What a grant covers](#what-a-grant-covers)). |

Grant output names the canonical path, the store file, and whether a
project config is waiting there:

```
$ kubic trust
trusted project /Users/you/src/app (store: /Users/you/.kubic/trust.json)
project config /Users/you/src/app/.kubic/config.toml will load
this grant also covers the project's models.json (provider URLs, sent the key of any *_API_KEY or KUBIC_* variable it names — KUBIC_API_KEY by default), its AGENTS.md and its project skills
it covers these files as they are now: a change to any of them makes the project untrusted until you run 'kubic trust' again
```

## What a grant covers

A grant records a fingerprint: one digest over every project file the grant
lets take effect.

- the `.kubic/` tree — `config.toml`, `models.json`, role documents and
  anything else there — except the runtime state Kubic writes itself
  (`audit/`, `journal/`, `sessions/`);
- a root `models.json`;
- a root `AGENTS.md` (an `AGENTS.md` in a subdirectory belongs to that
  directory's own grant, as its skills do — see
  [Project instructions](configuration.md#project-instructions-agentsmd));
- the project skills: `.pi/skills/`, `.agents/skills/`, and the skill
  directories `package.json` declares (its `skills` and `pi.skills` lists —
  never the rest of the file, so a dependency bump does not ask again);
- the `[agent] systemPromptFile` the project config names, when it lives
  inside the project.

A grant also keeps a **snapshot** of those files — each one's digest, and its
text when it is a text file under 64 KiB (1 MiB in all) — in
`~/.kubic/trust-snapshots/`, private like the store (`0600` files in a `0700`
directory). It is what a review compares against; the grant itself is the
fingerprint. A revoke or a decline drops it.

When the fingerprint no longer matches, every consumer treats the project
as untrusted: the config load refuses with `project-local config changed
since the project was trusted: <path> — review …, then run 'kubic trust'`,
the project `models.json` and skills are left out, `kubic tui` asks the
trust question again (saying the project changed), and `kubic trust --list`
and `kubic doctor` report it as changed. Review the change, then run
`kubic trust` to accept the new content:

- `kubic trust --diff` prints what changed since the grant and records
  nothing: a unified diff per changed file, `added <file>` and
  `removed <file>` with their lines, and a note for a binary or oversized
  file whose text the snapshot did not keep. It is cut at 400 lines.
- `kubic trust` on a changed project prints the same review before it
  records the new grant.
- The interactive question says the project changed and adds a `d` key
  (view changes) that prints the review and asks again.

A grant recorded before snapshots has nothing to compare against: the review
then lists every file the grant covers, for you to read before you trust it.

```
$ kubic trust --diff
1 file changed in /Users/you/src/app since the last grant:
--- a/.kubic/config.toml
+++ b/.kubic/config.toml
@@ -1,2 +1,3 @@
 [approvals]
 route = "ask-user"
+autoApprove = ["destructive-shell"]
```
A directory granted before its config existed changes when one appears.

Exit codes: **0** recorded, revoked or listed; **1** an unreadable or
corrupt store (the file is named — fix or delete it and run the command
again); **2** a usage error (a path that is not a directory, `--list`
combined with `--revoke`, `--diff` or a path, or `--diff` with `--revoke`).
`kubic trust --help` prints the generated usage —
[commands](#kubic-trust---revoke---list---diff-path).

## The store

Decisions live in one user-owned file, `~/.kubic/trust.json`:

```json
{
  "/Users/you/src/app": {
    "trusted": true,
    "fingerprint": "sha256:5c0f…"
  },
  "/Users/you/src/experiment": false
}
```

- **It is private.** The file is written `0600` and a new `~/.kubic` is
  created `0700`, whichever command creates it first; a loose `~/.kubic` is
  tightened to `0700` on the next `kubic trust` write.
- **Keys are canonical paths**: the realpath when the directory exists, so
  a symlinked path and its target share one decision.
- **Values are a grant (`trusted` plus the `fingerprint` of the content it
  covers) or `false` (declined)**; an absent key is "no decision yet". A
  `null` value is accepted and read as "no decision", and a bare `true` — a
  grant recorded before fingerprints — reads as changed, so it is
  re-confirmed once.
- **Trust is exact-path.** A decision names the tree its files live in; it
  never applies to a parent or a sibling directory: trusting `/a` does not
  trust `/a-sibling`, and a grant for `/a/b` never unlocks files committed
  at `/a`. Ancestor-resolving consumers (the project `models.json`, project
  skills, `AGENTS.md`) check the store for the directory they resolved, so a grant for
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
                 its config.toml sets the model, approvals, permissions, journal
                 retention and which paths the journal records, and its [verify]
                 commands run as shell commands after each run; its models.json
                 names provider URLs that are sent the key of any *_API_KEY or
                 KUBIC_* variable it names (KUBIC_API_KEY by default); its
                 project skills, role documents, AGENTS.md and [agent]
                 systemPromptFile are instructions the model follows.
                 y  yes   n  not now   v  view file
```

A project whose files changed since its grant is asked about the same way,
headed `<project> changed since you trusted it — load its project config
again?`, with a fourth key, `d  view changes`, that prints the review.

- **`y` yes** records a grant for the project as it is now and boots the
  lane with the project layer; the first screen's trust row then reads
  `.kubic/config.toml loaded`.
- **`v` view file** prints the config (its first 40 lines, control bytes
  removed) and asks again.
- **`n` not now** records nothing: the lane stops on the refusal (exit 1),
  and the next `kubic tui` asks again.
- **Cancel** (Ctrl-C / Esc) records nothing and fails closed the same way.
- A recorded decision is not asked again while the project's files stay as
  they were. A grant whose files changed is asked again, and the question
  says the project changed since you trusted it. `kubic trust --revoke`
  removes a decision if you want the question back; `kubic trust` records a
  grant without the question.
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
  `project layer not trusted (declined in …; run 'kubic trust' to accept)`,
  `project layer not trusted (its files changed since the grant in …; …)`
  or `project layer not trusted (no decision recorded; …)`. A store that
  exists but cannot be read or parsed is named there
  (`project layer not trusted (trust store …)`) instead of being passed off
  as an undecided project.
- `kubic models` and `kubic doctor` report the project `models.json` as
  `loaded` or `ignored, untrusted` under the same decision.

## Out of scope

Enterprise-managed allowlists are not implemented: trust is a per-user,
per-path decision. An organization can still bound what a trusted project may
set with `[policy] project_policy = "restricted"` — see
[Restricting project configuration](enterprise.md#restricting-project-configuration). See [configuration](configuration.md) for the layer
precedence and [exit codes](exit-codes.md) for the code table.
