// The first screen (EPIC N, issue #462; docs/ui/05-welcome.html 05-A … F):
// a preflight that answers "can I start?" instead of a wall of shortcuts —
// a two-row half-block wordmark (`■ kubic <version>` below 70 columns),
// five rows (provider, project, trust, journal, isolation), the start
// keys, and this project's recent sessions. It sits at the top of an empty
// transcript and is gone after the first prompt. `renderNoKeyPreflight` is
// the same block for a launch with no provider key (05-F): printed to the
// terminal, then exit 6. Pure over a UiTheme.

import type { UiTheme } from '../../core/src/ui/style.js';
import { visibleWidth } from './tui-boundary.js';
import { leftRight, wrapStyled } from './ui/line.js';
import { sectionLabel } from './ui/marks.js';

export type PreflightMark = 'ok' | 'warn' | 'err' | 'info';

export interface PreflightInfo {
  readonly version: string;
  readonly provider: {
    readonly model: string;
    /** Where the key comes from (`ANTHROPIC_API_KEY`). */
    readonly keySource?: string;
    /** The faux testing provider: no model is called. */
    readonly testing?: boolean;
  };
  readonly project?: {
    /** The workspace, shortened (`~/proj`). */
    readonly path: string;
    readonly branch?: string;
    readonly dirty?: number;
    /** False outside a repository; absent while unknown. */
    readonly git?: boolean;
  };
  /** The project layer: absent when the project has none (row omitted). */
  readonly trust?: 'loaded' | 'untrusted';
  /**
   * The honest isolation statement — the limits module's own line, verbatim
   * (the composition root's). Empty when the notice is suppressed: the row
   * then says only `none`.
   */
  readonly isolation: string;
  /** The keys the start row names, as caps (`^P`). */
  readonly keys: {
    readonly palette: string;
    readonly help: string;
  };
  readonly recent?: readonly {
    readonly title: string;
    readonly age: string;
    /** `4 turns · $0.03`. */
    readonly detail: string;
  }[];
}

const WORDMARK = ['█▄▀ █ █ █▄▄ █ █▀▀', '█ █ █▄█ █▄█ █ █▄▄'];
const WORDMARK_MIN_COLUMNS = 70;
const LABEL = 12;
const INDENT = '  ';
// Under the value column: `  ✓ provider     ` is 17 cells.
const HANGING = ' '.repeat(INDENT.length + 2 + LABEL + 1);

const MARK: Record<
  PreflightMark,
  readonly [string, 'ok' | 'warn' | 'err' | 'fg2']
> = {
  ok: ['✓', 'ok'],
  warn: ['◆', 'warn'],
  err: ['✕', 'err'],
  info: ['○', 'fg2'],
};

// One preflight row: mark, label column, value, detail; wrapped under the
// value column when it is wider than the screen.
function row(
  ui: UiTheme,
  width: number,
  mark: PreflightMark,
  label: string,
  value: string,
  detail?: string,
  action?: string,
): string[] {
  const [glyph, role] = MARK[mark];
  const text = [
    ui.fg('fg0')(value),
    ...(detail === undefined || detail === '' ? [] : [ui.fg('fg2')(detail)]),
    ...(action === undefined ? [] : [ui.fg('accent')(action)]),
  ].join('  ');
  const head = `${INDENT}${ui.fg(role)(glyph)} ${ui.fg('fg1')(label.padEnd(LABEL))} `;
  const room = Math.max(10, width - HANGING.length);
  return wrapStyled(text, room).map((line, index) =>
    index === 0 ? `${head}${line}` : `${HANGING}${line}`,
  );
}

function wordmark(ui: UiTheme, version: string, width: number): string[] {
  const glyph = ui.style({ fg: 'accent', bold: true });
  if (width < WORDMARK_MIN_COLUMNS) {
    return [
      `${INDENT}${glyph('■')} ${ui.style({ fg: 'fg0', bold: true })('kubic')}${version === '' ? '' : ` ${ui.fg('fg2')(version)}`}`,
    ];
  }
  const tagline = 'terminal coding agent by Konic';
  return [
    `${INDENT}${glyph(WORDMARK[0] as string)}`,
    `${INDENT}${glyph(WORDMARK[1] as string)}    ${ui.fg('fg2')(version === '' ? tagline : `${version} · ${tagline}`)}`,
  ];
}

function keyRow(
  ui: UiTheme,
  keys: ReadonlyArray<readonly [string, string]>,
): string {
  return `${INDENT}${keys
    .map(
      ([key, label]) =>
        `${ui.style({ fg: 'fg1', bold: true })(key)}${visibleWidth(key) === 1 ? '  ' : ' '}${ui.fg('fg2')(label)}`,
    )
    .join('     ')}`;
}

export function renderPreflight(
  ui: UiTheme,
  info: PreflightInfo,
  width: number,
): string[] {
  const w = Math.max(20, Math.floor(width));
  const lines: string[] = ['', ...wordmark(ui, info.version, w), ''];
  lines.push(`${INDENT}${sectionLabel(ui, 'preflight')}`);
  const { provider, project } = info;
  lines.push(
    ...(provider.testing === true
      ? row(
          ui,
          w,
          'warn',
          'provider',
          provider.model,
          'testing provider, no model is called',
        )
      : row(
          ui,
          w,
          'ok',
          'provider',
          provider.model,
          provider.keySource === undefined
            ? undefined
            : `key from ${provider.keySource}`,
        )),
  );
  if (project !== undefined) {
    if (project.branch !== undefined) {
      const changed = project.dirty ?? 0;
      lines.push(
        ...row(
          ui,
          w,
          'ok',
          'project',
          project.path,
          `git ${project.branch} · ${changed > 0 ? `${changed} changed` : 'clean'}`,
        ),
      );
    } else if (project.git === false) {
      lines.push(
        ...row(ui, w, 'info', 'project', project.path, 'not a git repository'),
      );
    } else {
      lines.push(...row(ui, w, 'ok', 'project', project.path));
    }
  }
  if (info.trust === 'loaded') {
    lines.push(...row(ui, w, 'ok', 'trust', '.kubic/config.toml loaded'));
  } else if (info.trust === 'untrusted') {
    lines.push(
      ...row(
        ui,
        w,
        'warn',
        'trust',
        'project config not trusted — kubic trust',
      ),
    );
  }
  lines.push(
    ...row(
      ui,
      w,
      'ok',
      'journal',
      'on',
      'every change is recorded; /undo reverts a turn',
    ),
    ...row(
      ui,
      w,
      'info',
      'isolation',
      info.isolation !== '' ? info.isolation : 'none',
      undefined,
      '/safety',
    ),
    '',
    `${INDENT}${sectionLabel(ui, 'start')}`,
    `${INDENT}${ui.style({ fg: 'fg1', bold: true })('⏎')}  ${ui.fg('fg1')('describe a task below'.padEnd(29))}${ui.fg('fg2')('e.g. "run npm test and fix the failing test"')}`,
    keyRow(ui, [
      ['/', 'commands'],
      ['@', 'attach a file'],
      [info.keys.palette, 'palette'],
      [info.keys.help, 'all keys'],
    ]),
  );
  const recent = info.recent ?? [];
  if (recent.length > 0) {
    lines.push('', `${INDENT}${sectionLabel(ui, 'recent in this project')}`);
    for (const session of recent.slice(0, 3)) {
      lines.push(
        `${INDENT}${leftRight(
          `${ui.fg('fg2')(session.age.padEnd(9))}${ui.fg('fg1')(session.title)}`,
          ui.fg('fg2')(session.detail),
          Math.max(10, Math.min(w, 100) - INDENT.length),
        )}`,
      );
    }
    lines.push(`${INDENT}${ui.fg('fg2')('/resume to open one')}`);
  }
  // Wrapped rows fit; the start rows and the wordmark may be wider than a
  // very narrow screen, so every line is held to the width.
  return lines.map((line) =>
    visibleWidth(line) <= w ? line : (wrapStyled(line, w)[0] ?? ''),
  );
}

// 05-F: the variables to set, Pi's own names for the common providers.
const NO_KEY_FIXES: ReadonlyArray<readonly [string, string]> = [
  ['export ANTHROPIC_API_KEY=…', 'anthropic'],
  ['export OPENAI_API_KEY=…', 'openai'],
  ['export OPENROUTER_API_KEY=…', 'many models through one key'],
];

/** 05-F: no provider has a key — the fix, printed before exit 6. */
export function renderNoKeyPreflight(
  ui: UiTheme,
  info: { readonly project?: PreflightInfo['project'] },
): string[] {
  const head = `${INDENT}${ui.fg('err')('✕')} ${ui.fg('fg1')('provider'.padEnd(LABEL))} `;
  const lines = [
    `${INDENT}${sectionLabel(ui, 'preflight')}`,
    `${head}${ui.fg('fg0')('no model provider has a key')}`,
    `${HANGING}${ui.fg('fg1')('set one, then start kubic again:')}`,
    ...NO_KEY_FIXES.map(
      ([fix, note]) =>
        `${HANGING}${ui.fg('fg0')(fix.padEnd(31))}${ui.fg('fg2')(note)}`,
    ),
    `${HANGING}${ui.fg('fg2')('or add a local model in ~/.kubic/models/models.json')}`,
    `${HANGING}${ui.fg('fg2')('or try it without a model: KUBIC_PROVIDER=faux kubic')}`,
  ];
  const project = info.project;
  if (project !== undefined) {
    const detail =
      project.branch !== undefined
        ? `git ${project.branch} · ${(project.dirty ?? 0) > 0 ? `${project.dirty} changed` : 'clean'}`
        : project.git === false
          ? 'not a git repository'
          : undefined;
    lines.push(
      ...row(
        ui,
        200,
        project.branch === undefined && project.git === false ? 'info' : 'ok',
        'project',
        project.path,
        detail,
      ),
    );
  }
  lines.push('', `${INDENT}${ui.fg('fg2')('exit 6 · provider_probe_failed')}`);
  return lines;
}
