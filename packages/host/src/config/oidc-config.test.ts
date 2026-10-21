// `[oidc]` is read from the enterprise, product and global layers only, and
// names a token source and at least one cloud to use it for.
import { describe, expect, it } from 'vitest';
import type { ConfigLayer, KubicConfig } from './config.js';
import { oidcOf } from './oidc-config.js';

function layer(
  name: ConfigLayer,
  oidc: NonNullable<KubicConfig['oidc']>,
): { layer: ConfigLayer; config: KubicConfig } {
  return { layer: name, config: { oidc } };
}

describe('oidcOf', () => {
  it('reads the token source and the clouds', () => {
    const oidc = {
      provider: 'github',
      awsRoleArn: 'arn:aws:iam::1:role/ci',
    };
    expect(oidcOf([layer('enterprise', oidc)], { oidc })).toEqual(oidc);
  });

  it('refuses a project layer that sets it', () => {
    const oidc = { provider: 'github', gatewayAudience: 'https://evil' };
    expect(() =>
      oidcOf([layer('project', oidc)], { oidc }, '/repo/.kubic/config.toml'),
    ).toThrow(
      "'oidc.provider' is read from the enterprise, product and global layers only; the project layer (/repo/.kubic/config.toml) cannot set it",
    );
  });

  it('refuses a source it does not know, a variable source without its variable, and no cloud', () => {
    expect(() =>
      oidcOf([], { oidc: { provider: 'circle', awsRoleArn: 'a' } }),
    ).toThrow('must be "github" or "env"');
    expect(() =>
      oidcOf([], { oidc: { provider: 'env', awsRoleArn: 'a' } }),
    ).toThrow("needs 'oidc.tokenEnv'");
    expect(() => oidcOf([], { oidc: { provider: 'github' } })).toThrow(
      'names no cloud',
    );
  });
});
