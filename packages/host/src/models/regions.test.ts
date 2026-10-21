// Where a provider runs and the allowed_regions gate: read from the
// environment for Bedrock and Vertex, `local` for the testing provider and a
// provider on this machine, declared for the rest; unknown or unlisted is
// refused, with the reason.
import { describe, expect, it } from 'vitest';
import type { EffectivePolicy } from '../policy/index.js';
import {
  providerRegion,
  type RegionContext,
  regionMatches,
  regionRefusal,
} from './regions.js';

function ctx(over: Partial<RegionContext> = {}): RegionContext {
  return { env: {}, home: '/nonexistent-home', declared: {}, ...over };
}

function policy(regions: string[] | undefined): EffectivePolicy {
  return { models: { regions } } as unknown as EffectivePolicy;
}

describe('providerRegion', () => {
  it('reads Bedrock and Vertex from the environment', () => {
    expect(
      providerRegion(
        'amazon-bedrock',
        ctx({ env: { AWS_REGION: 'eu-west-1' } }),
      ),
    ).toBe('eu-west-1');
    expect(
      providerRegion(
        'google-vertex',
        ctx({ env: { GOOGLE_CLOUD_LOCATION: 'europe-west4' } }),
      ),
    ).toBe('europe-west4');
    // A declaration never overrides the region a request actually goes to.
    expect(
      providerRegion(
        'amazon-bedrock',
        ctx({
          env: { AWS_REGION: 'us-east-1' },
          declared: { 'amazon-bedrock': 'eu-west-1' },
        }),
      ),
    ).toBe('us-east-1');
  });

  it('is local for the testing provider and a provider on this machine', () => {
    expect(providerRegion('faux', ctx())).toBe('local');
    expect(
      providerRegion(
        'ollama',
        ctx({ baseUrlOf: () => 'http://127.0.0.1:11434/v1' }),
      ),
    ).toBe('local');
  });

  it('takes a declared region, and knows none otherwise', () => {
    expect(
      providerRegion(
        'azure-openai-responses',
        ctx({ declared: { 'azure-openai-responses': 'westeurope' } }),
      ),
    ).toBe('westeurope');
    expect(providerRegion('anthropic', ctx())).toBeUndefined();
  });
});

describe('regionRefusal', () => {
  it('allows a listed region, by id or glob', () => {
    expect(regionMatches('eu-*', 'eu-west-1')).toBe(true);
    expect(regionMatches('EU-*', 'eu-central-1')).toBe(true);
    expect(regionMatches('westeurope', 'westeurope')).toBe(true);
    expect(regionMatches('eu-*', 'us-east-1')).toBe(false);
    expect(
      regionRefusal(
        policy(['eu-*']),
        'amazon-bedrock',
        ctx({ env: { AWS_REGION: 'eu-west-1' } }),
      ),
    ).toBeUndefined();
  });

  it('refuses an unlisted and an unknown region, naming the fix', () => {
    expect(
      regionRefusal(
        policy(['eu-*']),
        'amazon-bedrock',
        ctx({ env: { AWS_REGION: 'us-east-1' } }),
      ),
    ).toBe(
      "provider 'amazon-bedrock' runs in us-east-1, outside [policy] allowed_regions (eu-*)",
    );
    expect(regionRefusal(policy(['eu-*']), 'anthropic', ctx())).toContain(
      'has no known region, and [policy] allowed_regions allows only eu-* (the managed config declares it with [providers.anthropic] region)',
    );
  });

  it('gates nothing when no region is listed', () => {
    expect(
      regionRefusal(policy(undefined), 'anthropic', ctx()),
    ).toBeUndefined();
  });
});
