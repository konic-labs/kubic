// `kubic doctor` on an interactive terminal: a summary line, the checks grouped
// by area with ✓ / ▲ / ✕ / ○, and the full per-check report behind `--verbose`.
// Passing checks pack onto one line per group; every warning, skip and failure
// gets its own row, and a failure is always shown in full so the fix is on
// screen. The five "honest limit" warnings (never fixable, always present) fold
// into one row; the verbose report keeps each of them.

import {
  brandHeading,
  hintLine,
  sectionLabel,
  statusMark,
} from '../../core/src/cli/kit.js';
import type { CliTheme } from '../../core/src/cli/theme.js';
import {
  truncateVisible,
  visibleWidth,
  wrapVisible,
} from '../../core/src/cli/width.js';
import type { DoctorCheck } from './doctor.js';

const LABEL_WIDTH = 12;
const DEFAULT_COLUMNS = 100;

// Check id → group, by id prefix. Unknown prefixes land in OTHER so a new
// check is never hidden from the summary.
const GROUP_ORDER = [
  'runtime',
  'providers',
  'project',
  'policy',
  'limits',
  'roles',
  'skills',
  'other',
] as const;

type Group = (typeof GROUP_ORDER)[number];

export function doctorGroup(id: string): Group {
  if (id.startsWith('role:')) return 'roles';
  if (id.startsWith('provider:') || id === 'limit:provider-availability') {
    return 'providers';
  }
  if (
    id.startsWith('dep:') ||
    id.startsWith('license:') ||
    id.startsWith('state:') ||
    id === 'limit:deps-present'
  ) {
    return 'runtime';
  }
  if (id.startsWith('session:')) return 'project';
  if (id.startsWith('policy:') || id.startsWith('audit:')) return 'policy';
  if (id.startsWith('limit:')) return 'limits';
  if (id === 'skills' || id.startsWith('skill:')) return 'skills';
  return 'other';
}

function isHonestLimit(check: DoctorCheck): boolean {
  return (
    check.id.startsWith('limit:') &&
    check.detail.startsWith('honest limit (not enforced)')
  );
}

function firstClause(text: string): string {
  const cut = text.split(/ — |; | \(/u)[0] ?? text;
  return cut.trim();
}

function match(text: string, pattern: RegExp): string | undefined {
  return pattern.exec(text)?.[1];
}

/** The short form of one check, for the grouped summary. */
export function doctorShort(check: DoctorCheck): string {
  const { id, detail } = check;
  const suffix = id.includes(':') ? id.slice(id.indexOf(':') + 1) : id;
  if (id.startsWith('provider:') && id !== 'provider:probe') {
    const models = match(detail, /(\d+) model\(s\)/u);
    const auth = match(detail, /auth from (\S+)/u);
    return [
      suffix,
      models === undefined ? undefined : `${models} models`,
      auth === undefined ? undefined : `key from ${auth.replace(/[,.]$/u, '')}`,
    ]
      .filter((part) => part !== undefined)
      .join('  ');
  }
  switch (id) {
    case 'dep:node':
      return match(detail, /^(node [^\s(]+)/u) ?? 'node';
    case 'dep:config-load':
      return 'config';
    case 'dep:models-json':
      return 'models.json';
    case 'license:kubic':
      return `license ${firstClause(detail)}`;
    case 'state:permissions':
      return 'state private';
    case 'limit:deps-present':
      return 'deps present';
    case 'limit:provider-availability':
      return 'provider available';
    case 'policy:approvals':
      return `approvals ${match(detail, /route=([a-z-]+)/u) ?? ''}`.trim();
    case 'policy:installed': {
      const fs = match(detail, /filesystem=([a-z-]+)/u);
      const net = match(detail, /network=([a-z-]+)/u);
      const tools = match(detail, /(\d+) allowed tool\(s\)/u);
      return [
        fs,
        net === undefined ? undefined : `network ${net}`,
        tools === undefined ? undefined : `${tools} tools`,
      ]
        .filter((part) => part !== undefined)
        .join(' · ');
    }
    case 'policy:enforceability':
      return 'routing policy';
    case 'policy:detection-only':
      return 'guards are detection-only (lexical), not a sandbox';
    case 'skills': {
      const loaded = match(detail, /^(\d+) loaded/u);
      return loaded === undefined ? 'skills' : `skills ${loaded} loaded`;
    }
  }
  if (id.startsWith('role:') && id !== 'role:documents') return suffix;
  return `${suffix} — ${firstClause(detail)}`;
}

const MARK: Record<DoctorCheck['status'], 'ok' | 'warn' | 'fail' | 'skip'> = {
  pass: 'ok',
  warn: 'warn',
  fail: 'fail',
  skip: 'skip',
};

export interface DoctorRenderOptions {
  readonly exitCode: number;
  readonly columns?: number;
}

/** The grouped summary lines for a coloured terminal. */
export function renderDoctorGrouped(
  checks: readonly DoctorCheck[],
  theme: CliTheme,
  options: DoctorRenderOptions,
): string[] {
  const ui = theme.ui;
  const columns = options.columns ?? DEFAULT_COLUMNS;
  const room = Math.max(20, columns - LABEL_WIDTH);
  const count = (status: DoctorCheck['status']): number =>
    checks.filter((check) => check.status === status).length;
  const ok = count('pass');
  const warnings = count('warn');
  const failed = count('fail');
  const skipped = count('skip');
  const totals = [
    `${checks.length} checks`,
    ui.fg('ok')(`${ok} ok`),
    warnings === 0
      ? undefined
      : ui.fg('warn')(`${warnings} warning${warnings === 1 ? '' : 's'}`),
    failed === 0 ? ui.fg('fg2')('0 failed') : ui.fg('err')(`${failed} failed`),
    skipped === 0 ? undefined : ui.fg('fg2')(`${skipped} skipped`),
  ].filter((part) => part !== undefined);
  // A narrow terminal takes the totals on their own line.
  const heading = `${brandHeading(theme, 'doctor')} ${ui.fg('fg2')('·')} ${totals.join(ui.fg('fg2')(' · '))}`;
  const lines: string[] =
    visibleWidth(heading) <= columns
      ? [heading, '']
      : [
          brandHeading(theme, 'doctor'),
          truncateVisible(totals.join(ui.fg('fg2')(' · ')), columns),
          '',
        ];

  for (const group of GROUP_ORDER) {
    const members = checks.filter((check) => doctorGroup(check.id) === group);
    if (members.length === 0) continue;
    const rows: string[] = [];
    // Passing checks pack onto shared lines.
    let packed = '';
    for (const check of members.filter((c) => c.status === 'pass')) {
      const item = `${statusMark(theme, 'ok')} ${ui.fg('fg1')(doctorShort(check))}`;
      const next = packed === '' ? item : `${packed}   ${item}`;
      if (packed !== '' && visibleWidth(next) > room) {
        rows.push(truncateVisible(packed, room));
        packed = item;
      } else {
        packed = next;
      }
    }
    if (packed !== '') rows.push(truncateVisible(packed, room));
    const honest = members.filter(
      (check) => check.status === 'warn' && isHonestLimit(check),
    );
    for (const check of members) {
      if (check.status === 'pass' || honest.includes(check)) continue;
      const mark = statusMark(theme, MARK[check.status]);
      if (check.status === 'fail') {
        // A failure reads whole: its detail wraps under it, never cut
        // so it never runs past the terminal's edge.
        const [first = '', ...rest] = wrapVisible(
          `${check.id} ${check.detail}`,
          Math.max(1, room - 2),
        );
        const id = first.startsWith(check.id)
          ? `${ui.style({ fg: 'err', bold: true })(check.id)}${ui.fg('fg0')(first.slice(check.id.length))}`
          : ui.fg('fg0')(first);
        rows.push(`${mark} ${id}`);
        for (const more of rest) rows.push(`  ${ui.fg('fg0')(more)}`);
        continue;
      }
      rows.push(
        truncateVisible(`${mark} ${ui.fg('fg1')(doctorShort(check))}`, room),
      );
    }
    if (honest.length > 0) {
      const names = honest
        .map((check) => check.id.slice('limit:'.length).replaceAll('-', ' '))
        .join(' · ');
      rows.push(
        truncateVisible(
          `${statusMark(theme, 'warn')} ${ui.fg('fg1')(`honest limits: ${names}`)}`,
          room,
        ),
      );
    }
    rows.forEach((row, index) => {
      lines.push(
        index === 0
          ? `${sectionLabel(theme, group, LABEL_WIDTH)}${row}`
          : `${' '.repeat(LABEL_WIDTH)}${row}`,
      );
    });
  }

  lines.push('');
  const verdict =
    failed > 0
      ? `${failed} failed — fix the ✕ rows`
      : warnings > 0
        ? `${warnings} warning${warnings === 1 ? '' : 's'}, nothing blocking`
        : 'all clear';
  const footer = `${verdict} · \`kubic doctor --verbose\` for the full report`;
  // Too wide for the terminal, the pointer takes its own line.
  if (visibleWidth(hintLine(theme, footer, 0)) <= columns) {
    lines.push(hintLine(theme, footer, 0));
  } else {
    lines.push(
      hintLine(theme, verdict, 0),
      hintLine(theme, '`kubic doctor --verbose` for the full report', 0),
    );
  }
  return lines;
}
