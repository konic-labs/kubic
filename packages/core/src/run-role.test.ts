import { describe, expect, it } from 'vitest';
import { visibleWidth } from './cli/width.js';
import {
  DEFAULT_RUN_ROLE,
  RUN_ROLE_COLUMNS,
  runRoleLabel,
} from './run-role.js';

describe('runRoleLabel', () => {
  it('names a run without --role as the default role', () => {
    expect(DEFAULT_RUN_ROLE).toBe('default');
    expect(runRoleLabel(undefined)).toBe('default');
  });

  it('names the selected role as it was given', () => {
    expect(runRoleLabel('reviewer')).toBe('reviewer');
    const fits = 'a'.repeat(RUN_ROLE_COLUMNS);
    expect(runRoleLabel(fits)).toBe(fits);
  });

  it('cuts a longer name to the role column with a trailing ellipsis', () => {
    const label = runRoleLabel('a'.repeat(RUN_ROLE_COLUMNS + 1));
    expect(label).toBe(`${'a'.repeat(RUN_ROLE_COLUMNS - 1)}…`);
    expect(visibleWidth(label)).toBe(RUN_ROLE_COLUMNS);
  });
});
