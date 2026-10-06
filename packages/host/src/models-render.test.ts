// `kubic models` catalogue view (issue #449; docs/ui/06-cli.html 06-D).
import { describe, expect, it } from 'vitest';
import { createCliTheme } from '../../core/src/cli/theme.js';
import {
  type CatalogProvider,
  formatContext,
  renderModelsCatalog,
} from './models-render.js';

function models(count: number, prefix: string) {
  return Array.from({ length: count }, (_, index) => ({
    id: `${prefix}-${index + 1}`,
    contextWindow: 200_000,
    thinking: ['off', 'low', 'high'],
    input: ['text', 'image'],
    inputCost: 3,
    outputCost: 15,
  }));
}

const CATALOG: CatalogProvider[] = [
  {
    id: 'anthropic',
    usable: true,
    auth: 'ANTHROPIC_API_KEY',
    models: [
      {
        id: 'sonnet',
        contextWindow: 200_000,
        thinking: ['off', 'low', 'high'],
        input: ['text', 'image'],
        inputCost: 3,
        outputCost: 15,
      },
      {
        id: 'opus',
        contextWindow: 1_000_000,
        thinking: ['off', 'high'],
        input: ['text'],
        inputCost: 15,
        outputCost: 75,
      },
    ],
  },
  { id: 'bedrock', usable: true, auth: 'AWS_PROFILE', models: models(12, 'b') },
  { id: 'openai', usable: false, models: models(4, 'gpt') },
  { id: 'google', usable: false, models: models(2, 'gem') },
];

const plain = createCliTheme('none');

describe('formatContext', () => {
  it('formats windows', () => {
    expect(formatContext(200_000)).toBe('200k');
    expect(formatContext(1_000_000)).toBe('1M');
    expect(formatContext(1_500_000)).toBe('1.5M');
    expect(formatContext(undefined)).toBe('—');
  });
});

describe('the catalogue view', () => {
  it('marks the default, folds big providers and summarises the keyless', () => {
    const lines = renderModelsCatalog(CATALOG, plain, {
      defaultModel: 'anthropic/sonnet',
    });
    expect(lines[0]).toMatch(
      /^ {2}MODEL\s+CONTEXT\s+THINKING\s+INPUT\s+IN \$\/1M\s+OUT \$\/1M\s+KEY$/,
    );
    expect(lines[1]).toMatch(/^─+$/);
    expect(lines[2]).toMatch(
      /^● anthropic\/sonnet {2}default\s+200k\s+yes\s+text\+img\s+3\.00\s+15\.00\s+✓$/,
    );
    expect(lines[3]).toMatch(
      /^ {2}anthropic\/opus\s+1M\s+yes\s+text\s+15\.00\s+75\.00\s+✓$/,
    );
    // bedrock: 3 rows above the fold, then the expand hint
    expect(lines.filter((line) => line.includes('bedrock/b-')).length).toBe(3);
    expect(lines).toContain('  bedrock/… 9 more  kubic models bedrock');
    expect(lines).toContain(
      '  ○ 2 providers without a key  kubic models --all',
    );
    expect(lines).toContain(
      'keys: anthropic ← ANTHROPIC_API_KEY · bedrock ← AWS_PROFILE',
    );
    expect(lines.at(-1)).toBe('set a default: kubic setup');
  });

  it('lists one provider in full', () => {
    const lines = renderModelsCatalog(CATALOG, plain, { only: 'bedrock' });
    expect(lines.filter((line) => line.includes('bedrock/b-')).length).toBe(12);
    expect(lines.some((line) => line.includes('more'))).toBe(false);
    expect(lines.some((line) => line.includes('anthropic'))).toBe(false);
  });

  it('includes keyless providers with --all', () => {
    const lines = renderModelsCatalog(CATALOG, plain, { all: true });
    expect(lines.some((line) => /openai\/gpt-1.*—$/.test(line))).toBe(true);
    expect(lines.some((line) => line.includes('without a key'))).toBe(false);
  });

  it('colours the default marker and key cells', () => {
    const rich = createCliTheme('truecolor');
    const text = renderModelsCatalog(CATALOG, rich, {
      defaultModel: 'anthropic/sonnet',
    }).join('\n');
    expect(text).toContain(rich.ui.fg('ok')('●'));
    expect(text).toContain(rich.ui.fg('ok')('✓'));
  });
});
