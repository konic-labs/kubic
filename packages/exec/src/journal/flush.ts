// Error codes that mean "this filesystem will not flush this", not "the
// write failed": the journal degrades to rename atomicity instead of
// refusing to record work. ENOSPC/EIO are deliberately
// absent — those are real failures and must stay fatal.
const FLUSH_UNSUPPORTED = new Set([
  'EACCES',
  'EBADF',
  'EINVAL',
  'EISDIR',
  'ENOTSUP',
  'EOPNOTSUPP',
  'EPERM',
]);

// Flushing is a durability upgrade, never a reason to
// lose a write. A platform or filesystem that refuses to flush a directory
// (Windows' directory handles; FUSE and overlay mounts returning EINVAL)
// degrades to rename atomicity instead of blocking every tool write — the
// same shape as a bridge without `appendDurably`. A genuine I/O failure
// (ENOSPC, EIO) still propagates: a durable entry may not silently
// reference bytes that were never flushed. The blob writes and the index
// rewrite share this rule; only a failed append is fatal — a failed
// compaction means no prune.
export function flushDurably(durable: boolean, run: () => void): void {
  if (!durable) return;
  try {
    run();
  } catch (error) {
    const code = (error as { code?: string } | null)?.code ?? '';
    if (!FLUSH_UNSUPPORTED.has(code)) throw error;
  }
}
