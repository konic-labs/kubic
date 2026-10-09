// The CLI render matrix for the host's grouped reports: `kubic doctor`'s
// grouped summary at 60/80/120 columns and the `kubic models` catalog, for
// every palette (dark, light, terminal) × colour level (truecolor, 256, 16,
// none). A line fits the columns it was given, carries no escape at depth none
// and closes every style it opens.

import { createCliTheme } from '@kubic/core/cli/theme';
import { visibleWidth } from '@kubic/core/cli/width';
import type { ColorLevel } from '@kubic/core/ui/color';
import { openStyles } from '@kubic/core/ui/style';
import {
  DARK_PALETTE,
  LIGHT_PALETTE,
  type Palette,
  TERMINAL_PALETTE,
} from '@kubic/core/ui/tokens';
import { describe, expect, it } from 'vitest';
import type { DoctorCheck } from './doctor.js';
import { renderDoctorGrouped } from './doctor-render.js';
import { type CatalogProvider, renderModelsCatalog } from './models-render.js';

const PALETTES: ReadonlyArray<readonly [string, Palette]> = [
  ['dark', DARK_PALETTE],
  ['light', LIGHT_PALETTE],
  ['terminal', TERMINAL_PALETTE],
];
const LEVELS: readonly ColorLevel[] = ['truecolor', '256', '16', 'none'];
const COLUMNS = [60, 80, 120];

const check = (
  id: string,
  status: DoctorCheck['status'],
  detail: string,
): DoctorCheck => ({ id, label: id, status, reason: 'ok', detail });

const CHECKS: DoctorCheck[] = [
  check(
    'provider:anthropic',
    'pass',
    'listed, not dialled, 23 model(s) registered — built-in, auth from ANTHROPIC_API_KEY',
  ),
  check('dep:node', 'pass', 'node 24.13.0 (need >=22.19)'),
  check(
    'limit:resources',
    'warn',
    'per-agent limits — enforced: wall clock; NOT enforced: memory, disk, which is a long sentence that wraps',
  ),
  check(
    'policy:installed',
    'fail',
    'source=default, filesystem=workspace-write, shell=true, network=none, git=workspace, credentials=none; 18 allowed tool(s): read, ls, find, grep, write, edit, bash',
  ),
  check('role:planner', 'skip', 'no planner model configured'),
];

const CATALOG: CatalogProvider[] = [
  {
    id: 'anthropic',
    usable: true,
    auth: 'ANTHROPIC_API_KEY',
    models: [
      {
        id: 'claude-sonnet-5-5-with-a-long-model-id',
        contextWindow: 1_000_000,
        thinking: ['off', 'low', 'high'],
        input: ['text', 'image'],
        inputCost: 3,
        outputCost: 15,
      },
    ],
  },
  { id: 'openai', usable: false, models: [] },
];

describe('the host CLI render matrix', () => {
  it('doctor and models fit, close their styles and carry none at depth none', () => {
    const failures: string[] = [];
    for (const [paletteName, palette] of PALETTES) {
      for (const level of LEVELS) {
        const theme = createCliTheme(level, palette, paletteName);
        const inspect = (
          name: string,
          lines: readonly string[],
          columns?: number,
        ): void => {
          lines
            .flatMap((line) => line.split('\n'))
            .forEach((line, index) => {
              const where = `${name} · ${paletteName}/${level}${columns === undefined ? '' : `/${columns}`} line ${index}`;
              if (columns !== undefined && visibleWidth(line) > columns) {
                failures.push(`${where}: ${visibleWidth(line)} cells`);
              }
              if (level === 'none' && line.includes('\u001b')) {
                failures.push(`${where}: escape at depth none`);
              }
              const open = openStyles(line);
              if (open.length > 0) {
                failures.push(`${where}: leaves ${open.join(', ')} open`);
              }
            });
        };
        for (const columns of COLUMNS) {
          inspect(
            'doctor',
            renderDoctorGrouped(CHECKS, theme, { exitCode: 1, columns }),
            columns,
          );
        }
        inspect(
          'models',
          renderModelsCatalog(CATALOG, theme, {
            defaultModel: 'anthropic/claude-sonnet-5-5-with-a-long-model-id',
          }),
        );
      }
    }
    expect(failures).toEqual([]);
  });
});
