import { createHash } from 'node:crypto';
import type { FileBridge } from '../file-bridge.js';

// Chunk size for streamed hashing: peak memory is one chunk, never
// the file size. A file at or under this is read in a single call.
export const HASH_CHUNK_BYTES = 4 * 1024 * 1024;
// Above this apparent size the walk NAMES the file rather than hashing it in
// silence. The posture is
// deliberately "hashed streaming anyway, but reported": skipping the file
// would make a change to it invisible to the journal — the one thing a change
// journal must never do — while a sparse or genuinely huge file costs its
// apparent size in boot I/O (measured: a 4 GiB-apparent sparse file streamed
// ~4 GiB of zeros in 8475ms, memory bounded). Naming it is what turns
// unbounded work into a visible cost instead of a silent one.
export const HASH_NOTICE_BYTES = 256 * 1024 * 1024;

export function sha256Hex(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

/**
 * The sha256 of raw bytes: what the walk hashes, and what the
 * undo record keeps for a pre-image that cannot be stored as text.
 */
export function sha256HexOfBytes(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/**
 * Hash a file exactly as `sha256Hex(bridge.readTextFile(path))` does, without
 * ever holding the whole file.
 *
 * The digest must stay byte-identical for files already journaled: the baseline
 * is compared against digests written by older versions, so a changed digest
 * would read as "every file changed" and rewrite journal history. That means
 * hashing the UTF-8 DECODE rather than the raw bytes — `readTextFile` returns a
 * string and `sha256Hex` hashes it as utf8, so invalid sequences collapse to
 * U+FFFD and must collapse identically here. The decoder is therefore carried
 * across chunk boundaries, so a multi-byte character split between two reads
 * decodes once.
 *
 * A bridge without `readFileRange` falls back to the whole-file read: correct,
 * unbounded, and reachable only from a test double (the node bridge implements
 * it, so every production walk is bounded).
 */
export function sha256HexOfFile(
  bridge: FileBridge,
  path: string,
  size: number,
  onUnbounded?: (detail: string) => void,
): string {
  const readRange = bridge.readFileRange?.bind(bridge);
  if (readRange === undefined) {
    // A silent fallback is not allowed. Every production bridge
    // supplies the method, so this is a partial double or a future adapter —
    // but an unlogged revert to whole-file reads cannot be detected in the
    // field, so it is reported through the caller's receipt hook.
    onUnbounded?.(
      `bounded hashing unavailable for ${path} (${size} bytes): the file bridge does not implement readFileRange — reading it whole`,
    );
    return sha256Hex(bridge.readTextFile(path));
  }
  if (size <= HASH_CHUNK_BYTES) {
    return sha256Hex(bridge.readTextFile(path));
  }
  // `ignoreBOM: true` is load-bearing, not a stylistic choice. The default
  // decoder STRIPS a leading U+FEFF while `readFileSync(path, 'utf8')` keeps
  // it, so without this flag a BOM-prefixed file above the chunk size hashed
  // differently from a whole-file read — measured: 8MiB with a BOM diverged
  // while the no-BOM control matched. The consequence would be the failure
  // this bound must not cause: a baseline written by another build, swept by
  // this one appends a spurious unattributed write, and a tool-authored change
  // gets a duplicate entry shadowing it. A BOM-prefixed CSV/JSON export is all
  // it takes, nothing malicious.
  const decoder = new TextDecoder('utf-8', { ignoreBOM: true });
  const hash = createHash('sha256');
  let offset = 0;
  while (offset < size) {
    const end = Math.min(offset + HASH_CHUNK_BYTES, size);
    const chunk = decoder.decode(readRange(path, offset, end), {
      stream: true,
    });
    if (chunk !== '') hash.update(chunk, 'utf8');
    offset = end;
  }
  const tail = decoder.decode();
  if (tail !== '') hash.update(tail, 'utf8');
  return hash.digest('hex');
}
