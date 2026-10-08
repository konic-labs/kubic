// `kubic models` on an interactive terminal: a catalogue you can choose from —
// the default model marked, every usable provider grouped, large providers
// folded behind the command that expands them, and the providers without a key
// summarised on one line.

import { renderTable } from '../../core/src/cli/table.js';
import type { CliTheme } from '../../core/src/cli/theme.js';

interface CatalogModel {
  readonly id: string;
  readonly contextWindow?: number;
  readonly thinking: readonly string[];
  readonly input: readonly string[];
  readonly inputCost: number;
  readonly outputCost: number;
}

export interface CatalogProvider {
  readonly id: string;
  readonly usable?: boolean;
  readonly auth?: string;
  readonly models: readonly CatalogModel[];
}

export interface CatalogViewOptions {
  /** `provider/id` of the model a run would use; marked `●  default`. */
  readonly defaultModel?: string;
  /** Show only this provider (in full). */
  readonly only?: string;
  /** Include providers without a key (their KEY cell reads `—`). */
  readonly all?: boolean;
  /** A provider with more models than this is folded (default 8). */
  readonly foldOver?: number;
  /** Rows kept above the fold (default 3). */
  readonly keep?: number;
}

export function formatContext(tokens: number | undefined): string {
  if (tokens === undefined || !Number.isFinite(tokens) || tokens <= 0)
    return '—';
  if (tokens >= 1_000_000) {
    const millions = tokens / 1_000_000;
    return `${Number.isInteger(millions) ? millions : millions.toFixed(1)}M`;
  }
  return `${Math.round(tokens / 1000)}k`;
}

function inputKinds(input: readonly string[]): string {
  return input.map((kind) => (kind === 'image' ? 'img' : kind)).join('+');
}

// Dollars per million tokens: two decimals, three for sub-dime prices so a
// cheap model does not read as free.
function price(value: number): string {
  if (value === 0) return '—';
  return value < 0.1 ? value.toFixed(3) : value.toFixed(2);
}

/** The catalogue lines for a coloured terminal. */
export function renderModelsCatalog(
  providers: readonly CatalogProvider[],
  theme: CliTheme,
  options: CatalogViewOptions = {},
): string[] {
  const ui = theme.ui;
  const foldOver = options.foldOver ?? 8;
  const keep = options.keep ?? 3;
  const usable = providers.filter((provider) => provider.usable !== false);
  const keyless = providers.filter((provider) => provider.usable === false);
  const shown =
    options.only !== undefined
      ? providers.filter((provider) => provider.id === options.only)
      : options.all === true
        ? [...usable, ...keyless]
        : usable;

  const rows: string[][] = [];
  const markers: (string | undefined)[] = [];
  const folded: string[] = [];
  for (const provider of shown) {
    const full =
      options.only !== undefined || provider.models.length <= foldOver;
    const models = full ? provider.models : provider.models.slice(0, keep);
    for (const model of models) {
      const ref = `${provider.id}/${model.id}`;
      const isDefault = ref === options.defaultModel;
      const name = isDefault
        ? `${ui.style({ fg: 'fg0', bold: true })(ref)}  ${ui.fg('fg2')('default')}`
        : ui.fg(provider.usable === false ? 'fg2' : 'fg0')(ref);
      rows.push([
        name,
        formatContext(model.contextWindow),
        model.thinking.some((level) => level !== 'off') ? 'yes' : 'no',
        inputKinds(model.input),
        price(model.inputCost),
        price(model.outputCost),
        provider.usable === false ? ui.fg('fg3')('—') : ui.fg('ok')('✓'),
      ]);
      markers.push(isDefault ? ui.fg('ok')('●') : undefined);
    }
    if (!full) {
      folded.push(
        `${ui.fg('fg1')(`${provider.id}/…`)} ${ui.fg('fg2')(
          `${provider.models.length - keep} more`,
        )}  ${ui.fg('fg1')(`kubic models ${provider.id}`)}`,
      );
    }
  }

  const lines: string[] = [];
  if (rows.length > 0) {
    lines.push(
      ...renderTable(
        rows,
        [
          { header: 'MODEL' },
          { header: 'CONTEXT', align: 'right' },
          { header: 'THINKING' },
          { header: 'INPUT' },
          { header: 'IN $/1M', align: 'right' },
          { header: 'OUT $/1M', align: 'right' },
          { header: 'KEY' },
        ],
        { fancy: true, theme, markers },
      ).split('\n'),
    );
  }
  for (const line of folded) lines.push(`  ${line}`);
  if (
    options.only === undefined &&
    options.all !== true &&
    keyless.length > 0
  ) {
    lines.push(
      `  ${ui.fg('fg3')(`○ ${keyless.length} providers without a key`)}  ${ui.fg('fg2')('kubic models --all')}`,
    );
  }
  const keyed = usable.filter((provider) => provider.auth !== undefined);
  if (options.only === undefined && keyed.length > 0) {
    lines.push('');
    lines.push(
      `${ui.fg('fg2')('keys: ')}${keyed
        .map(
          (provider) =>
            `${ui.fg('fg1')(provider.id)} ${ui.fg('fg2')(`← ${provider.auth}`)}`,
        )
        .join(ui.fg('fg2')(' · '))}`,
    );
  }
  lines.push('');
  lines.push(
    `${ui.fg('fg2')('set a default: ')}${ui.fg('fg1')('kubic setup')}`,
  );
  return lines;
}
