// Prompt image attachments (issue #338; §16.5 Image, §16.8 Images).
// Pure: validation over bytes the caller already read, the placeholder text,
// and the two render paths. The composition root owns the file read and the
// capability refusal; nothing here touches the filesystem or the network.
//
// Rendering follows the terminal: where Pi's capability probe found a kitty
// or iTerm2 image protocol, the pi-tui `Image` component emits the real
// protocol sequence; everywhere else one text placeholder row names the file
// and its size, so an attachment is never invisible.

import type { LaneImagePart } from '../../core/src/presentation.js';
import type { TuiTheme } from './theme.js';
import type { Component } from './tui-boundary.js';
import { getCapabilities, Image, truncateToWidth } from './tui-boundary.js';

// One validated image ready to attach to a prompt. Structurally a
// `LaneImagePart` (core) with the display fields always present.
export interface AttachmentImage extends LaneImagePart {
  readonly filename: string;
  readonly mimeType: string;
  /** Decoded size in bytes, printed by the placeholder. */
  readonly bytes: number;
  /** base64 payload, no `data:` prefix, exactly as Pi's ImageContent wants it. */
  readonly data: string;
}

// The MIME types Kubic accepts (§16.8: png/jpeg/webp/gif). Anything else is
// refused before it can reach a provider.
export const IMAGE_MIME_TYPES = [
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif',
] as const;

export type SupportedImageMimeType = (typeof IMAGE_MIME_TYPES)[number];

// The largest image Kubic attaches (decoded bytes). The providers' own
// request limits sit below this, so the cap is a courtesy to the operator,
// not a policy: it catches a wrong paste before a turn is spent.
export const IMAGE_MAX_BYTES = 5 * 1024 * 1024;

const MEBIBYTE = 1024 * 1024;
const KIBIBYTE = 1024;

function startsWith(bytes: Uint8Array, prefix: readonly number[]): boolean {
  if (bytes.length < prefix.length) return false;
  return prefix.every((value, index) => bytes[index] === value);
}

// Magic-byte sniffing, not the extension: a mislabelled file must not be
// sent as an image the provider then rejects mid-turn.
export function detectImageMime(
  bytes: Uint8Array,
): SupportedImageMimeType | undefined {
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) {
    return 'image/png';
  }
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return 'image/jpeg';
  if (
    startsWith(bytes, [0x47, 0x49, 0x46, 0x38, 0x37, 0x61]) ||
    startsWith(bytes, [0x47, 0x49, 0x46, 0x38, 0x39, 0x61])
  ) {
    return 'image/gif';
  }
  if (
    startsWith(bytes, [0x52, 0x49, 0x46, 0x46]) &&
    bytes.length >= 12 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  ) {
    return 'image/webp';
  }
  return undefined;
}

export type ImageValidation =
  | { readonly ok: true; readonly mimeType: SupportedImageMimeType }
  | { readonly ok: false; readonly message: string };

// The one verdict the attach path reports: a supported image under the cap,
// or the named reason it was refused. The offered extensions are named so a
// wrong file is immediately understandable.
export function validateImageAttachment(input: {
  filename: string;
  bytes: Uint8Array;
}): ImageValidation {
  const mimeType = detectImageMime(input.bytes);
  if (mimeType === undefined) {
    return {
      ok: false,
      message:
        `'${input.filename}' is not a supported image ` +
        `(png, jpeg, webp or gif)`,
    };
  }
  if (input.bytes.byteLength > IMAGE_MAX_BYTES) {
    return {
      ok: false,
      message:
        `'${input.filename}' is too large ` +
        `(${formatImageBytes(input.bytes.byteLength)} > ` +
        `${formatImageBytes(IMAGE_MAX_BYTES)})`,
    };
  }
  return { ok: true, mimeType };
}

export function formatImageBytes(bytes: number): string {
  if (bytes >= MEBIBYTE) return `${(bytes / MEBIBYTE).toFixed(1)} MB`;
  if (bytes >= KIBIBYTE) return `${Math.round(bytes / KIBIBYTE)} KB`;
  return `${bytes} B`;
}

// The one-row fallback on a terminal without an image protocol. Kept in one
// place so the transcript and the pending echo agree.
export function attachmentPlaceholder(image: {
  filename?: string;
  mimeType: string;
  bytes?: number;
}): string {
  const parts: string[] = [];
  if (image.filename !== undefined && image.filename !== '') {
    parts.push(image.filename);
  }
  if (image.bytes !== undefined) parts.push(formatImageBytes(image.bytes));
  if (parts.length === 0) parts.push(image.mimeType);
  return `[image: ${parts.join(' ')}]`;
}

// Whether Pi found an image protocol on this terminal. `Image` consults the
// same probe, but Kubic's placeholder is its own row, so the decision is
// explicit here.
export function imageTerminalSupported(): boolean {
  const protocol = getCapabilities().images;
  return protocol === 'kitty' || protocol === 'iterm2';
}

// One attachment as a renderable component: the real image on a supported
// terminal, one placeholder row otherwise. Callers hold the returned
// component (the kitty path allocates an image id that must be reused).
export function createAttachmentComponent(
  image: LaneImagePart,
  theme: TuiTheme,
): Component {
  if (imageTerminalSupported()) {
    return new Image(
      image.data,
      image.mimeType,
      { fallbackColor: theme.muted },
      image.filename === undefined ? {} : { filename: image.filename },
    );
  }
  return {
    render: (width: number): string[] => [
      truncateToWidth(
        theme.muted(attachmentPlaceholder(image)),
        Math.max(1, width),
      ),
    ],
    invalidate: (): void => {},
  };
}

// A structural `LaneImagePart` from a lane entry content part, or undefined
// when it is not one Kubic may render. The MIME type must be one Kubic
// accepts and the payload must be base64, so a hand-written or tampered
// entry can never drive the terminal's image protocol with arbitrary bytes.
export function imagePartOf(part: unknown): LaneImagePart | undefined {
  if (typeof part !== 'object' || part === null) return undefined;
  const candidate = part as Record<string, unknown>;
  if (candidate.type !== 'image') return undefined;
  const { data, mimeType } = candidate;
  if (typeof data !== 'string' || typeof mimeType !== 'string') {
    return undefined;
  }
  if (!(IMAGE_MIME_TYPES as readonly string[]).includes(mimeType)) {
    return undefined;
  }
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(data)) return undefined;
  const bytes =
    typeof candidate.bytes === 'number' && candidate.bytes >= 0
      ? candidate.bytes
      : decodeBase64Length(data);
  return {
    data,
    mimeType,
    ...(typeof candidate.filename === 'string' && candidate.filename !== ''
      ? { filename: candidate.filename }
      : {}),
    bytes,
  };
}

// The decoded byte length of a validated base64 payload, without decoding
// it again: 3 bytes per 4 characters, minus the padding.
function decodeBase64Length(data: string): number {
  const padding = data.endsWith('==') ? 2 : data.endsWith('=') ? 1 : 0;
  return (data.length / 4) * 3 - padding;
}

// iTerm2's inline-image sequence (OSC 1337 `File=`), the one paste form a
// terminal image-capable clipboard sends. The sequence may arrive embedded in
// a larger paste, so it is scanned for, not prefix-matched; `name` is the
// base64-encoded filename.
const INLINE_IMAGE =
  // biome-ignore lint/suspicious/noControlCharactersInRegex: the OSC/BEL/ST framing is the point
  /\u001b\]1337;File=([^:]*?):([A-Za-z0-9+/=\s]+?)(?:\u0007|\u001b\\)/;

export interface PastedImage {
  readonly filename: string;
  /** base64 payload, undecoded. */
  readonly base64: string;
}

export function parseInlineImageSequence(
  data: string,
): PastedImage | undefined {
  const match = INLINE_IMAGE.exec(data);
  if (match === null) return undefined;
  const params = match[1] ?? '';
  const encodedName = /(?:^|;)name=([^;]*)/.exec(params)?.[1];
  let filename = 'pasted-image';
  if (encodedName !== undefined && encodedName !== '') {
    try {
      filename = Buffer.from(encodedName, 'base64').toString('utf8');
    } catch {
      // A malformed name keeps the default label; the bytes still count.
    }
  }
  return { filename, base64: (match[2] ?? '').replace(/\s+/g, '') };
}
