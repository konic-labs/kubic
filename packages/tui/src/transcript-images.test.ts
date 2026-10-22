// Prompt images in the transcript (Image, Images).
// A committed prompt carries its attachments back from the lane (so a
// resumed session replays them), the pending echo carries the ones just
// attached, and a part Kubic did not validate never reaches the renderer.
import { afterEach, describe, expect, it } from 'vitest';
import { entriesToCells } from './lane-cells.js';
import { createTranscriptView } from './transcript.js';
import { resetCapabilitiesCache, setCapabilities } from './tui-boundary.js';

// 1x1 transparent PNG.
const PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

function userEntry(content: unknown) {
  return {
    id: '7',
    seq: 7,
    type: 'message',
    message: { role: 'user', content },
  };
}

afterEach(() => {
  resetCapabilitiesCache();
});

describe('transcript prompt images', () => {
  it('renders a committed prompt image as the placeholder', () => {
    setCapabilities({ images: null, trueColor: false, hyperlinks: false });
    const view = createTranscriptView();
    view.applyLaneSnapshot(
      { laneId: 's1' },
      entriesToCells([
        userEntry([
          { type: 'text', text: 'look at this' },
          // Exactly what the lane stores (turn.ts): mimeType and data only —
          // the name and the size are the PENDING echo's rendering, so a
          // resumed session shows `[image: image/png …]`.
          { type: 'image', data: PNG, mimeType: 'image/png' },
        ]),
      ]),
      1,
    );
    const frame = view.render(60).join('\n');
    expect(frame).toContain('look at this');
    expect(frame).toContain('[image: image/png');
  });

  it('renders an image-only prompt (no text part)', () => {
    setCapabilities({ images: null, trueColor: false, hyperlinks: false });
    const view = createTranscriptView();
    view.applyLaneSnapshot(
      { laneId: 's1' },
      entriesToCells([
        userEntry([{ type: 'image', data: PNG, mimeType: 'image/png' }]),
      ]),
      1,
    );
    expect(view.render(60).join('\n')).toContain('[image:');
  });

  it('renders the pending echo with its attachments', () => {
    setCapabilities({ images: null, trueColor: false, hyperlinks: false });
    const view = createTranscriptView();
    view.setPendingPrompt('look', [
      { data: PNG, mimeType: 'image/png', filename: 'shot.png', bytes: 70 },
    ]);
    const frame = view.render(60).join('\n');
    expect(frame).toContain('look');
    expect(frame).toContain('[image: shot.png 70 B]');
  });

  it('never renders a part Kubic did not validate', () => {
    setCapabilities({ images: 'kitty', trueColor: true, hyperlinks: false });
    const view = createTranscriptView();
    view.applyLaneSnapshot(
      { laneId: 's1' },
      entriesToCells([
        userEntry([
          { type: 'text', text: 'hi' },
          // An unsupported MIME type and a payload that is not base64: the
          // cell keeps the text and drops the image.
          { type: 'image', data: PNG, mimeType: 'image/svg+xml' },
          { type: 'image', data: '\u001b[2Jnot-base64', mimeType: 'image/png' },
        ]),
      ]),
      1,
    );
    const frame = view.render(60).join('\n');
    expect(frame).toContain('hi');
    expect(frame).not.toContain('\u001b[2J');
    expect(frame).not.toContain('[image:');
  });
});
