// The first-run rule for a bare `kubic`.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { globalConfigPath, needsFirstRunSetup } from './setup-prod.js';

describe('needsFirstRunSetup', () => {
  const made: string[] = [];
  afterEach(() => {
    for (const dir of made.splice(0))
      rmSync(dir, { recursive: true, force: true });
  });
  function home(withConfig: boolean): string {
    const dir = mkdtempSync(join(tmpdir(), 'first-run-'));
    made.push(dir);
    if (withConfig) {
      mkdirSync(join(dir, '.kubic'));
      writeFileSync(globalConfigPath(dir), '# set up\n');
    }
    return dir;
  }

  it('asks only without a global config and without a pinned model', () => {
    expect(needsFirstRunSetup({}, home(false))).toBe(true);
    expect(needsFirstRunSetup({}, home(true))).toBe(false);
    expect(needsFirstRunSetup({ KUBIC_MODEL: 'a/b' }, home(false))).toBe(false);
    expect(needsFirstRunSetup({ KUBIC_PROVIDER: 'faux' }, home(false))).toBe(
      false,
    );
    expect(needsFirstRunSetup({ KUBIC_SKIP_SETUP: '1' }, home(false))).toBe(
      false,
    );
  });
});
