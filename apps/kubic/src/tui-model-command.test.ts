// The `/model` parser of the interactive loop (issue #227; §38.1). The
// submit path routes on these three outcomes, so what counts as a command —
// and what is still a prompt for the lane — is pinned here, not inferred
// from the prod test.
import { describe, expect, it } from 'vitest';
import { parseModelCommand } from './tui-run.js';

describe('parseModelCommand (issue #227)', () => {
  it('reads the report and switch forms', () => {
    expect(parseModelCommand('/model')).toEqual({ kind: 'report' });
    expect(parseModelCommand('/model   ')).toEqual({ kind: 'report' });
    expect(parseModelCommand('/model alt/m1')).toEqual({
      kind: 'switch',
      selection: { provider: 'alt', id: 'm1' },
    });
  });

  it('refuses a malformed argument by name', () => {
    expect(parseModelCommand('/model nope')).toEqual({
      kind: 'invalid',
      message: '--model must be \'provider/id\' (got "nope")',
    });
  });

  it('leaves prompts — including /model lookalikes — to the lane', () => {
    expect(parseModelCommand('hello')).toBeUndefined();
    expect(parseModelCommand('/models')).toBeUndefined();
    expect(parseModelCommand('/model=alt/m1')).toBeUndefined();
  });
});
