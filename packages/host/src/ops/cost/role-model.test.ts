// (1) per-role model selection hook (issue #56): RED first.
import { describe, expect, it } from 'vitest';
import { selectRoleModel } from './role-model.js';

const TABLE = {
  planner: { provider: 'cheap', id: 'small' },
  implementer: { provider: 'pro', id: 'large' },
};

describe('per-role model selection (issue #56)', () => {
  it('uses the role default when nothing explicit is given', () => {
    const sel = selectRoleModel('planner', { roleTable: TABLE });
    expect(sel.provider).toBe('cheap');
    expect(sel.id).toBe('small');
    expect(sel.origin).toBe('role-default');
  });

  it('explicit selection beats the role default and is logged explicitly', () => {
    const sel = selectRoleModel('planner', {
      roleTable: TABLE,
      explicit: { provider: 'pro', id: 'large' },
    });
    expect(sel.provider).toBe('pro');
    expect(sel.origin).toBe('explicit');
    expect(sel.log).toMatch(/explicit/);
    expect(sel.log).toMatch(/planner/);
  });

  it('refuses an unknown role instead of hidden-routing it', () => {
    expect(() => selectRoleModel('ghost', { roleTable: TABLE })).toThrow(
      /unknown role/,
    );
  });
});
