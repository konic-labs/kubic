// The `/model` parser of the interactive loop (issue #227; §38.1). The
// submit path routes on these three outcomes, so what counts as a command —
// and what is still a prompt for the lane — is pinned here, not inferred
// from the prod test.
import { describe, expect, it } from 'vitest';
import type { TuiApp } from '../../../packages/tui/src/tui-app.js';
import { BACKGROUND_CONTEXT } from '../../../packages/worker/src/pi-boundary.js';
import {
  parseModelCommand,
  type TuiLaneLoop,
  TuiTurnRunner,
} from './tui-run.js';

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

describe('TuiTurnRunner model switch (issue #227)', () => {
  it('refuses a switch when the boot has no live lane', async () => {
    const runner = new TuiTurnRunner(
      { setModel: () => {} } as unknown as TuiApp,
      { context: BACKGROUND_CONTEXT } as unknown as TuiLaneLoop,
      'faux/big',
    );
    expect(runner.modelRef).toBe('faux/big');
    await expect(
      runner.switchModel({ provider: 'alt', id: 'm1' }),
    ).rejects.toThrow('this session has no live lane to switch');
  });
});
