// Prompt image attachments (issue #338; §16.5 Image, §16.8 Images).
// Pure validation of an attached image's bytes and the two render paths:
// the pi-tui Image component on kitty/iTerm2 terminals, a text placeholder
// everywhere else. No I/O: the caller (the composition root) reads the file.
import { afterEach, describe, expect, it } from 'vitest';
import {
  attachmentPlaceholder,
  createAttachmentComponent,
  detectImageMime,
  formatImageBytes,
  IMAGE_MAX_BYTES,
  parseInlineImageSequence,
  validateImageAttachment,
} from './attachments.js';
import { tuiTheme } from './theme.js';
import { resetCapabilitiesCache, setCapabilities } from './tui-boundary.js';

// 1x1 transparent PNG.
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
const GIF = Buffer.from('GIF89a....', 'latin1');
const WEBP = Buffer.concat([
  Buffer.from('RIFF', 'latin1'),
  Buffer.from([0x1a, 0x00, 0x00, 0x00]),
  Buffer.from('WEBPVP8 ', 'latin1'),
]);

afterEach(() => {
  resetCapabilitiesCache();
});

describe('image validation (issue #338)', () => {
  it('detects png, jpeg, gif and webp from their magic bytes', () => {
    expect(detectImageMime(PNG)).toBe('image/png');
    expect(detectImageMime(JPEG)).toBe('image/jpeg');
    expect(detectImageMime(GIF)).toBe('image/gif');
    expect(detectImageMime(WEBP)).toBe('image/webp');
    expect(detectImageMime(Buffer.from('not an image'))).toBeUndefined();
  });

  it('accepts a supported image and names the MIME type', () => {
    expect(
      validateImageAttachment({ filename: 'shot.png', bytes: PNG }),
    ).toEqual({ ok: true, mimeType: 'image/png' });
  });

  it('refuses bytes that are not a supported image, by name', () => {
    const verdict = validateImageAttachment({
      filename: 'notes.txt',
      bytes: Buffer.from('hello'),
    });
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) {
      expect(verdict.message).toContain('notes.txt');
      expect(verdict.message).toContain('png');
    }
  });

  it('refuses an image over the size cap before anything is attached', () => {
    const big = Buffer.alloc(IMAGE_MAX_BYTES + 1);
    PNG.copy(big);
    const verdict = validateImageAttachment({
      filename: 'big.png',
      bytes: big,
    });
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) {
      expect(verdict.message).toContain('big.png');
      expect(verdict.message).toContain('MB');
    }
  });

  it('formats a size the way the placeholder prints it', () => {
    expect(formatImageBytes(120 * 1024)).toBe('120 KB');
    expect(formatImageBytes(512)).toBe('512 B');
    expect(formatImageBytes(2 * 1024 * 1024)).toBe('2.0 MB');
  });
});

describe('the transcript placeholder (issue #338)', () => {
  it('names the file and its size on a terminal without image support', () => {
    setCapabilities({ images: null, trueColor: false, hyperlinks: false });
    expect(
      attachmentPlaceholder({
        filename: 'screenshot.png',
        mimeType: 'image/png',
        bytes: 120 * 1024,
      }),
    ).toBe('[image: screenshot.png 120 KB]');
  });

  it('renders the placeholder as one themed row', () => {
    setCapabilities({ images: null, trueColor: false, hyperlinks: false });
    const component = createAttachmentComponent(
      {
        filename: 'screenshot.png',
        mimeType: 'image/png',
        bytes: 120 * 1024,
        data: PNG.toString('base64'),
      },
      tuiTheme(),
    );
    expect(component.render(40)).toEqual(['[image: screenshot.png 120 KB]']);
  });

  it('uses the pi-tui Image protocol on a kitty terminal', () => {
    setCapabilities({ images: 'kitty', trueColor: true, hyperlinks: false });
    const component = createAttachmentComponent(
      {
        filename: 'screenshot.png',
        mimeType: 'image/png',
        bytes: PNG.byteLength,
        data: PNG.toString('base64'),
      },
      tuiTheme(),
    );
    const lines = component.render(40);
    expect(lines.join('')).toContain('\x1b_G');
  });
});

describe('terminal-pasted images (issue #338)', () => {
  it('reads an iTerm2 inline image sequence', () => {
    const sequence = `\x1b]1337;File=name=${Buffer.from('shot.png', 'latin1').toString('base64')};size=68;inline=1:${PNG.toString('base64')}\x07`;
    const parsed = parseInlineImageSequence(sequence);
    expect(parsed).toEqual({
      filename: 'shot.png',
      base64: PNG.toString('base64'),
    });
  });

  it('leaves ordinary pasted text alone', () => {
    expect(parseInlineImageSequence('just text')).toBeUndefined();
  });
});
