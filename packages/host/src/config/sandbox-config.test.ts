// `[sandbox]`: the strictest mode any layer sets wins; `writable` comes from
// the user's layers and above only.
import { describe, expect, it } from 'vitest';
import type { ConfigLayer, KubicConfig } from './config.js';
import { sandboxOf } from './sandbox-config.js';

function layer(
  name: ConfigLayer,
  sandbox: NonNullable<KubicConfig['sandbox']>,
): { layer: ConfigLayer; config: KubicConfig } {
  return { layer: name, config: { sandbox } };
}

describe('sandboxOf', () => {
  it('is off by default, and the strictest mode wins', () => {
    expect(sandboxOf([], undefined, '/home/u')).toEqual({
      mode: 'off',
      writable: [],
    });
    expect(
      sandboxOf(
        [
          layer('enterprise', { mode: 'auto' }),
          layer('project', { mode: 'required' }),
          layer('global', { mode: 'off', writable: ['~/.npm'] }),
        ],
        undefined,
        '/home/u',
      ),
    ).toEqual({
      mode: 'required',
      modeLayer: 'project',
      writable: ['/home/u/.npm'],
    });
  });

  it('refuses a project that widens what a command may write, and an unknown mode', () => {
    expect(() =>
      sandboxOf(
        [layer('project', { writable: ['/'] })],
        '/repo/.kubic/config.toml',
      ),
    ).toThrow('cannot widen what a sandboxed command may write');
    expect(() => sandboxOf([layer('global', { mode: 'strict' })])).toThrow(
      "'sandbox.mode' must be one of off, auto, required",
    );
  });
});
