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

  it('renders 200 deltas incrementally, one markdown rebuild per entry', () => {
    const view = createTranscriptView();
    for (let i = 0; i < 100; i++) {
      view.appendDelta({ id: `e${i}`, kind: 'text', append: `line ${i}` });
    }
    const half = view.render(80).length;
    for (let i = 100; i < 200; i++) {
      view.appendDelta({ id: `e${i}`, kind: 'text', append: `line ${i}` });
    }
    // One rebuild per entry, never a full clear: rows grow monotonically.
    expect(view.rebuilds).toBe(200);
    expect(view.render(80).length).toBeGreaterThan(half);
    const doc = view.render(80).join('\n');
    expect(doc).toContain('line 0');
    expect(doc).toContain('line 199');
  });

  it('follows the tail when pinned, holds on scroll-up, re-pins on End', () => {
    const view = createTranscriptView();
    for (let i = 0; i < 10; i++) {
      view.appendDelta({ id: `e${i}`, kind: 'text', append: `line ${i}` });
    }
    view.updateLayout(view.render(80).length, 5);
    expect(view.isPinned).toBe(true);
    const tail = view.scrollTop;
    for (let i = 10; i < 20; i++) {
      view.appendDelta({ id: `e${i}`, kind: 'text', append: `line ${i}` });
    }
    view.updateLayout(view.render(80).length, 5);
    expect(view.scrollTop).toBeGreaterThan(tail);
    view.scrollUp(100);
    expect(view.isPinned).toBe(false);
    const held = view.scrollTop;
    for (let i = 20; i < 70; i++) {
      view.appendDelta({ id: `e${i}`, kind: 'text', append: `line ${i}` });
    }
    view.updateLayout(view.render(80).length, 5);
    expect(view.scrollTop).toBe(held);
    view.rePin();
    expect(view.isPinned).toBe(true);
    expect(view.scrollTop).toBeGreaterThan(held);
  });
});
