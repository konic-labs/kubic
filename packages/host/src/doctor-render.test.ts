// `kubic doctor` grouped summary.
import { describe, expect, it } from 'vitest';
import { createCliTheme } from '../../core/src/cli/theme.js';
import type { DoctorCheck } from './doctor.js';
import {
  doctorGroup,
  doctorShort,
  renderDoctorGrouped,
} from './doctor-render.js';

function check(
  id: string,
  status: DoctorCheck['status'],
  detail: string,
  reason: DoctorCheck['reason'] = 'ok',
): DoctorCheck {
  return { id, label: id, status, reason, detail };
}

// The shape of a real report (captured from `kubic doctor --json`).
const CHECKS: DoctorCheck[] = [
  check(
    'provider:anthropic',
    'pass',
    'listed, not dialled, 23 model(s) registered — built-in, auth from ANTHROPIC_API_KEY',
  ),
  check('dep:node', 'pass', 'node 24.13.0 (need >=22.19)'),
  check(
    'dep:config-load',
    'pass',
    '0 effective value(s); project layer not trusted',
  ),
  check('dep:models-json', 'pass', 'no models.json (built-in providers only)'),
  check(
    'limit:resources',
    'warn',
    'per-agent limits — enforced: wall clock; NOT enforced: memory, disk',
  ),
  check(
    'policy:approvals',
    'pass',
    'route=ask-user, 0 auto-approved, maxPendingMs=60000',
  ),
  check(
    'policy:installed',
    'pass',
    'source=default, filesystem=workspace-write, shell=true, network=none, git=workspace, credentials=none; 18 allowed tool(s): read, ls',
  ),
  check(
    'policy:detection-only',
    'warn',
    'detection only (not enforcement): network=none is a lexical bash command detector',
    'detection-only',
  ),
  check('role:planner', 'pass', 'builtin role — 5 tool(s): bash'),
  check('role:reviewer', 'pass', 'builtin role — 5 tool(s): bash'),
  check('skills', 'pass', '0 loaded, 0 hidden, 0 withheld, 0 errors'),
  check(
    'state:permissions',
    'pass',
    'session and journal state directories are private (0700) or absent',
  ),
  check(
    'session:overlap',
    'warn',
    '5 sessions recorded against /work/repo — one may be live',
  ),
  check('license:kubic', 'pass', 'MIT (see LICENSE)'),
  check(
    'limit:solo-no-isolation',
    'warn',
    'honest limit (not enforced): solo runs in-process',
  ),
  check(
    'limit:journal-not-backup',
    'warn',
    'honest limit (not enforced): the change journal is a review/undo log',
  ),
  check(
    'limit:provider-availability',
    'pass',
    'listed, not dialled: anthropic',
  ),
  check('limit:deps-present', 'pass', 'present: node, config-load'),
  check(
    'policy:enforceability',
    'pass',
    'route=ask-user — policy offers routing, not enforcement',
  ),
];

describe('doctor groups and short forms', () => {
  it('groups by id prefix, with OTHER for anything new', () => {
    expect(doctorGroup('provider:anthropic')).toBe('providers');
    expect(doctorGroup('limit:provider-availability')).toBe('providers');
    expect(doctorGroup('dep:node')).toBe('runtime');
    expect(doctorGroup('role:planner')).toBe('roles');
    expect(doctorGroup('policy:installed')).toBe('policy');
    expect(doctorGroup('audit:sinks')).toBe('policy');
    expect(doctorGroup('limit:resources')).toBe('limits');
    expect(doctorGroup('session:overlap')).toBe('project');
    expect(doctorGroup('skills')).toBe('skills');
    expect(doctorGroup('brand-new:thing')).toBe('other');
  });

  it('shortens the noisy checks', () => {
    const byId = new Map(CHECKS.map((c) => [c.id, c]));
    const short = (id: string): string =>
      doctorShort(byId.get(id) as DoctorCheck);
    expect(short('provider:anthropic')).toBe(
      'anthropic  23 models  key from ANTHROPIC_API_KEY',
    );
    expect(short('dep:node')).toBe('node 24.13.0');
    expect(short('policy:installed')).toBe(
      'workspace-write · network none · 18 tools',
    );
    expect(short('policy:approvals')).toBe('approvals ask-user');
    expect(short('skills')).toBe('skills 0 loaded');
    expect(short('session:overlap')).toBe(
      'overlap — 5 sessions recorded against /work/repo',
    );
    expect(short('role:planner')).toBe('planner');
  });
});

describe('the grouped summary', () => {
  const plain = createCliTheme('none');

  it('renders the totals, the groups and the verbose hint', () => {
    const lines = renderDoctorGrouped(CHECKS, plain, {
      exitCode: 0,
      columns: 120,
    });
    expect(lines[0]).toBe(
      '■ kubic doctor · 19 checks · 14 ok · 5 warnings · 0 failed',
    );
    const text = lines.join('\n');
    expect(text).toContain(
      'PROVIDERS   ✓ anthropic  23 models  key from ANTHROPIC_API_KEY',
    );
    expect(text).toMatch(/^RUNTIME {5}✓ node 24\.13\.0 {3}✓ config/m);
    expect(text).toContain(
      '▲ guards are detection-only (lexical), not a sandbox',
    );
    expect(text).toContain(
      '▲ honest limits: solo no isolation · journal not backup',
    );
    expect(text).toMatch(/^ROLES {7}✓ planner {3}✓ reviewer/m);
    expect(lines.at(-1)).toBe(
      '5 warnings, nothing blocking · kubic doctor --verbose for the full report',
    );
  });

  it('shows a failure in full and says so in the footer', () => {
    const failing = [
      ...CHECKS,
      check(
        'limit:provider-availability',
        'fail',
        'provider-down: no usable provider — set a provider key',
        'provider-down',
      ),
    ];
    const lines = renderDoctorGrouped(failing, plain, {
      exitCode: 6,
      columns: 120,
    });
    expect(lines.join('\n')).toContain(
      '✕ limit:provider-availability provider-down: no usable provider — set a provider key',
    );
    expect(lines.at(-1)).toMatch(/^1 failed — fix the ✕ rows/);
  });

  it('packs passing checks to the width and never exceeds it', () => {
    const lines = renderDoctorGrouped(CHECKS, plain, {
      exitCode: 0,
      columns: 60,
    });
    for (const line of lines.slice(2, -2)) {
      expect(line.length, line).toBeLessThanOrEqual(60);
    }
  });

  it('colours marks through the theme', () => {
    const rich = createCliTheme('truecolor');
    const lines = renderDoctorGrouped(CHECKS, rich, { exitCode: 0 });
    expect(lines.join('\n')).toContain(rich.ui.fg('warn')('▲'));
    expect(lines.join('\n')).toContain(rich.ui.fg('ok')('✓'));
  });
});
