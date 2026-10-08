// Request options per model/role: parsed config tuning
// resolves to pi-durable `settings.stream`, and the lane hands it to
// the harness — the faux provider sees exactly what was configured.
import { afterEach, describe, expect, it } from 'vitest';
import { bootFauxLane, type FauxLane } from './lane/test-harness.js';
import { fauxAssistantMessage } from './pi-boundary.js';
import {
  type ModelStreamTuning,
  resolveStreamOptions,
} from './stream-options.js';

const LANES: FauxLane[] = [];

afterEach(async () => {
  for (const lane of LANES.splice(0)) {
    await lane.cleanup();
  }
});

describe('resolveStreamOptions', () => {
  it('returns undefined when nothing is tuned', () => {
    expect(resolveStreamOptions(undefined, undefined)).toBeUndefined();
    expect(resolveStreamOptions({}, {})).toBeUndefined();
  });

  it('passes the [model] tuning through', () => {
    const model: ModelStreamTuning = {
      timeoutMs: 60000,
      maxRetries: 5,
      maxRetryDelayMs: 10000,
      cacheRetention: 'long',
    };
    expect(resolveStreamOptions(model, undefined)).toEqual(model);
  });

  it('layers the role tuning over the [model] tuning per key', () => {
    expect(
      resolveStreamOptions(
        { timeoutMs: 60000, maxRetries: 5, cacheRetention: 'short' },
        { maxRetries: 1 },
      ),
    ).toEqual({ timeoutMs: 60000, maxRetries: 1, cacheRetention: 'short' });
  });

  it('a role-only tuning resolves on its own', () => {
    expect(resolveStreamOptions(undefined, { cacheRetention: 'none' })).toEqual(
      { cacheRetention: 'none' },
    );
  });
});

describe('lane stream settings', () => {
  it('configured timeoutMs/maxRetries reach the harness streamOptions', async () => {
    const seen: Array<Record<string, unknown> | undefined> = [];
    const lane = await bootFauxLane({
      settings: {
        stream: {
          timeoutMs: 60000,
          maxRetries: 5,
          maxRetryDelayMs: 10000,
          cacheRetention: 'long',
        },
      },
      responses: [
        (_context, options) => {
          seen.push({ ...(options as Record<string, unknown>) });
          return fauxAssistantMessage('ok');
        },
      ],
    });
    LANES.push(lane);
    const result = await lane.run('hi');
    expect(result.status).toBe('completed');
    expect(seen.length).toBeGreaterThan(0);
    expect(seen[0]).toMatchObject({
      timeoutMs: 60000,
      maxRetries: 5,
      maxRetryDelayMs: 10000,
      cacheRetention: 'long',
    });
  });

  it('an unset stream resolves to the provider defaults (no invented keys)', async () => {
    const seen: Array<Record<string, unknown> | undefined> = [];
    const lane = await bootFauxLane({
      settings: { stream: resolveStreamOptions(undefined, undefined) },
      responses: [
        (_context, options) => {
          seen.push({ ...(options as Record<string, unknown>) });
          return fauxAssistantMessage('ok');
        },
      ],
    });
    LANES.push(lane);
    const result = await lane.run('hi');
    expect(result.status).toBe('completed');
    expect(seen.length).toBeGreaterThan(0);
    for (const key of [
      'timeoutMs',
      'maxRetries',
      'maxRetryDelayMs',
      'cacheRetention',
    ]) {
      expect(seen[0]).not.toHaveProperty(key);
    }
  });
});
