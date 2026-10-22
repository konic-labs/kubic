# Reviewing and reverting changes

> `kubic diff`, `undo`, `log` and `status` read and revert the change journal,
> with or without git. `kubic git` and `kubic commit` cover git, and `kubic
> journal prune` trims the journal.

## `kubic diff | undo | log | status`

VCS-independent change journal — works without git. Each command reads
one store, resolved in this order:

1. `--session <id>` names the store explicitly: the `kubic run` session
   journal at `<sessions-root>/<id>/journal` (`~/.kubic/sessions` by
   default). `kubic run` prints the session's ref as `journal:<id>`; pass
   it verbatim (`--session journal:<id>` or `--session <id>`). It works
   from any cwd, and it always operates on **the session's own recorded
   workspace** (the cwd the session was created in): `kubic undo --session
   <id>` run from another project restores files under the session's
   workspace, never under the current directory. An id that names no
   session — no session storage and no journal at
   `<sessions-root>/<id>/` — is refused by every journal command alike:
   `error: unknown session: <id>` on stderr, exit 1, nothing read or
   written, and under `--json` one failure document on stdout,
   `{"ok": false, "exitCode": 1, "session": "<id>", "root": null, "error":
   {"code": "unknown_session", "message": "unknown session: <id>"}}`,
   never an empty `diff` or `log` that reads as success.
2. Without `--session`, the **latest session journal recorded for this workspace**:
   among the sessions whose recorded cwd is the current directory or
   contains it (compared after resolving symlinks), the most recently
   written run journal. Another project's session is never picked, however
   recent. When more than one session is recorded here, the note on stderr
   names the others (`also here: <id>, … — pass --session <id> to pick
   another`), and a bare `undo` refuses — exit 1, nothing restored — while
   any of the others is attached by a live process, because "the latest
   run" is then a moving target: it names every candidate and asks for
   `--session <id>`. `diff`, `log` and `status` keep reading the latest.

A session store is named on stderr before any output, together with the
workspace its paths resolve against: `info: session: <id> (latest session
journal for this workspace) — workspace <root>` for the fallback, `info:
session: <id> — workspace <root>` for `--session` (the fallback's note also
names the other sessions recorded for this workspace). `--json` prints nothing
extra on stderr; every `--json` document carries the resolved store as
`session` (the id, or `null` when no journal is recorded for this workspace) and `root` (the
workspace the paths resolve against): `diff --json` is `{session, root,
changes}`, `log --json` is `{session, root, entries}`, and `undo`/`status`
add both fields to their objects.

Every journal entry, and every change `diff --json` reports, carries
`source`: `tool` for a tool call, `sweep` for the end-of-run reconciliation
(the entries flagged `unattributed`), and `undo` for an undo's own record.
A journal written before entries carried `source` is read with one derived on
read: a line recorded under the `kubic-undo` agent id is `undo`, a line flagged
`unattributed` is `sweep`, and every other line is `tool`. Reading derives it
and writes nothing back. A prune that rewrites the index persists the derived
`source` on each line it keeps. Undo and `diff` see those sources, so an
earlier session undoes, previews and prunes exactly as it did before.

`undo` and `status` refuse a session store whose workspace cannot be used —
exit 2, nothing read or written, a named reason on stderr: `session <id>:
recorded workspace <root> no longer exists — …` when the recorded directory
is gone, and `session <id>: no recorded workspace — …` for a session
journal the session store has no cwd for. `diff` and `log` read only the
journal, so they still work for such a session.

When no session journal is recorded for the current directory, every
command reads an empty journal and exits 0: `diff` prints `no changes` on
stdout plus a note on stderr naming where it looked — `info: no session
journal recorded for this workspace under the sessions root (<root>) — start
a run or pass --session`; `log` prints `journal is empty`, `undo` `nothing to
undo`, `journal prune` `nothing to prune`, and `status` counts zero entries
and still reports the repository. `undo --dry-run` plans against the same
store `diff` reads. Session ids accept only
`[A-Za-z0-9_-]` — anything else (including `../` or absolute paths) is a
usage error (`error: invalid --session id …` on stderr, exit 2) before any
path is touched. With no journal recorded, the `status` repo line resolves
against the current directory. `--session` combined with a programmatically
configured journal dir is refused (one store per invocation, exit 2).

### Output channels

The report — the diff, undo verdicts, the log table,
the status lines, or the one `--json` document — goes to stdout.
Diagnostics (the fallback note, the empty-journal note, undo warnings as
`warn: …`) go to stderr, so `kubic diff --json | jq` always sees pure
JSON. On a colour terminal (TTY, no `NO_COLOR`, not `TERM=dumb`) the diff
is coloured — additions green, removals red, `@@` hunk headers amber, file
headers bold, attribution lines grey — undo verdict words are coloured, and
`log` is the kit table (muted header, faint rule); piped, redirected or under `--json` everything
is plain text.

**Usage errors** exit **2** with one `error:` line on stderr and touch
nothing: an unknown option, an option without its value (`--path`,
`--session`, `--max-content-bytes`), a `--max-content-bytes`
that is not a non-negative integer, an extra operand (only `undo` takes
one, the `<path>` scope), a bad or conflicting `--session`. Every command
answers `--help`/`-h` with generated help (exit 0); `diff --help` and
`undo --help` include examples.

### Read-time self-heal

With `session.retentionDays` set in
config, `kubic log` drops entries older than that window from a **session**
journal as it reads it — via `--session <id>` or the latest-session
fallback — the same age bound `kubic sessions prune` applies to whole
session dirs, one entry at a time. With retention
unset — or `0` — the log path writes nothing: reads never mutate the store.
Entries are removed on request by [`kubic journal prune`](#kubic-journal-prune---session-id---keep-days-n---yes---json),
which lists them by default.

```
kubic diff [--path <path>] [--max-content-bytes <n>] [--session <id>] [--json]
kubic undo [--step] [--dry-run] [--force] [--session <id>] [--json] [--] [<path>]
kubic log [--session <id>] [--json]
kubic status [--session <id>] [--json]
```

Options also take the `--flag=value` form (`--path=src/a.ts`).

| Subcommand | What it does |
| --- | --- |
| [`diff`](#diff) | Show the journaled changes as a diff. |
| [`undo`](#undo) | Restore the journaled changes. |
| [`log`](#log) | List the journal entries. |
| [`status`](#status) | Count the entries, and show the repository. |

### `diff`

`diff [path] [--path <p>] [--json] [--max-content-bytes <n>] [--session <id>]`

Rendered diff of journaled changes (`no changes` + exit 0 when empty). The `[path]` operand scopes exactly like `--path` (giving both with different values exits 2 naming the conflict; a second operand is refused the same way); `--stat` prints the per-file summary `path +added -removed tool[, turn N]` instead of hunks (counts from the same hunks, so they always agree; tool and turn render when the entry carries them — entries without them show the op, reconciliation finds `reconciled`); `--path` filters; `--json` prints `{session, root, changes}` — the change array with each side clipped at 64 KiB per change (`--max-content-bytes <n>` overrides the bound; `0` = unlimited). `--json` wins over `--stat`: given both, the output is the JSON change array, not the summary. A `--path`/`--session` without a value, or a `--max-content-bytes` that is missing or not a non-negative integer, is a usage error (exit 2). Read-only: `undo` keeps the single-store contract (undo across worktrees is out of scope).

### `undo`

`undo [--] [<path>] [--step] [--dry-run] [--force] [--json] [--session <id>]`

Restore journaled changes. `--json` prints one object `{session, root, dryRun, restored: [paths], skipped: [{path, kind: stale\|already-undone\|non-reversible\|head-moved\|contested, reason}]}` (also when there is nothing to undo) with the same exit codes. Positional `<path>` limits scope; `--step` restores one step; `--dry-run` prints `would restore N step(s)…` and exits 0 without touching anything. Real runs print `restored <p>` per path plus a summary; warnings (a removal whose content had no recoverable copy, a pre-undo file that is no longer lossless utf-8 text — recorded hash-only, so that undo cannot be redone — or a step whose inverse record would not fit the journal's byte bound — that step is skipped BEFORE the file is touched, so the undo never lands unrecorded) go to stderr as `warn: …`. A session whose lock is live refuses the whole invocation with one `error: session '<id>' is attached by pid <pid> — refusing to undo under a live run (pass --force to override)` line and exit 1: restoring under a live run races its writes, and `--force` is the documented override (the same knob the staleness refusal uses). `nothing to undo` exits 0. **Exit 1 when any step was skipped** (the partial outcome never reuses the usage code) — five skip classes, each with its own line: `non-reversible (skipped): <p>` (no retrievable pre-image: an unattributed reconciliation find with no git pre-image (untracked, dirty at baseline, non-repo, binary or over-bound) or whose tool chain stored none, a write over a file above the 8 MiB pre-image bound (recorded hash-only), a delete-shaped undo whose file was absent pre-undo, or an inverse record over the journal's byte bound), `stale (skipped): <p> — <reason>` (the file changed after the entry was journaled — restoring would destroy unjournaled changes), `already undone (skipped): <p>` (a previous undo already unwound it — nothing is rewritten), `head-moved (skipped): <p> — <reason>` (the entry predates a HEAD move the run observed — restoring would write pre-move content onto the moved HEAD; `--force` overrides per-invocation), `contested (skipped): <p> — <reason>` (a sweep find recorded while another session was live in the workspace — the change may be that session's work; `--force` overrides). The summary is `undo: N restored, M non-reversible` when all skips are the non-reversible class, else `undo: N restored, M skipped (K stale, J already undone)` naming the counts present. The `--session` value selects the store, never the path scope.

#### Undo staleness safety

Before any restore, the file's
current content is verified against the entry's recorded after-hash — undo
must never overwrite a file whose state the journal does not account for.
Verdicts are walk-aware: a whole-run undo judges each step against the state
the previous steps left (and `--dry-run` simulates exactly what a real run
would write), so layered edits unwind in order. The matrix:

| current file | entry after-state | verdict |
| --- | --- | --- |
| exists, hash == recorded after | content present | restore |
| exists, hash != recorded after | content present | **stale: skip** (a change landed after the entry — restoring would discard it) |
| missing | content present | restore (recreates the file; nothing on disk is destroyed) |
| exists | delete entry (after is null) | **stale: skip** (recreated after the recorded delete) |
| missing | delete entry (after is null) | restore (brings pre-delete content back) |
| exists at a journaled *before*-state | any | **already undone: skip** (a prior undo reached this state — re-writing would be a no-op mislabeled as restored) |
| exists but unreadable | any | **stale: skip** (cannot verify — refuse) |
| exists, hash == recorded after | agent **create** (no before) | restore = **remove the file** (its pre-state was "absent") |
| missing | agent **create** | **already undone: skip** (already absent — also with `--force`) |

An agent-authored create (the write tool made a new file) reverts by removing
the file; the removal is journaled as a `kubic-undo` delete carrying the
removed content, so `kubic undo --step` right after it is the redo.
Unattributed reconciliation creates stay non-reversible.

`--force` overrides the stale refusals per-invocation (nothing persists it;
the next `undo` re-checks by default). `--force` does not override
non-reversible skips — no pre-image exists to write. Already-undone skips are
informational: there is nothing to force.

#### The undo record and redo

Every successful restore is
itself journaled: the store appends the inverse entry for the step — the
pre-undo content as `before`, the restored content as `after`, attributed
`toolCall=none` and never marked `reconciled` (it is an
attributed change, not a reconciliation find). `kubic diff` and `kubic log`
therefore describe the world *after* the undo, and `kubic undo --step`
immediately after an undo is the **redo**: it restores the undo record's
`before` — the content the undo replaced. An edit-shaped undo (the file
existed before it) carries that `before`, so undoing it is the redo and can
be repeated; a delete-shaped undo (the file was absent pre-undo) has no
before-content, so `--step` on it reports it non-reversible instead — the
undo of a delete cannot itself be undone. Plain `undo` (no `--step`) never
targets `kubic-undo` records: it restores real agent work once and then
reports `already undone` without appending, so repeating it never re-undoes
the undo. `--dry-run` appends nothing; a skipped step appends nothing.

### `log`

`log [--json] [--session <id>]`

With `session.retentionDays` set and the session's lock live, the read-time self-heal is skipped with one `warn: journal retention skipped: session '<id>' is attached by pid <pid> — pruning under a live run can drop entries it just appended` line; the read itself is unchanged. A `TIME TOOL CALL OP PATH BYTES NOTE` table, one row per journal entry, oldest first — `NOTE` reads `reconciled` for an unattributed sweep find (`reconciled, contested by session <id>` for one recorded while another session was live in the workspace) (`journal is empty` + exit 0 when empty); `--json` prints `{session, root, entries}` with the raw entries array. The human output closes with the reconciliation line `unattributed: N of M entr(ies) reconciled at run end` (printed for an empty journal too).

### `status`

`status [--json] [--session <id>]`

`--json` prints the status object (`session`, `root`, `entries`, `reversible`, `nonReversible`, `unattributed`, `corrupt`, `corruptLines`, `unknownVersionLines`, `repo`); `unknownVersionLines` counts index lines a newer Kubic wrote in a format version this one cannot read — left out of `diff` and `undo`, kept in place, and named in the human output when there are any. Otherwise `entries: N (reversible: R, non-reversible: M)`, then `unattributed: U of N (reconciled at run end)`, then `corrupt: C` (content missing under a recorded hash) and `corrupt index lines: L` (index lines that do not parse and were dropped from the read — a torn tail from a crash or a full disk; the next append repairs it and the next retention rewrite drops it), plus repo line: `repo: non-repo directory (journal works without git)` or `repo: branch <b>, dirty: yes|no|unknown` with `, root <path>` when the root reads, `, ahead <n>, behind <m>` when an upstream exists, and `, conflicts: <p>, …` when merges are unresolved. Inside a linked worktree the branch is resolved through the `.git` `gitdir:` pointer (below); an unreadable pointer prints `branch (unknown)`.

### Display truthfulness

Three display-level guarantees on the
read side:

- **Worktree branches resolve.** A linked worktree's `.git` is a pointer
  file (`gitdir: <path>`), not a directory. The `status` repo line follows
  the pointer to the real `HEAD` (pure file reads; no `git` invocation) so
  a live branch is named instead of `(detached)`. A dangling or malformed
  pointer reports `branch (unknown)` — named, never a throw — and a
  genuinely detached `HEAD` still reports `(detached)`. The `dirty` probe
  is unchanged (`git status --porcelain`).
- **Hunk counts are truthful.** Every `@@ -a,b +c,d @@` header in `diff`
  output counts exactly the lines the hunk prints for its side (`-` and
  context for `a`, `+` and context for `b`); the counts accumulate while
  emitting, so a consumer (the TUI view, a future patch applier) can trust
  them.
- **`--json` is bounded.** `diff --json` clips each side of every change at
  **64 KiB** (UTF-8 bytes) by default; a clipped side ends with the marker
  line `[kubic: content truncated at 65536 bytes]` and that change carries
  `contentTruncated: true`. `--max-content-bytes <n>` sets the bound and
  `--max-content-bytes 0` means **unlimited** (the unbounded pre behavior, for scripting). The bound applies to `--json` only — the human
  diff renders hunks, never whole files, and is never clipped.

### End-of-run reconciliation

Interception alone has holes: a file moved by `bash`
(`sed -i`, a formatter, `npm install` fallout, a build) never passes through
Kubic's own `write`/`edit` operations, so nothing journals it. The run and TUI
composition paths therefore capture a **baseline** when the session starts and
**sweep** the workspace when it ends:

- A path the walk could SEE but not READ is stored as the sentinel `unreadable`
  instead of a hash: reconcile records neither a change nor a
  delete for it — nothing was observed to change and nothing was observed to
  vanish — and no before-hash is invented. A subtree whose listing fails with
  EACCES/EPERM/EIO is carried forward from the previous baseline the same way;
  one whose listing fails with ENOENT really went away, so its files are
  recorded as deletes like any other disappearance.
- **In `kubic tui` every prompt is a run**. The baseline
  is re-captured when each turn starts, a turn that used `bash` is swept when
  it settles (so `Ctrl+O` / `Ctrl+R` and `kubic diff` from another terminal
  show the shell's change at once), and the baseline is re-captured again
  once no turn is running and before an idle quit. An edit you make in your
  own editor **between prompts** is therefore absorbed, never journaled as
  the agent's change — so plain `kubic undo` does not revert it — while the
  sweep still journals whatever changed during a turn, your concurrent edits
  included (there is no way to tell them apart from the agent's). Each sweep
  entry carries `turn` (1 for the first prompt in this process); the
  quit-time sweep still catches a turn the quit interrupted and appends
  nothing for one that already settled.
- The baseline is a metadata walk — sha256 per file, **no content copied** — of
  the session's workspace root, persisted as
  `<sessions-root>/<id>/journal/baseline-<id>.json` beside that run's journal.
- The sweep compares each path against its **expected state**: the last
  entry journaled for it during *this* run (the journal position is recorded
  with the baseline), or the baseline when this run journaled nothing for it.
  It appends one entry per changed, created or deleted path with
  `unattributed: true` and `toolCallId: null`, and the entry's `beforeHash`
  is that expected state. A revert behind the tools' back is a
  change too: a tool writes `a.txt` and `git checkout a.txt` restores it, so
  the sweep records the restore and `diff` stops showing an edit that no
  longer exists. Earlier runs of a resumed session never mask a change: a
  file set back to an older run's content, or deleted again after being
  recreated between runs, is journaled. A path only a tool journaled (absent
  from the boot baseline) is never reported deleted while it is still a
  regular file on disk: the sweep walk skips gitignored, `.git/` and `.kubic/`
  paths, so their absence from the walk is not a delete. Once such
  a file is really gone — removed, or replaced by a directory or a symlink —
  the delete is journaled.
- Excluded from **both** walks: `.git/`, `.kubic/` (journal state is never
  journaled) and anything the `.gitignore` files match — the root's rules plus
  every nested file's, child rules after the parent's so a nested negation
  overrides a parent ignore (last-match-wins, the ordering git uses, issue
  ); caller-declared out-of-scope paths are honoured when supplied. The
  matcher is the documented common subset (`*`, `?`, `**` at the edges,
  `dir/`, `!`) — exotic syntax is not covered, a nested anchored pattern is
  matched against the workspace-relative path (write it repo-relative:
  `packages/foo/build/`), and an unreadable nested ignore leaves its parent's
  rules in force. Anything missed only widens the baseline, never narrows the
  journal.
- Before-content for these finds comes from the git object store when the
  path was clean against the index at boot — the baseline records its blob
  OID, the sweep reads it back, and `kubic undo` restores it, so a bash `rm`
  or `sed -i` on a committed file undoes like a tool edit (the badge then
  reads `[unattributed]` alone). Otherwise — untracked files, files dirty at
  baseline, non-repositories, binary or over-4-MiB pre-images — they are
  recorded **hashes only** and the badge is `[unattributed, non-reversible]`:
  `kubic undo` skips them naming the path (`non-reversible (skipped): <p>`),
  exiting **1** without writing. The sweep never invents a pre-image: a blob
  that does not hash to the baseline digest is refused. If an earlier
  attributed entry in the same run already stored that path's pre-image, the
  entry *is* reversible through the tool chain instead, and `undo` restores
  it — the badge then reads `[unattributed]` alone.
- Cost is bounded: unchanged files cost one hash and no blob, and a file larger
  than 4 MiB is hashed in chunks, so its boot and sweep cost is one chunk of
  memory rather than the file size (a 256MB artifact measured below 1MB of heap
  growth). A sweep that finds nothing appends
  nothing; a file that *did* change is read once to store its after-content,
  because that content is what `diff` and `undo` serve — and that read is
  bounded too: above `MAX_SWEEP_CONTENT_BYTES` (4 MiB) the entry is
  recorded **hash-only** (`after: null`, the walk hash intact) and `diff` shows
  `[content not captured — N bytes changed]` instead of paying the file's size
  in memory on the run's exit path. The lossy-decode guard records the same
  hash-only shape for a file whose utf-8 decode is not a faithful round-trip
  (binary content): it is never stored as U+FFFD-mangled text. At or under the
  bound a genuine text file still gets full after-content, exactly as before.
- Chunking bounds *memory*, not *time*: the walk still reads a file's full
  apparent size, so a sparse or genuinely huge file costs its size in I/O at
  boot. A file above 256 MiB is named on the debug channel
  (`reconcile: hashing a very large file: <path> (<bytes>)`) so the cost is
  visible instead of silent; nothing is skipped, because a skipped file's
  changes would be invisible to the journal.
- Fail-open: a baseline or sweep failure is reported on the debug receipt and
  never turns a finished run into a failed one.
- HEAD moves are marked, not silently absorbed: the baseline records HEAD sha,
  branch and stash count, and a sweep that finds them changed appends one
  `marker` entry (`head-moved <branch>@<sha> -> <branch>@<sha>`) instead of
  letting a `checkout`/`reset`/`stash` read as hundreds of ordinary file
  changes. `kubic status` warns per move, `kubic log` lists the marker, and
  `kubic undo` refuses to restore entries from before the move without
  `--force` — their pre-move content does not belong on the moved HEAD.
  Entries journaled after the move undo normally.

`kubic log` answers "did anything bypass the tools?" with the count line above;
`kubic status` names it in the summary. `--json` keeps the raw entries (the
`unattributed` flag is on each entry there).

## `kubic git`

Thin over git ops. Outside a repo every subcommand exits 1 with
`error: not a git repository — kubic diff/undo still work without git` on
stderr — the journal path never needs git. Any other git failure is one
`error: <reason>` line on stderr, exit 1.

```
kubic git status [--json]
kubic git log [--max <n>] [--json]
kubic git stage [--json] [--] <paths...>
kubic git commit -m <message> [--json]
```

`kubic git --help` and `kubic git <subcommand> --help` print generated help
(exit 0). A bare `kubic git` prints the same help and exits 1, as a bare
`kubic` does. Usage errors exit **2** with one `error:` line on stderr: an
unknown subcommand, an unknown option, a missing option
value, `--max` that is not a positive integer, `stage` with no path,
`commit` without `-m` or with an empty message.

| Subcommand | Meaning |
| --- | --- |
| `status [--json]` | The branch (with ahead and behind when non-zero), `staged:`, `modified:` and `untracked:` lines, a `conflicts:` line when merges are unresolved, or `clean`. |
| `log [--max <n>] [--json]` | A `SHA DATE AUTHOR MESSAGE` table (short sha), or `no commits` — also on a fresh repo with no commits yet (exit 0). `--json` prints the entries array (`[]` when empty). |
| `stage [--] <paths...>` | Stage paths, print `staged <p>` per path. `--json` prints `{staged: [paths]}`. Put `--` before a path that starts with `-`. |
| `commit -m <message>` | Commit, print `committed <sha8> (<n> file(s))`. `--json` prints `{sha, files}` with each path verbatim (never C-quoted, even non-ASCII or newline names). `-m`/`--message` takes the next token verbatim, even one starting with `-` (`-m --amend` commits the message `--amend`). |

On a detached HEAD the `status` branch line reads `branch (detached HEAD)`.
`status --json` prints the status object: `branch` is `null` on a detached
HEAD, `conflicts` lists the unresolved paths (never duplicated into `staged`
or `modified`), and `renames` lists one `{path, oldPath, staged}` record per
renamed or copied path git detected (the new path also appears in `staged`
or `modified`).

On a colour terminal (TTY, no `NO_COLOR`, not `TERM=dumb`) the status
labels are coloured and `log` is the kit table (muted header, faint rule); piped or under
`--json` the output is plain text.

## `kubic commit -m <message> [--json]`

The alias for `kubic git commit`: same runner, same
message rule (`-m`/`--message` takes the next token verbatim, even one
starting with `-`; a message that really starts with `--` goes in the
attached form `--message=--amend`), same output and same exit codes —
`committed <sha8> (<n> file(s))` on stdout, `{sha, files}` under `--json`,
exit 2 for a missing or empty message, exit 1 outside a git repository.

## `kubic journal prune [--session <id>] [--keep-days <n>] [--yes] [--json]`

Deletes journal entries older than the keep window from the journal `kubic
log` reads: `--session <id>`, else this workspace's journal (the same store
resolution as `kubic diff`, `undo`, `log` and `status`). `prune` is the
group's only subcommand: a bare `kubic journal` prints the group's help and
exits 1, as a bare `kubic` does. **A dry run unless
`--yes`**: without it the command lists each entry it would prune (`would
prune <time> <op> <path>`) and deletes nothing.

| Option | Meaning |
| --- | --- |
| `--session <id>` | Prune that session's journal (or the `journal:<id>` ref `kubic run` prints). |
| `--keep-days <n>` | Keep entries younger than `n` days (a non-negative integer). Default: `[journal] retentionDays`, or `KUBIC_JOURNAL_RETENTION_DAYS`. |
| `--yes` | Delete the listed entries. |
| `--json` | Print one document `{session, root, keepDays, dryRun, pruned, candidates: [{timestamp, op, path}]}`; `candidates` is what the dry run would prune, or what `--yes` pruned. |

- **The keep window is never invented.** The window is `--keep-days` when
  given, else the resolved `[journal] retentionDays`: the
  `KUBIC_JOURNAL_RETENTION_DAYS` env var counts and beats the file key, and the
  flag beats both. With neither, the command exits 1 and names both ways to set
  one, plus the config error when the config did not load. `0` (either way)
  means retention is off: nothing is listed or deleted, exit 0. A window that
  is not a non-negative integer of days exits by where it came from:
  - `--keep-days 0.5`: exit 2, a usage error from the flag parser.
  - `retentionDays = 0.5` in a config file: the config loader accepts it, and
    prune exits 2.
  - `KUBIC_JOURNAL_RETENTION_DAYS=0.5`: the loader refuses the env value, so the
    config does not load and prune exits 1 with `the config did not load: …`
    naming the env var.
- **The checks run in this order, and the first failing one decides the exit.**
  (1) A window that is not a non-negative integer of days: exit 2. (2) An
  explicit `--session` that names no session: exit 1 (`unknown session: <id>`),
  the rule every journal command applies, and nothing is created. (3) A session attached by
  a live pid (its session lock): exit 1 with one `error:` line, on a dry run too
  and for every window, `--keep-days 0` included. This is the rule `kubic undo`
  applies.
  (4) No window at all: exit 1, naming both ways to set one. A zero window
  exits 0 and deletes nothing, after checks 2 and 3.
- **Deletion goes through the store's own retention pass**, which rewrites the
  index under its mutation lock. The report is what that pass removed: `pruned
  N entries, B reclaimed`, with `(M listed: the journal changed while pruning)`
  when the count differs from the M the dry run listed. A pass that removed
  nothing while entries were listed (the journal changed under it) exits 1 with
  `the journal changed while pruning and this run removed nothing — run it again
  to see what is left`.
- **Blob files.** `--yes` also sweeps the blob files no remaining entry
  references: leftovers from earlier passes, and content only the pruned
  entries used. The sweep runs only as part of a pass that drops entries, so
  with nothing to prune an orphan blob stays in place. Its bytes count in
  `reclaimed`; the dry run lists entries only and does not list the blobs.
- **Output.** Text mode prints the candidate lines and `dry run: N entries
  would be pruned (keep window D day(s)) — pass --yes to delete`, or
  `pruned N entries, B reclaimed` after `--yes`. It prints `nothing to prune`
  when no entry is older than the window.
- **Exit codes:** 0 for a dry run, a completed prune, or nothing to prune; 1
  for a missing keep window, a config the loader refused (such as
  `KUBIC_JOURNAL_RETENTION_DAYS=0.5`), an unknown session, a live-run refusal,
  or a pass that removed nothing; 2 for a usage error (a `--keep-days` that is
  not a non-negative integer of days, a file-configured window that is not one,
  an unknown option, or `kubic journal` without its subcommand).

```
kubic journal prune --keep-days 30
kubic journal prune --session 3f2a --keep-days 30 --yes
```

## See also

- [The TUI](tui.md#panels): the diff and journal panels, and `/undo`.
- [Journal and safety](../architecture/journal-and-safety.md): how the journal works.
