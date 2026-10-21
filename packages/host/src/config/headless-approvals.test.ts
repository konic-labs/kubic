// The headless approval keys: read from the enterprise, product and global
// layers only, the broker over https (plain http only to this machine), the
// key an absolute path.
import { describe, expect, it } from 'vitest';
import type { ApprovalsConfig, ConfigLayer, KubicConfig } from './config.js';
import { headlessApprovalsOf } from './headless-approvals.js';

function layer(
  name: ConfigLayer,
  approvals: ApprovalsConfig,
): { layer: ConfigLayer; config: KubicConfig } {
  return { layer: name, config: { approvals } };
}

describe('headlessApprovalsOf', () => {
  it('reads the broker, its token variable and the pre-approval key', () => {
    const approvals = {
      broker: 'https://approvals.example.com/kubic',
      brokerTokenEnv: 'APPROVALS_TOKEN',
      preApprovalKey: '/etc/kubic/approvals.pub',
    };
    expect(
      headlessApprovalsOf([layer('enterprise', approvals)], approvals),
    ).toEqual({
      broker: {
        url: 'https://approvals.example.com/kubic',
        tokenEnv: 'APPROVALS_TOKEN',
      },
      preApprovalKey: '/etc/kubic/approvals.pub',
    });
  });

  it('refuses a project layer that sets one, naming the file', () => {
    const approvals = { broker: 'https://evil.example/asks' };
    expect(() =>
      headlessApprovalsOf(
        [layer('project', approvals)],
        approvals,
        '/repo/.kubic/config.toml',
      ),
    ).toThrow(
      "'approvals.broker' is read from the enterprise, product and global layers only; the project layer (/repo/.kubic/config.toml) cannot set it",
    );
  });

  it('refuses plain http off this machine, a relative key and a token without a broker', () => {
    expect(() =>
      headlessApprovalsOf([], { broker: 'http://approvals.example.com' }),
    ).toThrow('must use https');
    expect(() =>
      headlessApprovalsOf([], { broker: 'http://127.0.0.1:8080/asks' }),
    ).not.toThrow();
    expect(() =>
      headlessApprovalsOf([], { preApprovalKey: 'keys/approvals.pub' }),
    ).toThrow('must be an absolute path');
    expect(() => headlessApprovalsOf([], { brokerTokenEnv: 'T' })).toThrow(
      "'approvals.broker' is not set",
    );
  });
});
