# The change journal

The journal records every file change a run makes, so `kubic diff` and
`kubic undo` work in any directory, with or without git. A store is a
directory holding:

- `index.jsonl`: one JSON entry per line, oldest first;
- `blobs/<sha256>`: content-addressed copies of before and after content
  (a large after-side is stored as a line delta against the before-content);
- `index.jsonl.lock`: the mutation lock, present only while a process holds it.

The directory and `blobs/` are created `0700`, and every file in them `0600`:
they hold copies of workspace files, secrets included.

## Record format

Each `index.jsonl` line is one JSON object: the record version `v`, then the
entry — `path`, `op` (`write`, `edit`, `create`, `delete`, `rename` or
`marker`), `beforeHash`, `afterHash` and `deltaHash` (sha256 hex or
`null`), `bytesDelta`, `sessionId`, `source` (`tool`, `sweep` or `undo`),
`toolCallId` and `timestamp` (epoch milliseconds), plus the optional
fields `JournalEntry` documents (`turn`, `toolName`, `unattributed`,
`deltaBaseEmpty`, the omitted-content flags, `headFrom`/`headTo`).

- **`v` is the format's major version, `1`.** Within a major, fields are
  only ever added: an older line lacks them, and an older reader ignores
  them. A change to a field's meaning, an `op`, a hash or a unit is a new
  major.
- **A line without `v` predates the field** and reads as version 1. A line
  without `source` is given one on read (see Reads below).
- **A line of another major is never interpreted.** It is not an entry, so
  `diff`, `undo` and retention never use it; `kubic status` counts it
  (`unknown-version index lines`), and a retention rewrite keeps it
  verbatim, so a build never destroys records a newer one wrote.

## Durability protocol

This is the order in which the store writes, flushes and renames. With
`durable: true` (the default), "flush" means fsync. A filesystem that refuses
to flush (`EINVAL`, `ENOTSUP`, `EPERM` and similar) degrades to rename
atomicity; `ENOSPC` and `EIO` are real failures and propagate.

### Append (`FileJournalStore.append`)

Under the mutation lock:

1. Refuse an entry whose own content could never fit the size bound
   (`JournalEntryTooLargeError`), before anything is written.
2. For each blob the entry needs, in order before, then after (or delta):
   1. if a file already sits at `blobs/<hash>`, check its size and, unless
      this store instance wrote it, its content hash; an intact blob is reused;
   2. otherwise write `blobs/<hash>.<pid>.tmp`, flush it, rename it to
      `blobs/<hash>`, and flush `blobs/`.
3. Append the index line in a single write. If the index ends in a torn
   fragment (no trailing newline), the write starts with a newline so neither
   line is lost. The append is flushed before it returns. If it fails, the
   index is truncated back to its length before the append.
4. Run a retention pass (below).

Blobs are durable before the line that references them, so a durable entry
never points at bytes that were not yet on disk.

### Retention pass (`Retention.run`)

Under the same lock (an append's pass runs inside the append's lock):

1. Fast path: if the cached sizes prove the store is within the size bound
   and the cached oldest timestamp proves nothing aged out, stop without I/O.
2. Sample the index size, then read the index and re-stat every blob it
   references.
3. Plan (`planRetention`): drop entries older than the age bound, then drop
   the oldest entries until the store is under 90% of the size bound. The
   newest entry is never dropped; any excess is reported, not deleted.
4. If nothing drops, re-seed the caches and stop.
5. Write the kept entries to `index.jsonl.<pid>.tmp`. If the index size
   changed since step 2 (a writer that does not take the lock appended),
   discard the tmp, forget the caches, and stop: the next pass sees the line.
6. Flush the tmp, rename it over `index.jsonl`, and flush the directory.
7. Sweep `blobs/`: remove each file no kept entry references, except
   `*.tmp` files and files newer than the pass.

A failed rewrite (step 5 or 6) leaves the old index in place: no prune, no
data lost.

The size bound covers the whole store, index lines included
(`[journal] maxBytes`, 100 MiB by default): content addressing dedupes
blobs, so a file toggling between two contents grows only the index.

### The mutation lock

Appends and retention passes hold `index.jsonl.lock`. The claim lands
atomically (a temp file hard-linked into place) and names its holder: pid,
process start time where the platform reports it, and a nonce. A nested call
in the same store is re-entrant; another process waits up to five seconds,
then fails by name. A waiter takes the lock away only when its holder is
gone — a dead pid, or one whose start time shows it was reused — and never
from a live holder, however long it runs; the takeover runs under a guard
(`index.jsonl.lock.steal`), so two waiters cannot both take a gone holder's
lock. Residue that names no holder (an older build's bare pid is read by its
pid; unreadable bytes) is taken over once older than ten seconds. A release
removes the lock only while it still carries this claim's nonce.

### Reads

- A blob is served only if its content hashes to its name; anything else
  reads as missing.
- A delta reconstruction is served only if it hashes to the entry's
  recorded after-hash.
- Corrupt index lines are skipped and counted (`kubic status` shows them);
  the next rewrite drops them.
- Lines written before entries carried `source` are mapped on read (`undo`,
  `sweep` or `tool`), so every reader sees a source.

### Restore and undo (`restoreEntry`, `applyUndo`)

The pre-image is written to a sibling `<target>.kubic-restore-<pid>.tmp`
(`0600`, then the target's own mode), and renamed over the target, so the
target holds either its old content or the restored content. A restore
refuses an entry path that crosses a symlinked directory.

Every restore appends its inverse entry (`source: undo`): the pre-undo
content as before, the restored content as after. `kubic undo --step` on
that entry is the redo, while a plain undo skips these records, so
repeating it changes nothing. The inverse entry is measured against the
size bound before the file is touched, and one that cannot fit skips the
step with a warning. A pre-undo file that is not valid UTF-8 is recorded by
hash only, and the undo warns that it cannot be redone.

An agent-made create is undone by removing the file, when its content still
matches the recorded after-hash.

### End-of-run sweep (`reconcile`)

Changes no tool call recorded (a formatter, `sed -i`, a build) are found by
comparing a walk of the workspace with the boot baseline and appended as
`source: sweep` entries through the same append protocol.

- The walk honours every `.gitignore` on the way down: a nested file's
  rules come after its parents', and the last match wins. Nested patterns
  match the workspace-relative path, so an anchored pattern in a nested
  file must be written from the root. `.git/info/exclude` and
  `core.excludesFile` are not read. The matcher (`../ignore.ts`) is the one
  the agent's find and grep use; it covers `*`, `?`, `**`, `dir/` and `!`
  in linear time.
- "Could not look" never reads as "deleted". A file the walk sees but
  cannot read stays in the baseline as `unreadable`, a directory whose
  listing fails keeps its previous hashes, and only `ENOENT` records a
  delete.
- A path only a tool journaled (gitignored, or under `.git/` or `.kubic/`)
  is not in the walk, so it is probed directly before a delete is recorded.
- A changed file above 4 MiB, or one whose UTF-8 decode is lossy, is
  recorded by hash only (`afterOmitted`), and `kubic diff` says so.
