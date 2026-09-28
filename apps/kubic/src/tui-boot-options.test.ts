// The deps→boot-options projection of `kubic tui` (issue #227). The prod
// runner hands `tuiDepsWithDefaults` the config projections and commander's
// parity flags; this pins what reaches `bootTuiLane` — including the model
// pin — without opening a terminal.
import { describe, expect, it } from 'vitest';
import { tuiBootOptions, tuiDepsWithDefaults } from './tui-run.js';

describe('tuiBootOptions (issue #227)', () => {
  it('forwards the model pin and every config projection', () => {
    const options = tuiBootOptions(
      {
        out: () => {},
        model: { provider: 'alt', id: 'm1' },
        policySource: 'config',
        journalRetention: { maxAgeMs: 1000 },
        reconcileOutOfScope: ['dist'],
      },
      undefined,
      undefined,
    );
    expect(options.model).toEqual({ provider: 'alt', id: 'm1' });
    expect(options.policySource).toBe('config');
    expect(options.journalRetention).toEqual({ maxAgeMs: 1000 });
    expect(options.reconcileOutOfScope).toEqual(['dist']);
  });

  it('omits the model when no pin is configured', () => {
    const options = tuiBootOptions({ out: () => {} }, undefined, undefined);
    expect(options).toEqual({});
    expect('model' in options).toBe(false);
  });

  it('forwards the answer seat and the parsed parity flags', () => {
    const answer = async () => undefined;
    const options = tuiBootOptions(
      { out: () => {} },
      {
        role: 'reviewer',
        noSkills: true,
        skillsList: ['/a.md'],
      },
      answer,
    );
    expect(options.answer).toBe(answer);
    expect(options.role).toBe('reviewer');
    expect(options.noSkills).toBe(true);
    expect(options.skillsList).toEqual(['/a.md']);
    // An empty skills list is the flag's absent form, not an explicit [].
    expect(
      tuiBootOptions({ out: () => {} }, { skillsList: [] }, undefined),
    ).toEqual({});
  });
});

describe('tuiDepsWithDefaults (issue #227)', () => {
  it('keeps the channels and adds the terminal + boot seams', () => {
    const out = () => {};
    const err = () => {};
    const deps = tuiDepsWithDefaults({ out, err });
    expect(deps.out).toBe(out);
    expect(deps.err).toBe(err);
    expect(typeof deps.createTerminal).toBe('function');
    expect(typeof deps.bootLane).toBe('function');
    expect('err' in tuiDepsWithDefaults({ out })).toBe(false);
  });
});
