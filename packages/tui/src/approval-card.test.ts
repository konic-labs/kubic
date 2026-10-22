// The inline approval card. Pure
// renders at depth none read like the design.

import { createUiTheme } from '@kubic/core/ui/style';
import { DARK_PALETTE } from '@kubic/core/ui/tokens';
import { describe, expect, it } from 'vitest';
import {
  type ApprovalCardOptions,
  approvalReason,
  renderApprovalCard,
} from './approval-card.js';
import { APPROVAL_DEFAULT_KEYS } from './approval-view.js';
import { visibleWidth } from './tui-boundary.js';

const plain = createUiTheme(DARK_PALETTE, 'none');
const rich = createUiTheme(DARK_PALETTE, 'truecolor');

const base: ApprovalCardOptions = {
  armed: true,
  allowable: true,
  keys: APPROVAL_DEFAULT_KEYS,
  commandPage: 0,
  position: 1,
  total: 1,
  explain: false,
  cwd: '~/Desktop/kubic-playground',
  pageKey: 'v',
  explainKey: '?',
};

const shell = {
  key: 'k1',
  capability: 'destructive-shell',
  toolName: 'bash',
  command: 'rm -rf dist && npm run build',
  summary: 'destructive-shell: rm -rf dist && npm run build',
  justification: 'the build output is stale',
};

describe('approval card', () => {
  it('frames a shell ask with its command, reason, cwd and keys', () => {
    const lines = renderApprovalCard(plain, shell, 100, base);
    expect(lines[0]?.startsWith(' ┏━ [APPROVAL] ━ bash ━')).toBe(true);
    expect(lines[0]?.endsWith(' 1 of 1 ━━')).toBe(true);
    expect(lines).toContain(' ┃   $ rm -rf dist && npm run build');
    expect(lines).toContain(
      ' ┃   ▲ destructive   it can delete or overwrite files',
    );
    expect(lines).toContain(' ┃   ○ cwd           ~/Desktop/kubic-playground');
    const keys = lines.find((line) => line.includes('allow once')) ?? '';
    // `c` joins the keys; at 100 columns `esc = deny` takes its
    // own row.
    expect(keys).toMatch(
      /a {2}allow once {4}\^S {2}allow for session {4}d {2}deny {4}c {2}deny \+ comment {4}\? {2}explain$/,
    );
    expect(lines).toContain(' ┃   esc = deny ');
    expect(lines.at(-1)?.startsWith(' ┗━━')).toBe(true);
    for (const line of lines)
      expect(visibleWidth(line)).toBeLessThanOrEqual(100);
  });

  it('paints the warn frame, warnBg body and bold destructive words', () => {
    const lines = renderApprovalCard(rich, shell, 100, base);
    expect(lines[0]).toContain(rich.fg('warn')('┏━ '));
    expect(lines[0]).toContain(
      rich.style({ fg: 'warn', inverse: true, bold: true })(' APPROVAL '),
    );
    const command = lines.find((line) => line.includes('npm run build')) ?? '';
    expect(command).toContain(rich.open({ bg: 'warnBg' }));
    expect(command).toContain(rich.style({ fg: 'warn', bold: true })('rm -rf'));
  });

  it('opens the explanation on ? and names the next ask', () => {
    const lines = renderApprovalCard(plain, shell, 100, {
      ...base,
      explain: true,
      total: 2,
      next: {
        key: 'k2',
        capability: 'network',
        toolName: 'bash',
        command: 'npm install',
      },
    });
    expect(lines).toContain(' ┃   ℹ why           the build output is stale');
    expect(lines).toContain(' ┃   next: bash npm install');
    expect(lines[0]).toContain(' 1 of 2 ━━');
  });

  it('pages a long command and offers the page key', () => {
    const command = Array.from(
      { length: 20 },
      (_, i) => `echo line ${i + 1}`,
    ).join('\n');
    const first = renderApprovalCard(plain, { ...shell, command }, 100, base);
    expect(first).toContain(' ┃   … lines 1–8 of 20');
    expect(first.find((line) => line.includes('next page'))).toBeDefined();
    const third = renderApprovalCard(plain, { ...shell, command }, 100, {
      ...base,
      commandPage: 2,
    });
    expect(third).toContain(' ┃   … lines 17–20 of 20');
  });

  it('shows an edit preview with its counts instead of a command', () => {
    const lines = renderApprovalCard(
      plain,
      {
        key: 'k3',
        capability: 'outside-write',
        toolName: 'edit',
        paths: ['../shared/cart.js'],
        preview: {
          kind: 'diff',
          text: ' 20   return cart;\n 21 }\n+22 \n+23 export function clear(cart) {',
          firstChangedLine: 22,
          added: 2,
          removed: 0,
          truncated: false,
        },
      },
      100,
      base,
    );
    expect(lines[0]).toContain('[APPROVAL] ━ edit +2 −0');
    expect(lines).toContain(' ┃   23 + export function clear(cart) {');
    expect(lines.find((line) => line.includes('full diff'))).toBeDefined();
    expect(lines.join('\n')).toContain('the journal keeps the old file');
  });

  it('says so while the keys arm, and when the terminal is too short', () => {
    const arming = renderApprovalCard(plain, shell, 100, {
      ...base,
      armed: false,
    });
    expect(arming.join('\n')).toContain('… keys unlock in a moment');
    expect(arming.join('\n')).not.toContain('allow once');
    const short = renderApprovalCard(plain, shell, 100, {
      ...base,
      allowable: false,
    });
    expect(short.join('\n')).toContain('too short to show this command');
    expect(short.join('\n')).not.toContain('allow once');
  });

  it('keeps labels only and wraps the keys on a narrow terminal', () => {
    const lines = renderApprovalCard(plain, shell, 50, base);
    for (const line of lines)
      expect(visibleWidth(line)).toBeLessThanOrEqual(50);
    const trimmed = lines.map((line) => line.trimEnd());
    expect(trimmed).toContain(' ┃   ▲ destructive');
    expect(trimmed).toContain(' ┃   esc = deny');
    // Every key is whole: the row wraps instead of cutting a key off.
    const doc = trimmed.join('\n');
    for (const hint of [
      'a  allow once',
      '^S  allow for session',
      'd  deny',
      '?  explain',
    ]) {
      expect(doc).toContain(hint);
    }
    expect(doc).not.toContain('…');
  });

  it('wraps the keys wherever one row cannot hold them', () => {
    const long = { ...shell, command: Array(20).fill('step').join('\n') };
    for (const width of [50, 64, 80]) {
      const lines = renderApprovalCard(plain, long, width, base);
      for (const line of lines) {
        expect(visibleWidth(line)).toBeLessThanOrEqual(width);
      }
      const doc = lines.join('\n');
      for (const hint of ['d  deny', 'v  next page', '?  explain']) {
        expect(doc).toContain(hint);
      }
    }
    // A terminal too short to allow still shows the one key that acts.
    const short = renderApprovalCard(plain, shell, 50, {
      ...base,
      allowable: false,
    }).join('\n');
    expect(short).toContain('d  deny');
    expect(short).toContain('enlarge it');
  });

  it('maps capabilities to plain reasons, unknown ones to their name', () => {
    expect(approvalReason('network')).toEqual([
      'network',
      'it can reach the network',
    ]);
    expect(approvalReason('custom-thing')).toEqual(['custom-thing', '']);
  });
});
