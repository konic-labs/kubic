// Follow-end transcript fed by LaneSnapshot coarse cells (issue #23).
// §16.1 follow-end pinned + manual scroll preserved; §18 text+tool/output
// interleaved inspectable; §61 immediate deltas, one markdown rebuild per
// entry; §80 streaming via replicated LaneSnapshot. Images and diff
// rendering are out of scope.
//
// The ScrollView owns follow state (follow:'end', primary nearest,
// overscroll chain); this module owns the document: delta appends rebuild
// the single Markdown child exactly once per entry and never clear it.
import type { LaneSnapshot } from '../../core/src/presentation.js';
import type { Component } from './tui-boundary.js';
import { Markdown, ScrollView } from './tui-boundary.js';

export type TranscriptEntryKind = 'text' | 'tool' | 'output';

export interface TranscriptEntry {
  readonly id: string;
  readonly kind: TranscriptEntryKind;
  readonly markdown: string;
}

export interface TranscriptDelta {
  readonly id: string;
  readonly kind: TranscriptEntryKind;
  readonly append: string;
}

export type { LaneSnapshot };

const identity = (text: string): string => text;

const TRANSCRIPT_THEME = {
  heading: identity,
  link: identity,
  linkUrl: identity,
  code: identity,
  codeBlock: identity,
  codeBlockBorder: identity,
  quote: identity,
  quoteBorder: identity,
  hr: identity,
  listBullet: identity,
  bold: identity,
  italic: identity,
  strikethrough: identity,
  underline: identity,
};

export interface TranscriptView {
  readonly component: Component;
  readonly scroll: ScrollView;
  appendDelta(delta: TranscriptDelta): void;
  render(width: number): string[];
}

export function createTranscriptView(): TranscriptView {
  const document = new Markdown('', 0, 0, TRANSCRIPT_THEME);
  const scroll = new ScrollView(document, {
    follow: 'end',
    primary: true,
    overscroll: 'chain',
  });
  const entries: Array<{ id: string; kind: TranscriptEntryKind; markdown: string }> =
    [];
  return {
    component: scroll,
    scroll,
    appendDelta(delta: TranscriptDelta): void {
      const found = entries.find((entry) => entry.id === delta.id);
      if (found === undefined) {
        entries.push({
          id: delta.id,
          kind: delta.kind,
          markdown: delta.append,
        });
      } else {
        found.markdown += delta.append;
      }
      document.setText(entries.map((entry) => entry.markdown).join('\n'));
    },
    render(width: number): string[] {
      return scroll.render(width);
    },
  };
}
