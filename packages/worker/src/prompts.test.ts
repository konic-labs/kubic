// Cache-preserving prompts + model affinity.
import { describe, expect, it, vi } from 'vitest';
import type { EscalationLadder } from './model-select.js';

describe('prompt assembly byte-stability', () => {
  it('identical turns assemble byte-identical prompts despite shuffled inputs', async () => {
    const { assembleSystemPrompt } = await import('./prompts.js');
    const a = assembleSystemPrompt({
      role: 'coding agent',
      cwd: '/repo',
      toolNames: ['bash', 'read', 'edit'],
      metadata: { model: 'faux-1', thinking: 'low' },
    });
    const b = assembleSystemPrompt({
      role: 'coding agent',
      cwd: '/repo',
      toolNames: ['edit', 'bash', 'read'],
      metadata: { thinking: 'low', model: 'faux-1' },
    });
    expect(b).toBe(a);
  });

  it('tool order and metadata keys are canonically sorted', async () => {
    const { assembleSystemPrompt } = await import('./prompts.js');
    const prompt = assembleSystemPrompt({
      role: 'r',
      cwd: '/w',
      toolNames: ['write', 'bash', 'read'],
      metadata: { z: '1', a: '2' },
    });
    const toolsLine = prompt.split('\n').find((l) => l.startsWith('tools:'));
    const metaLine = prompt.split('\n').find((l) => l.startsWith('meta:'));
    expect(toolsLine).toBe('tools: bash,read,write');
    expect(metaLine).toBe('meta: a=2,z=1');
  });
});

describe('model affinity', () => {
  it('N turns resolve to 1 pinned model id; mixed ids are rejected', async () => {
    const { assertSingleModelId, pinModelForTask, taskModelForTurn } =
      await import('./prompts.js');
    const affinity = pinModelForTask('task-1', 'faux/a');
    expect(taskModelForTurn(affinity)).toBe('faux/a');
    expect(taskModelForTurn(affinity)).toBe('faux/a');
    expect(assertSingleModelId(['faux/a', 'faux/a', 'faux/a'])).toBe('faux/a');
    expect(() => assertSingleModelId(['faux/a', 'faux/b'])).toThrow(
      /re-select/,
    );
  });

  it('escalation is explicit, recorded, one-way, and emits an event', async () => {
    const { escalatePinnedModel, pinModelForTask } = await import(
      './prompts.js'
    );
    const ladder: EscalationLadder = {
      steps: ['faux/a', 'faux/b'],
      maxEscalations: 2,
      record: [],
    };
    const sink = vi.fn();
    const { affinity, event } = escalatePinnedModel(
      pinModelForTask('task-1', 'faux/a'),
      ladder,
      'faux/b',
      'needs more',
      sink,
    );
    expect(event).toMatchObject({
      type: 'model-escalation',
      taskId: 'task-1',
      from: 'faux/a',
      to: 'faux/b',
      reason: 'needs more',
    });
    expect(sink).toHaveBeenCalledTimes(1);
    expect(sink).toHaveBeenCalledWith(event);
    expect(affinity.modelId).toBe('faux/b');
    expect(affinity.escalations).toHaveLength(1);
    expect(() =>
      escalatePinnedModel(affinity, ladder, 'faux/a', 'cheaper'),
    ).toThrow(/one-way/);
  });
});

describe('compaction routing', () => {
  it('compaction carries fresh ids with cache writes disabled', async () => {
    const { buildCompactionRoute } = await import('./prompts.js');
    const route = buildCompactionRoute('session-1', 'session-9');
    expect(route.routingId).toBe('session-9');
    expect(route.cacheRetention).toBe('none');
    expect(route.cacheWriteEnabled).toBe(false);
    expect(() => buildCompactionRoute('session-1', 'session-1')).toThrow(
      /fresh/,
    );
  });
});

describe('cache hit/miss observability', () => {
  it('hit-rate is visible per session', async () => {
    const { SessionCacheStats } = await import('./prompts.js');
    const stats = new SessionCacheStats();
    expect(stats.hitRate('s1')).toBe(null);
    stats.record('s1', { cacheRead: 100, cacheWrite: 10 });
    stats.record('s1', { cacheRead: 50, cacheWrite: 0 });
    stats.record('s1', { cacheRead: 0, cacheWrite: 40 });
    expect(stats.hitRate('s1')).toBeCloseTo(2 / 3, 5);
    expect(stats.format('s1')).toContain('67%');
  });
});
