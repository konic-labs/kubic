// Slice A: follow-end transcript fed by LaneSnapshot coarse cells (§16.1, §80).
// RED: createTranscriptView/appendDelta do not exist yet.
//
// No VirtualTerminal exists in Pi 0.85.1: headless snapshots render the
// ScrollView root directly (Component.render is pure) and assert document
// text plus follow/pinned offsets across batches.
import { describe, expect, it } from 'vitest';
import { createTranscriptView } from './transcript.js';

describe('transcript view (issue #23, slice A)', () => {
  it('appends a text delta and shows it in a headless snapshot', () => {
    const view = createTranscriptView();
    view.appendDelta({ id: 'e1', kind: 'text', append: 'hello world' });
    expect(view.render(80).join('\n')).toContain('hello world');
  });
});
