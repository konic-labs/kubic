// Small marks for the TUI kit: badges, gauges, section
// labels and rules. All pure over a UiTheme; plain text at depth none.

import { GAUGE } from '@kubic/core/ui/glyphs';
import type { UiTheme } from '@kubic/core/ui/style';
import type { TokenRole } from '@kubic/core/ui/tokens';

export type BadgeKind = 'accent' | 'waiting' | 'ok' | 'error' | 'key';

const BADGE_ROLE: Record<Exclude<BadgeKind, 'key'>, TokenRole> = {
  accent: 'accent',
  waiting: 'warn',
  ok: 'ok',
  error: 'err',
};

/**
 * ` APPROVAL ` on an inverse cell (`accent`, `waiting`, `ok`, `error`), or a
 * raised key cap ` a ` (`key`). Without colour the text is bracketed
 * (`[APPROVAL]`) so it still reads as a badge.
 */
export function badge(ui: UiTheme, text: string, kind: BadgeKind): string {
  if (!ui.enabled) return `[${text}]`;
  if (kind === 'key') {
    return ui.style({ fg: 'fg0', bg: 'bg3', bold: true })(` ${text} `);
  }
  return ui.style({ fg: BADGE_ROLE[kind], inverse: true, bold: true })(
    ` ${text} `,
  );
}

export interface GaugeOptions {
  /** At or above this fraction the filled cells turn warn (default 0.8). */
  readonly warnAt?: number;
  /** At or above this fraction the filled cells turn err (default 1). */
  readonly failAt?: number;
}

/**
 * `━━━━━━━━━━` with the filled part in fg0 (warn at 80%, err at 100%) and
 * the track in fg3. Without colour the track is a light rule so the level
 * still reads. NaN and negatives are empty; overflow is full.
 */
export function gauge(
  ui: UiTheme,
  fraction: number,
  cells: number,
  options: GaugeOptions = {},
): string {
  const size = Math.max(0, Math.floor(cells));
  const value = Number.isFinite(fraction) ? Math.max(0, fraction) : 0;
  const filled = Math.min(size, Math.round(Math.min(value, 1) * size));
  const role: TokenRole =
    value >= (options.failAt ?? 1)
      ? 'err'
      : value >= (options.warnAt ?? 0.8)
        ? 'warn'
        : 'fg0';
  const track = ui.enabled ? GAUGE : '─';
  return `${ui.fg(role)(GAUGE.repeat(filled))}${ui.fg('fg3')(track.repeat(size - filled))}`;
}

/** A muted, bold, uppercase section label: `COMMANDS`. */
export function sectionLabel(ui: UiTheme, text: string): string {
  return ui.style({ fg: 'fg2', bold: true })(text.toUpperCase());
}
