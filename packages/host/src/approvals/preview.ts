// The change an edit or write ask would make: computed against the file on
// disk, in the same display form as the edit tool's own result
// (packages/agent/src/ops/display-diff.ts), so the TUI's approval card shows
// the diff instead of a path. Best effort: a file that cannot be read, is too
// big or does not match gives no preview — the card then shows a path.

import {
  displayDiff,
  type ToolDisplay,
  writeDisplay,
} from '@kubic/agent/ops/display-diff';
import type { FileBridge } from '@kubic/exec/file-bridge';

/** Files past this size are not read for a preview. */
/** @internal */
export const APPROVAL_PREVIEW_MAX_BYTES = 2 * 1024 * 1024;

type PreviewFiles = Pick<FileBridge, 'exists' | 'fileInfo' | 'readTextFile'>;

// The edit op matches in this space (LF endings, no BOM).
function normalize(text: string): string {
  return text.replace(/^﻿/u, '').replace(/\r\n/gu, '\n');
}

// Stat before reading: only a regular file under the bound is read. A
// synchronous read of a FIFO blocks until a writer opens it, which would
// wedge the session on one ask; a link (lstat) is not followed.
function readSmall(files: PreviewFiles, path: string): string | undefined {
  const info = files.fileInfo(path);
  if (info.isFile === false || info.isDirectory || info.isSymbolicLink) {
    return undefined;
  }
  if (info.size > APPROVAL_PREVIEW_MAX_BYTES) return undefined;
  return normalize(files.readTextFile(path));
}

// Non-overlapping, left to right — the edit op's own count.
function occurrences(text: string, needle: string): number {
  let count = 0;
  for (let at = text.indexOf(needle); at !== -1; ) {
    count += 1;
    at = text.indexOf(needle, at + needle.length);
  }
  return count;
}

export function approvalPreview(
  files: PreviewFiles,
  toolName: string,
  args: Record<string, unknown>,
): ToolDisplay | undefined {
  try {
    const path = args.path;
    if (typeof path !== 'string' || path === '') return undefined;
    if (toolName === 'edit') {
      const { oldText, newText, expectCount } = args;
      if (typeof oldText !== 'string' || typeof newText !== 'string') {
        return undefined;
      }
      if (!files.exists(path)) return undefined;
      const current = readSmall(files, path);
      const needle = normalize(oldText);
      if (current === undefined || needle === '') return undefined;
      // A count the edit would refuse (no_match / ambiguous_match) is no
      // change to preview.
      const expected = typeof expectCount === 'number' ? expectCount : 1;
      if (occurrences(current, needle) !== expected) return undefined;
      return displayDiff(
        current,
        current.split(needle).join(normalize(newText)),
      );
    }
    if (toolName === 'write') {
      const content = args.content;
      if (typeof content !== 'string') return undefined;
      if (!files.exists(path)) return writeDisplay(normalize(content));
      const current = readSmall(files, path);
      if (current === undefined) return undefined;
      return displayDiff(current, normalize(content));
    }
  } catch {
    // Unreadable (permissions, a race with a delete): no preview.
  }
  return undefined;
}
