// Prompt images on the durable lane.
// `runTurn` maps the attachment parts onto the user message content
// unchanged, and the committed entry stores them, so a resumed session
// replays exactly what was sent — Pi's own user-message content parts are
// the storage format.
import { afterEach, describe, expect, it } from 'vitest';
import {
  BACKGROUND_CONTEXT,
  fauxAssistantMessage,
  UserEntry,
} from '../pi-boundary.js';
import { bootFauxLane, type FauxLane } from './test-harness.js';
import { runTurn } from './turn.js';

// 1x1 transparent PNG.
const PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

const lanes: FauxLane[] = [];

afterEach(async () => {
  for (const lane of lanes.splice(0)) await lane.cleanup();
});

describe('runTurn prompt images', () => {
  it('sends text plus image content parts to the model', async () => {
    const seen: Array<{ role?: unknown; content?: unknown }> = [];
    const lane = await bootFauxLane({
      models: [{ id: 'vision', input: ['text', 'image'] }],
      responses: [
        (context) => {
          const last = [...context.messages]
            .reverse()
            .find((message) => message.role === 'user');
          seen.push(last as { role?: unknown; content?: unknown });
          return fauxAssistantMessage('ok');
        },
      ],
    });
    lanes.push(lane);

    const outcome = await runTurn(lane.solo, 'what is this?', {
      requestId: 'req-image',
      context: BACKGROUND_CONTEXT,
      images: [
        {
          mimeType: 'image/png',
          data: PNG,
          filename: 'screenshot.png',
          bytes: 68,
        },
      ],
    });

    expect(outcome).toEqual({
      kind: 'completed',
      submissionId: expect.any(String),
    });
    expect(seen).toHaveLength(1);
    expect(seen[0]?.role).toBe('user');
    expect(seen[0]?.content).toEqual([
      { type: 'text', text: 'what is this?' },
      { type: 'image', data: PNG, mimeType: 'image/png' },
    ]);
  });

  it('stores the image part on the committed entry for replay', async () => {
    const lane = await bootFauxLane({
      models: [{ id: 'vision', input: ['text', 'image'] }],
    });
    lanes.push(lane);

    await runTurn(lane.solo, 'look', {
      requestId: 'req-image-2',
      context: BACKGROUND_CONTEXT,
      images: [{ mimeType: 'image/png', data: PNG, filename: 'shot.png' }],
    });

    const entries = await lane.entries();
    const user = entries.find((entry) => UserEntry.is(entry));
    const message = user?.model?.[0] as { content?: unknown } | undefined;
    expect(message?.content).toEqual([
      { type: 'text', text: 'look' },
      { type: 'image', data: PNG, mimeType: 'image/png' },
    ]);
  });

  it('sends a plain string when there is no image', async () => {
    const seen: Array<{ content?: unknown }> = [];
    const lane = await bootFauxLane({
      responses: [
        (context) => {
          const last = [...context.messages]
            .reverse()
            .find((message) => message.role === 'user');
          seen.push(last as { content?: unknown });
          return fauxAssistantMessage('ok');
        },
      ],
    });
    lanes.push(lane);

    await runTurn(lane.solo, 'plain', {
      requestId: 'req-plain',
      context: BACKGROUND_CONTEXT,
    });
    expect(seen[0]?.content).toBe('plain');
  });
});
