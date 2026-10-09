// `/image` and the image-attachment path: a file named by `/image`, or an
// image the terminal pasted inline, validated and capability-checked against
// the live model before the next prompt carries it.
import { basename } from 'node:path';
import type { FileBridge } from '@kubic/exec/file-bridge';
import {
  type AttachmentImage,
  formatImageBytes,
  IMAGE_MAX_BYTES,
  validateImageAttachment,
} from '@kubic/tui/attachments';
import type { TuiContext } from '../context.js';
import { refuse, type TuiCommandTable } from './handler.js';

export const mediaCommands: TuiCommandTable = {
  image: {
    run(ctx, command) {
      // `/image <path>` attaches one image to the
      // next prompt. The registry owns discovery (palette,
      // autocomplete, `/help`); the read and the validation are the
      // composition root's, and a bare `/image` is the usage error.
      const parsed = parseImageCommand(
        command.argument === '' ? '/image' : `/image ${command.argument}`,
      );
      if (parsed === undefined || parsed.kind === 'invalid') {
        return refuse(
          ctx,
          parsed === undefined ? IMAGE_COMMAND_USAGE : parsed.message,
        );
      }
      void attachFromPath(ctx, parsed.path);
      return 'command';
    },
  },
};

export const TOO_LARGE_PASTE_FOOTER = `pasted image is too large (> ${formatImageBytes(IMAGE_MAX_BYTES)})`;

export function setImagesFooter(ctx: TuiContext, text: string): void {
  ctx.app.setEditorFooter(text);
  ctx.render();
}

// The attach path the file and the paste share: the bytes are validated
// (magic bytes, size) and the live model must accept images.
async function attachImage(
  ctx: TuiContext,
  offer: { filename: string; bytes: Uint8Array },
): Promise<void> {
  const verdict = validateImageAttachment({
    filename: offer.filename,
    bytes: offer.bytes,
  });
  if (!verdict.ok) {
    setImagesFooter(ctx, verdict.message);
    return;
  }
  const loop = ctx.boot.loop;
  const supported = await loop?.supportsImages?.(loop.context);
  if (supported !== true) {
    setImagesFooter(
      ctx,
      `image refused: ${ctx.turn?.modelRef ?? ctx.boot.model} does not accept image input`,
    );
    return;
  }
  const image: AttachmentImage = {
    filename: offer.filename,
    mimeType: verdict.mimeType,
    bytes: offer.bytes.byteLength,
    data: Buffer.from(offer.bytes).toString('base64'),
  };
  ctx.pendingImages = [...ctx.pendingImages, image];
  ctx.app.setPendingImages(ctx.pendingImages);
  // The armed-but-unsubmitted count the
  // editor's blank-submit rule reads.
  ctx.app.setPendingAttachments(ctx.pendingImages.length);
  setImagesFooter(
    ctx,
    `image attached: ${image.filename} (${formatImageBytes(image.bytes)}) — Enter sends it`,
  );
}

// The exec file bridge the `/image` read goes through: the same
// seam the session store uses, rooted at the workspace, and an absolute
// path is taken as typed because the operator named it.
async function attachFromPath(ctx: TuiContext, path: string): Promise<void> {
  const read = readImageFile(ctx.files, path);
  if (!read.ok) {
    setImagesFooter(ctx, read.message);
    return;
  }
  await attachImage(ctx, { filename: read.filename, bytes: read.bytes });
}

export async function attachPasted(
  ctx: TuiContext,
  base64: string,
  filename: string,
): Promise<void> {
  // Refuse an oversize paste BEFORE decoding it: the
  // base64 text is already in memory (the terminal delivered it), but the
  // decoded payload would be a second, larger allocation. 4/3 is base64's
  // own expansion; the slack covers padding and line breaks.
  if (base64.length > Math.ceil((IMAGE_MAX_BYTES * 4) / 3) + 4) {
    setImagesFooter(
      ctx,
      `'${filename}' is too large (> ${formatImageBytes(IMAGE_MAX_BYTES)})`,
    );
    return;
  }
  await attachImage(ctx, {
    filename,
    bytes: Buffer.from(base64, 'base64'),
  });
}

// The `/image <path>` command of the interactive loop.
// `undefined` means the draft is a prompt, not the command. One parser for
// the dispatch and its tests: `/image` alone is the usage error, anything
// after it is the path (spaces included — a screenshot path often has them).
type TuiImageCommand =
  | { kind: 'attach'; path: string }
  | { kind: 'invalid'; message: string };

const IMAGE_COMMAND_USAGE = 'usage: /image <path> (png, jpeg, webp or gif)';

function parseImageCommand(prompt: string): TuiImageCommand | undefined {
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
