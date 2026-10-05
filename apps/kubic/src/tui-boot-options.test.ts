// The deps→boot-options projection of `kubic tui` (issue #227). The prod
// runner hands `tuiDepsWithDefaults` the config projections and commander's
// parity flags; this pins what reaches `bootTuiLane` — including the model
// pin — without opening a terminal.
import { describe, expect, it } from 'vitest';
import { resolveEffectivePolicy } from '../../../packages/host/src/policy/enterprise.js';
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

  it('forwards the §58 enterprise policy the run path gates with (issue #288)', () => {
    const modelPolicy = resolveEffectivePolicy([
      { layer: 'enterprise', policy: { models: { allowed: ['faux/*'] } } },
    ]).policy;
    const options = tuiBootOptions(
      { out: () => {}, modelPolicy },
      undefined,
      undefined,
    );
    expect(options.modelPolicy).toBe(modelPolicy);
    // Absent means absent: no key, so the boot gates nothing.
    expect(
      'modelPolicy' in tuiBootOptions({ out: () => {} }, undefined, undefined),
    ).toBe(false);
  });

  it('forwards the session compaction projection (issue #239)', () => {
    const options = tuiBootOptions(
      {
        out: () => {},
        compaction: { enabled: false, reserveTokens: 4000 },
      },
      undefined,
      undefined,
    );
    expect(options.compaction).toEqual({
      enabled: false,
      reserveTokens: 4000,
    });
    // Absent means absent: the lane defaults apply, never an invented value.
    expect(
      'compaction' in tuiBootOptions({ out: () => {} }, undefined, undefined),
    ).toBe(false);
  });

  it('forwards the system prompt file section (issue #240)', () => {
    const options = tuiBootOptions(
      { out: () => {}, systemPromptSection: 'Be terse.' },
      undefined,
      undefined,
    );
    expect(options.systemPromptSection).toBe('Be terse.');
    expect(
      'systemPromptSection' in
        tuiBootOptions({ out: () => {} }, undefined, undefined),
    ).toBe(false);
  });

  it('forwards the roles projection with the global home (issue #241)', () => {
    // The TUI resolves `--role` through the same global `~/.kubic/roles`
    // layer as `kubic run`: the projection must carry the home directory
    // or the boot's global documents silently vanish.
    const roles = {
      layers: [],
      trustProject: () => true,
      homeDir: '/home/ada',
    };
    const options = tuiBootOptions(
      { out: () => {}, roles },
      undefined,
      undefined,
    );
    expect(options.roles).toBe(roles);
    expect(options.roles?.homeDir).toBe('/home/ada');
    // Absent means absent: no key, so the boot resolves no global source.
    expect(
      'roles' in tuiBootOptions({ out: () => {} }, undefined, undefined),
    ).toBe(false);
  });

  it('omits the model when no pin is configured', () => {
    const options = tuiBootOptions({ out: () => {} }, undefined, undefined);
    expect(options).toEqual({});
    expect('model' in options).toBe(false);
  });

  it('forwards the effective thinking level with its source (issue #225)', () => {
    const options = tuiBootOptions(
      { out: () => {}, thinking: { level: 'high', source: 'cli' } },
      undefined,
      undefined,
    );
    expect(options.thinking).toEqual({ level: 'high', source: 'cli' });
    // Absent means absent: no key, so the boot resolves the session
    // record, the role default, or Pi's default instead.
    expect(
      'thinking' in tuiBootOptions({ out: () => {} }, undefined, undefined),
    ).toBe(false);
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
