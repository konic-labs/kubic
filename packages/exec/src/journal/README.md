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

### Reads

- A blob is served only if its content hashes to its name; anything else
  reads as missing.
- A delta reconstruction is served only if it hashes to the entry's
  recorded after-hash.
- Corrupt index lines are skipped and counted (`kubic status` shows them);
  the next rewrite drops them.
- Lines written before entries carried `source` are mapped on read (`undo`,
  `sweep` or `tool`), so every reader sees a source.

### Restore (`restoreEntry`, used by undo)

The pre-image is written to a sibling `<target>.kubic-restore-<pid>.tmp`
(`0600`, then the target's own mode), and renamed over the target, so the
target holds either its old content or the restored content. Undo checks
that the inverse entry fits the bound before it restores, and appends that
entry after the restore.

### End-of-run sweep (`reconcile`)

Changes no tool call recorded (a formatter, `sed -i`, a build) are found by
comparing a walk of the workspace with the boot baseline and appended as
`source: sweep` entries through the same append protocol.
