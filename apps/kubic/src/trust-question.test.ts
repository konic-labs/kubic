// The project-trust question, restyled (issue #462; docs/ui 05-C): one row
// with the full disclosure, one key to answer, and `v` showing the file.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createCliTheme } from '../../../packages/core/src/cli/theme.js';
import { ProjectTrustStore } from '../../../packages/host/src/config/trust-store.js';
import { resolveInteractiveProjectTrust } from './config-runtime.js';
import {
  TRUST_VIEW_MAX_LINES,
  trustFileLines,
  trustQuestionLines,
} from './trust-question.js';

const plain = createCliTheme('none');
const made: string[] = [];

afterEach(() => {
  for (const dir of made.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

function tmp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  made.push(dir);
  return dir;
}

describe('the trust question (issue #462)', () => {
  it('is one row in the first screen language with the full disclosure', () => {
    const lines = trustQuestionLines(
      plain,
      {
        root: '/home/me/proj',
        configPath: '/home/me/proj/.kubic/config.toml',
        message: 'Trust project /home/me/proj?',
      },
      100,
      '/home/me',
    );
    expect(lines[0]).toBe(
      '  ◆ trust        ~/proj/.kubic/config.toml found — load project config?',
    );
    const body = lines.join('\n').replace(/\s+/gu, ' ');
    expect(body).toContain(
      'sets the model, approvals, permissions and journal retention',
    );
    expect(body).toContain(
      'any *_API_KEY or KUBIC_* variable it names (KUBIC_API_KEY by default)',
    );
    expect(body).toContain(
      'project skills and role documents are instructions the model follows',
    );
    expect(lines.at(-1)?.trim()).toBe('y  yes   n  not now   v  view file');
    for (const line of lines) expect(line.length).toBeLessThanOrEqual(100);
  });

  it('shows the file without its escapes, bounded', () => {
    const dir = tmp('trust-view-');
    const path = join(dir, 'config.toml');
    writeFileSync(
      path,
      [
        `model = "x\u001b[2J"`,
        ...Array.from({ length: 49 }, (_, i) => `# ${i}`),
      ].join('\n'),
    );
    const lines = trustFileLines(plain, path);
    const text = lines.join('\n');
    expect(text).toContain('│ model = "x[2J"');
    expect(text).not.toContain('\u001b');
    expect(lines.filter((line) => line.includes('│ '))).toHaveLength(
      TRUST_VIEW_MAX_LINES,
    );
    expect(text).toContain('… 10 more lines');
  });

  it('records yes, shows the file on view and records nothing for not now', async () => {
    const home = tmp('trust-home-');
    const project = tmp('trust-proj-');
    mkdirSync(join(project, '.kubic'), { recursive: true });
    writeFileSync(join(project, '.kubic', 'config.toml'), '[journal]\n');
    const store = new ProjectTrustStore(join(home, '.kubic', 'trust.json'));
    const shown: string[] = [];
    const answers: Array<'yes' | 'not-now' | 'view'> = ['view', 'not-now'];
    expect(
      await resolveInteractiveProjectTrust({
        home,
        cwd: project,
        env: {},
        store,
        ask: async () => answers.shift() ?? null,
        show: (path) => shown.push(path),
      }),
    ).toBe(false);
    expect(shown).toEqual([join(project, '.kubic', 'config.toml')]);
    // Not now leaves no decision: the next launch asks again.
    expect(store.get(project) ?? null).toBeNull();
    expect(
      await resolveInteractiveProjectTrust({
        home,
        cwd: project,
        env: {},
        store,
        ask: async () => 'yes',
      }),
    ).toBe(true);
    expect(store.get(project)).toBe(true);
  });
});
