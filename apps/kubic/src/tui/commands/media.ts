// `/image` and the image-attachment path.
import { basename } from 'node:path';
import type { FileBridge } from '@kubic/exec/file-bridge';
import { formatImageBytes, IMAGE_MAX_BYTES } from '@kubic/tui/attachments';

// The `/image <path>` command of the interactive loop.
// `undefined` means the draft is a prompt, not the command. One parser for
// the dispatch and its tests: `/image` alone is the usage error, anything
// after it is the path (spaces included — a screenshot path often has them).
type TuiImageCommand =
  | { kind: 'attach'; path: string }
  | { kind: 'invalid'; message: string };

export const IMAGE_COMMAND_USAGE =
  'usage: /image <path> (png, jpeg, webp or gif)';

export function parseImageCommand(prompt: string): TuiImageCommand | undefined {
  const trimmed = prompt.trim();
  if (trimmed !== '/image' && !trimmed.startsWith('/image ')) {
    return undefined;
  }
  const path =
    trimmed === '/image' ? '' : trimmed.slice('/image '.length).trim();
  if (path === '') return { kind: 'invalid', message: IMAGE_COMMAND_USAGE };
  return { kind: 'attach', path };
}

// The file half of the attach path: the composition root owns I/O, so the
// read, the regular-file check and the size guard live here — through the
// exec file bridge (I/O confinement), never `node:fs` directly — and the
// tui package only ever sees bytes. An absolute path is taken as typed (the
// operator named it); a relative one resolves against the workspace. A
// missing file, a directory or a file over the cap is refused by name, and
// the read is bounded so an oversize file is never loaded in full.
export type ImageFileRead =
  | { readonly ok: true; readonly filename: string; readonly bytes: Uint8Array }
  | { readonly ok: false; readonly message: string };

export function readImageFile(files: FileBridge, path: string): ImageFileRead {
  const full = files.absolutePath(path);
  const filename = basename(full);
  let bytes: Uint8Array;
  try {
    // The regular-file check comes FIRST: `lstat` is
    // cheap and never blocks, while a synchronous read of a FIFO with no
    // writer — or of a device node like /dev/tty — blocks the event loop
    // forever, so no Ctrl-C handler could ever run. `undefined` means a
    // synthetic entry that intends a regular file.
    if (files.fileInfo(full).isFile === false) {
      return { ok: false, message: `'${filename}' is not a regular file` };
    }
    bytes =
      files.readFileRange?.(full, 0, IMAGE_MAX_BYTES + 1) ??
      files.readBinaryFile(full);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes('ENOENT') || message.includes('no such file')) {
      return { ok: false, message: `no such image: ${path}` };
    }
    return { ok: false, message: `cannot read ${path}: ${message}` };
  }
  if (bytes.byteLength > IMAGE_MAX_BYTES) {
    return {
      ok: false,
      message:
        `'${filename}' is too large ` +
        `(> ${formatImageBytes(IMAGE_MAX_BYTES)})`,
    };
  }
  return { ok: true, filename, bytes };
}
