# Sessions: `kubic sessions`

> Listing, creating, attaching, forking and pruning the durable sessions a run
> or the TUI works in. Back to the [command index](commands.md).

## `kubic sessions`

Sessions live under `~/.kubic/sessions` by default. A bare `kubic sessions`
lists them, as `kubic sessions list` does (`--json` included). Each subcommand
has its own generated help (`kubic sessions prune --help`).

| Subcommand | Meaning |
| --- | --- |
| `create [--cwd <path>] [--dangerously-skip-approvals]` | Create a session, print its id on stdout. `--cwd` sets the session directory (default: current directory): a relative path resolves against the invoking directory (never the sessions root) and must name an existing directory, otherwise create refuses with `kubic sessions create: --cwd <path>: no such directory` (or `not a directory` for a path that exists but is not one; exit 1) and creates nothing. `--dangerously-skip-approvals` records session-scoped full-access in the session dir, appends one `posture:full-access` row to the audit ledger (session id, `kubic sessions create --dangerously-skip-approvals`), and prints a `warn:` line on stderr — fresh sessions start safe, the flag must be passed explicitly every time. |

| `list [--json]` | A `SESSION  CWD` table (plain aligned columns off a terminal, the kit table on an interactive colour terminal). With no sessions stdout stays empty and an `info:` line on stderr says so. `--json` prints one pretty-printed array of `{id, cwd}` objects — `[]` when there are none. **`kubic sessions` with no subcommand is the same command**: the table, or with `--json` the same array. |
| `attach [--] <id> [--tail <n>] [--ids] [--json]` | Print session metadata, the approvals posture (`approvals enforced` or `full-access …`), the `pending work: <kind> <id> (<status>)` summary when a crashed run left unfinished durable work (settled by the next `run`/`tui --session`), then the last `--tail` transcript turns (default 10) — one readable line per turn (`user: …`, `assistant: …`, `tool-result <name>: …`, `system: …`, `[compaction] …`, `[reset] …`), whitespace collapsed and bounded to 300 characters; transcript text and model-authored tool names are untrusted, so terminal control sequences are stripped before a line is printed. `--tail` needs a non-negative integer. `--ids` prefixes each transcript line with its entry id (` user: …`) — the id `kubic sessions fork --at` takes. `--json` prints the raw tail entries instead — one full untruncated entry JSON per line, for scripting. |

| `fork [--] <id> [--at <entry>] [--tree] [--json]` | Fork a session into a **new** one and print the new id — `--json` prints one `{id, source, at}` document (`at` is `null` for `--tree`). The id works at once with `kubic run --session` / `kubic tui --session`. A **branch fork** (the default) cuts *at* an entry, inclusive — `--at <entry>` names it (`kubic sessions attach <id> --ids` prints them), default the source's newest — and the new session's lane is a pi-durable fork of the source's: it sees the history through that entry and the agent (model, thinking level) as of it, and nothing after it. **`--tree`** copies the whole session instead: every conversation and branch tip, the lane unchanged. Either way the new session has its **own** directory, lock and an empty journal, starts with **no usage** (the copied `pi.usage` documents are emptied, so `kubic cost` never counts the source's spend twice), and starts with **approvals enforced** — the source's posture, approvals and journal are not copied. The source is only read, under its own lock: forking a session another process holds live is **refused** (the lock refusal naming the holder, exit 1, nothing written), as is a missing session (exit 1) and an `--at` entry the source does not have (exit 1). `--at` with `--tree` is a usage error (exit 2). |

| `prune [--keep-days <n>] [--keep-session <id>]... [--yes] [--dry-run]` | Retention for session **state dirs** (`<sessions-root>/<id>/`): **lists by default, deletes only with `--yes`** (or a yes at the terminal prompt). See [Session retention](#session-retention-prune) below. |

A session can hold several **branches**: the TUI's `/tree` moves a session to
an earlier point in place, as a pi-durable fork of its lane inside the same
storage, and the branch it leaves stays in the session. `attach`, `run
--session` and `tui --session` follow the branch the session is on, and
`kubic cost` counts every branch. `fork` is the command that copies a session
into a new one.

Usage errors exit 2 on stderr: an unknown option, a missing value, `attach` without an
id or with an id outside `[A-Za-z0-9_-]`, a malformed `--tail`,
`--keep-days` or `--keep-session`, and `--yes` with `--dry-run`. An
unknown subcommand exits 2 (`error: unknown command '<name>'`), like an
unknown top-level command. Attaching a missing session exits 1; attaching
a session another process holds live prints the lock refusal (the holder's pid and start time are named) and exits 1 without reading
the transcript. An id with no session storage, including a folder that holds
only a transcript file, is an unknown session and exits 1 the same way.

The transcript `attach` prints is the durable one, read through the shared
pi-durable adapter (`packages/agent/src/lane/transcript.ts`)
and never by booting a lane: a reader must be able to inspect a session it
may not run.

### Session storage

A session is one directory, `<sessions-root>/<id>/`, holding the
pi-durable JSONL storage (`main.jsonl` and its `doc-*.jsonl` sidecars —
the transcript, documents and durable tasks), Kubic's `session.json`
listing header, the lock, the journal, spans, approvals posture and
trajectory. The session's metadata is the session-scoped `kubic.session`
document, written in the creating commit, so anything holding the session
open reads it from the same durable state as the transcript. Session JSONL
is not fsynced; the change journal is the fsync'd store. The directory is
`0700` and every file in it `0600`.

`kubic run` creates its session before it boots the lane, so a run that
fails before the model answers — no provider, a refused model — is still a
recorded session: the `--json` envelope names its `session:`, `journal:`,
`usage:` and `trajectory:` refs, `kubic sessions list` lists it, and
`kubic sessions prune` removes it like any other once it is past the keep
window.

A folder without that storage is not a session: it is never listed, the
overlap warning (`kubic doctor`) never counts it, and attaching it exits 1
as an unknown session. Kubic never converts, moves or rewrites such a
folder, and `kubic sessions prune` only ever considers `<root>/<id>/`
directories that hold a session ([below](#session-retention-prune)).

### Session retention (`prune`)

Everything a run persists stays under `~/.kubic/sessions` until you say
otherwise: per-session state dirs (`<root>/<id>/` — the journal store,
`spans.jsonl`, approvals posture, and the session lock) grow for the
lifetime of the machine, so retention is explicit and opt-in. `prune` is
the only thing that deletes whole session state dirs, and it never deletes
what it cannot account for — the same window also self-heals aged session
journal entries at read time (see the read-time self-heal note under
[`kubic log`](journal.md#kubic-diff--undo--log--status)):

- **Dry-run is the default.** Without `--yes`, `prune` lists every
  candidate as `would prune <id> (<bytes>B)` plus the summary
  `dry run: N session(s) would be pruned (NB) — pass --yes to delete`, and
  removes nothing. On an interactive terminal (stdin and stdout both a
  TTY) and without `--dry-run`, it asks once after the list —
  `Delete N session(s) (NB)?` — and deletes only on yes; no, Ctrl-C or Esc
  keeps everything and prints the dry-run summary. Off a terminal it
  never asks. `--dry-run` is the explicit synonym of that default;
  `--yes` deletes the listed set (`pruned <id> (<bytes>B)` per session,
  then `pruned N session(s), NB reclaimed`; a candidate whose lock goes
  live in between is skipped and never counted — see the lock bullet
  below). `--yes` with `--dry-run` contradicts and is refused by name.
  `nothing to prune` exits 0.
- **The keep window is never invented.** `--keep-days <n>` (a
  non-negative integer of days) wins; without it, `session.retentionDays`
  from config supplies the window; with neither, `prune` exits 1 naming
  both ways to set one (on stderr). `--keep-days 0` — or `retentionDays = 0` — means
  retention is off: nothing is ever pruned.
- **Age is the session dir's own mtime** (create, attach, and close all
  bump it): a session is a candidate when that mtime is at or before
  `now − keepDays`. A session attached recently survives even if the files
  inside it are old.
- **A live lock is a hard stop.** A session holding a `lock.json` whose
  holder pid is alive is never a candidate, even when old and even with
  `--yes`: it is reported `locked: <id> (held by pid <pid> since <iso>) —
  skipped`. The lock is re-checked immediately before each delete, so a
  session locked between planning and the delete pass is skipped and
  reported the same way — never counted as pruned. A **stale** lock (dead
  holder, or a torn file) never protects. Lock liveness is
  **process-local**: it reads this machine's process table, so a session
  held by a run on another machine or in another container is not seen as
  held (the same local-filesystem-only caveat the lock itself carries —
  see [agent](../packages/agent.md#invariants)). The
  probe is `process.kill(pid, 0)`: any result other than success —
  including `EPERM` for a pid this user cannot signal — reads as dead;
  same-user holders always signal, so a per-user sessions root never
  mis-reads one.
- **`--keep-session <id>`** (repeatable, ids `[A-Za-z0-9_-]`) protects a
  session by name even when aged; the name is reported
  `kept: <id> (--keep-session)` when it is what spared an aged session — a
  recent session is never a candidate anyway, and a live-locked one is
  reported `locked:` instead.
- **Only session-shaped entries are touched.** Plain files, a stray
  `lock.json`, names outside `[A-Za-z0-9_-]`, and any folder that holds no
  session file (`main.jsonl`, `session.json` or `lock.json`), such as a
  folder with only transcript files, are never touched. A session that
  cannot be inspected is skipped and reported
  (`unreadable: <id> — skipped`), never guessed at. A missing sessions
  root is a fresh machine: `nothing to prune`, exit 0. A root that exists
  but cannot be listed refuses by name, exit 1.
- **Scope.** `prune` deletes `<sessions-root>/<id>/` state dirs only —
  never anything outside the sessions root. A durable session's transcript lives INSIDE its state dir
  (`main.jsonl`), so pruning a session deletes its transcript with it.
  Folders that hold no session file are not part of this command.
