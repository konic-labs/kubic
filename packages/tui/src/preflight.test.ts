// The first screen:
// the wordmark, a five-line preflight, the start keys and the recent
// sessions — and the no-key block printed before exit 6.
import { describe, expect, it } from 'vitest';
import { createUiTheme } from '../../core/src/ui/style.js';
import { DARK_PALETTE } from '../../core/src/ui/tokens.js';
import {
  type PreflightInfo,
  renderNoKeyPreflight,
  renderPreflight,
} from './preflight.js';
import { visibleWidth } from './tui-boundary.js';

const plain = createUiTheme(DARK_PALETTE, 'none');
const rich = createUiTheme(DARK_PALETTE, 'truecolor');

const BASE: PreflightInfo = {
  version: '0.1.0',
  provider: {
    model: 'anthropic/claude-sonnet-5-5',
    keySource: 'ANTHROPIC_API_KEY',
  },
  project: { path: '~/Desktop/kubic-playground', branch: 'main', dirty: 0 },
  trust: 'loaded',
  isolation:
    'Kubic: no isolation - in-process with your authority; controls: approvals + journal',
  keys: { palette: '^P', help: '?' },
};

const trimmed = (lines: readonly string[]): string[] =>
  lines.map((line) => line.trimEnd());

describe('preflight', () => {
  it('reads like the design', () => {
    expect(trimmed(renderPreflight(plain, BASE, 110))).toEqual([
      '',
      '  █▄▀ █ █ █▄▄ █ █▀▀',
      '  █ █ █▄█ █▄█ █ █▄▄    0.1.0 · terminal coding agent by Konic',
      '',
      '  PREFLIGHT',
      '  ✓ provider     anthropic/claude-sonnet-5-5  key from ANTHROPIC_API_KEY',
      '  ✓ project      ~/Desktop/kubic-playground  git main · clean',
      '  ✓ trust        .kubic/config.toml loaded',
      '  ✓ journal      on  every change is recorded; /undo reverts a turn',
      '  ○ isolation    Kubic: no isolation - in-process with your authority; controls: approvals + journal  /safety',
      '',
      '  START',
      '  ⏎  describe a task below        e.g. "run npm test and fix the failing test"',
      '  /  commands     @  attach a file     ^P palette     ?  all keys',
    ]);
  });

  it('says so for the testing provider, an untrusted or absent project layer and outside git', () => {
    const faux = trimmed(
      renderPreflight(
        plain,
        {
          ...BASE,
          provider: { model: 'faux/echo', testing: true },
          project: { path: '~/scratch', git: false },
          trust: 'untrusted',
        },
        110,
      ),
    );
    expect(faux).toContain(
      '  ◆ provider     faux/echo  testing provider, no model is called',
    );
    expect(faux).toContain('  ○ project      ~/scratch  not a git repository');
    expect(faux).toContain(
      '  ◆ trust        project config not trusted — kubic trust',
    );
    const dirty = trimmed(
      renderPreflight(
        plain,
        { ...BASE, project: { path: '~/p', branch: 'dev', dirty: 3 } },
        110,
      ),
    );
    expect(dirty).toContain('  ✓ project      ~/p  git dev · 3 changed');
    const { trust: _trust, ...noLayer } = BASE;
    expect(
      renderPreflight(plain, noLayer, 110).some((line) =>
        line.includes('trust'),
      ),
    ).toBe(false);
  });

  it('keeps the honest minimum when the notice is suppressed', () => {
    expect(
      trimmed(renderPreflight(plain, { ...BASE, isolation: '' }, 110)),
    ).toContain('  ○ isolation    none  /safety');
  });

  it('lists recent sessions with the way back to them', () => {
    const lines = trimmed(
      renderPreflight(
        plain,
        {
          ...BASE,
          recent: [
            {
              title: 'run npm test and fix the failing test',
              age: '2m ago',
              detail: '4 turns · $0.03',
            },
            {
              title: 'implement titleCase in src/format.js',
              age: '1d ago',
              detail: '2 turns · $0.01',
            },
          ],
        },
        110,
      ),
    );
    const at = lines.indexOf('  RECENT IN THIS PROJECT');
    expect(at).toBeGreaterThan(0);
    expect(lines[at + 1]).toMatch(
      /^ {2}2m ago {3}run npm test and fix the failing test +4 turns · \$0\.03$/,
    );
    expect(lines[at + 3]).toBe('  /resume to open one');
  });

  it('names no version it does not know', () => {
    const lines = trimmed(
      renderPreflight(plain, { ...BASE, version: '' }, 110),
    );
    expect(lines[2]).toBe(
      '  █ █ █▄█ █▄█ █ █▄▄    terminal coding agent by Konic',
    );
    expect(
      trimmed(renderPreflight(plain, { ...BASE, version: '' }, 60))[1],
    ).toBe('  ■ kubic');
  });

  it('collapses the wordmark below 70 columns and fits the width', () => {
    const lines = renderPreflight(rich, BASE, 60);
    expect(lines[1]).toBe(
      `  ${rich.style({ fg: 'accent', bold: true })('■')} ${rich.style({ fg: 'fg0', bold: true })('kubic')} ${rich.fg('fg2')('0.1.0')}`,
    );
    for (const line of lines)
      expect(visibleWidth(line)).toBeLessThanOrEqual(60);
    // The marks carry their roles at colour.
    expect(lines.join('\n')).toContain(rich.fg('ok')('✓'));
  });
});

describe('no key', () => {
  it('prints the fix as plain terminal text', () => {
    expect(
      trimmed(
        renderNoKeyPreflight(plain, {
          project: {
            path: '~/Desktop/kubic-playground',
            branch: 'main',
            dirty: 0,
          },
        }),
      ),
    ).toEqual([
      '  PREFLIGHT',
      '  ✕ provider     no model provider has a key',
      '                 set one, then start kubic again:',
      '                 export ANTHROPIC_API_KEY=…     anthropic',
      '                 export OPENAI_API_KEY=…        openai',
      '                 export OPENROUTER_API_KEY=…    many models through one key',
      '                 or add a local model in ~/.kubic/models/models.json',
      '                 or try it without a model: KUBIC_PROVIDER=faux kubic',
      '  ✓ project      ~/Desktop/kubic-playground  git main · clean',
      '',
      '  exit 6 · provider_probe_failed',
    ]);
  });
});
