// The pickers in the app: the
// model picker's provider groups, keyless providers, folding and thinking
// row, and the list picker every other "choose one" uses.
import { describe, expect, it } from 'vitest';
import { createApprovalSurface } from './approval-surface.js';
import type { ApprovalOverlayTui } from './approval-view.js';
import { clampThinking, createTuiApp } from './tui-app.js';
import type { Component } from './tui-boundary.js';

function setup() {
  const app = createTuiApp({
    sessionId: 'sess-461',
    model: 'anthropic/sonnet',
    approvalsSkipped: false,
    approvalSurface: createApprovalSurface({ armingMs: 0 }),
  });
  const shown: Array<{ component: Component; hidden: boolean }> = [];
  const host: ApprovalOverlayTui = {
    terminal: { columns: 120, rows: 40 },
    showOverlay: (component) => {
      const entry = { component, hidden: false };
      shown.push(entry);
      return {
        unfocus: () => {},
        hide: () => {
          entry.hidden = true;
        },
      };
    },
  };
  app.attachApprovalOverlay(host);
  const frame = (): string =>
    shown
      .find((entry) => !entry.hidden)
      ?.component.render(80)
      .join('\n') ?? '';
  return { app, frame };
}

const ROWS = [
  {
    provider: 'anthropic',
    id: 'sonnet',
    label: 'anthropic/sonnet',
    current: true,
    contextWindow: 200_000,
    reasoning: true,
    thinking: ['off', 'low', 'medium', 'high'],
  },
  {
    provider: 'anthropic',
    id: 'haiku',
    label: 'anthropic/haiku',
    contextWindow: 200_000,
    reasoning: false,
    thinking: ['off'],
  },
  ...Array.from({ length: 10 }, (_, i) => ({
    provider: 'amazon-bedrock',
    id: `m${i}`,
    label: `amazon-bedrock/m${i}`,
    thinking: ['off', 'low'],
  })),
];

const PROVIDERS = [
  { id: 'openai', usable: false, keyVar: 'OPENAI_API_KEY' },
  { id: 'anthropic', usable: true, keySource: 'ANTHROPIC_API_KEY' },
  { id: 'amazon-bedrock', usable: true, keySource: 'AWS_PROFILE' },
];

describe('the model picker', () => {
  it('groups by provider, folds the large one, lists keyless ones last', () => {
    const { app, frame } = setup();
    expect(
      app.openModelPicker({
        rows: ROWS,
        providers: PROVIDERS,
        thinking: 'high',
        onSelect: () => {},
      }),
    ).toBe(true);
    const lines = frame().split('\n');
    const at = (text: string): number =>
      lines.findIndex((line) => line.includes(text));
    expect(lines[0]).toContain('┌─ Model');
    expect(at('ANTHROPIC  ● key from ANTHROPIC_API_KEY')).toBeGreaterThan(0);
    expect(frame()).toContain('● sonnet  current');
    expect(frame()).toContain('200k ctx · thinking');
    expect(frame()).toContain('AMAZON BEDROCK  ● key from AWS_PROFILE');
    expect(frame()).toContain('10 models');
    expect(frame()).toContain('▸ expand (→)');
    expect(at('OPENAI  ○ no key')).toBeGreaterThan(at('AMAZON BEDROCK'));
    expect(frame()).toContain('set OPENAI_API_KEY');
    // The thinking row: the model's levels, the live one where it starts.
    expect(frame()).toMatch(/thinking {2}off {2}low {2}medium {2} high /);
    expect(frame()).toContain('←→ change');
  });

  it('takes the model and the thinking level together', () => {
    const { app } = setup();
    const picked: string[] = [];
    app.openModelPicker({
      rows: ROWS,
      providers: PROVIDERS,
      thinking: 'high',
      onSelect: (row, thinking) =>
        picked.push(`${row.provider}/${row.id} ${thinking}`),
    });
    app.handleInput('\x1b[D');
    app.handleInput('\x1b[D');
    app.handleInput('\r');
    expect(picked).toEqual(['anthropic/sonnet low']);
    // A model with fewer levels clamps the chosen one down.
    app.openModelPicker({
      rows: ROWS,
      providers: PROVIDERS,
      thinking: 'high',
      onSelect: (row, thinking) =>
        picked.push(`${row.provider}/${row.id} ${thinking}`),
    });
    app.handleInput('\x1b[B');
    app.handleInput('\r');
    expect(picked.at(-1)).toBe('anthropic/haiku off');
  });

  it('opens a folded provider with → and never offers a keyless one', () => {
    const { app, frame } = setup();
    const picked: string[] = [];
    app.openModelPicker({
      rows: ROWS,
      providers: PROVIDERS,
      onSelect: (row) => picked.push(`${row.provider}/${row.id}`),
    });
    app.handleInput('\x1b[B');
    app.handleInput('\x1b[B');
    app.handleInput('\x1b[C');
    expect(frame()).toContain('m9');
    app.handleInput('\r');
    expect(picked).toEqual(['amazon-bedrock/m0']);
    // Filtering never reaches a keyless provider's models.
    app.openModelPicker({
      rows: [...ROWS, { provider: 'openai', id: 'gpt', label: 'openai/gpt' }],
      providers: PROVIDERS,
      onSelect: (row) => picked.push(`${row.provider}/${row.id}`),
    });
    for (const ch of 'gpt') app.handleInput(ch);
    app.handleInput('\r');
    expect(picked).toEqual(['amazon-bedrock/m0']);
  });

  it('clamps a level the model lacks down to one it has', () => {
    expect(clampThinking('high', ['off', 'low', 'medium', 'high'])).toBe(
      'high',
    );
    expect(clampThinking('high', ['off', 'low'])).toBe('low');
    expect(clampThinking('max', ['off'])).toBe('off');
    expect(clampThinking('low', ['medium', 'high'])).toBe('medium');
  });
});

describe('the list picker', () => {
  it('titles the frame, greys what cannot be chosen and previews moves', () => {
    const { app, frame } = setup();
    const moved: Array<string | undefined> = [];
    const chosen: string[] = [];
    app.openPicker({
      title: 'Session',
      rows: [
        { value: 'a', label: 'fix the cart', description: '2m ago · 4 turns' },
        {
          value: 'b',
          label: 'old one',
          disabled: true,
          note: 'legacy — kubic sessions',
        },
        { value: 'c', label: 'add tests', description: '1h ago · 2 turns' },
      ],
      onSelect: (value) => chosen.push(value),
      onMove: (value) => moved.push(value),
    });
    expect(frame()).toContain('┌─ Session');
    expect(frame()).toContain('old one  legacy — kubic sessions');
    app.handleInput('\x1b[B');
    expect(moved).toEqual(['c']);
    app.handleInput('\r');
    expect(chosen).toEqual(['c']);
  });
});
