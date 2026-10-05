// Slice B: model selection, one-way escalation, thinking clamp
// (issue #20; §38).
// RED: selectModel/escalateModel/clampThinking do not exist yet.
import { describe, expect, it } from 'vitest';
import {
  clampThinking,
  type EscalationLadder,
  escalateModel,
  selectModel,
  supportedThinking,
} from './model-select.js';
import { createModels, fauxProvider } from './pi-boundary.js';

function modelsWithFaux(): ReturnType<typeof createModels> {
  const models = createModels();
  models.setProvider(fauxProvider().provider);
  return models;
}

describe('model selection + escalation + thinking (issue #20, slice B)', () => {
  it('selects explicit provider/id and fails named when unknown', () => {
    const models = modelsWithFaux();
    const fauxId = models.getModels('faux')[0]?.id ?? 'faux-model';
    const picked = selectModel(models, { provider: 'faux', id: fauxId });
    expect(picked.id).toBe(fauxId);
    expect(() => selectModel(models, { provider: 'nope', id: 'x' })).toThrow(
      /unknown provider/,
    );
    expect(() => selectModel(models, { provider: 'faux', id: 'nope' })).toThrow(
      /unknown model/,
    );
  });

  it('falls back to config default, then first available', () => {
    const models = modelsWithFaux();
    const fauxId = models.getModels('faux')[0]?.id ?? 'faux-model';
    expect(
      selectModel(models, undefined, { provider: 'faux', id: fauxId }).id,
    ).toBe(fauxId);
    const first = selectModel(models, undefined);
    expect(first.provider).toBe('faux');
  });

  it('escalation is one-way, recorded, and bounded', () => {
    const ladder: EscalationLadder = {
      steps: ['local/llama3', 'faux/big'],
      maxEscalations: 2,
      record: [],
    };
    const first = escalateModel(
      ladder,
      'local/llama3',
      'faux/big',
      'needs more',
    );
    expect(first.to).toBe('faux/big');
    expect(ladder.record).toHaveLength(1);
    expect(() =>
      escalateModel(ladder, 'faux/big', 'local/llama3', 'cheaper'),
    ).toThrow(/one-way/);
    escalateModel(ladder, 'faux/big', 'faux/big', 'retry');
    expect(() =>
      escalateModel(ladder, 'faux/big', 'faux/big', 'again'),
    ).toThrow(/bounded/);
  });

  // Issue #216: the thinking.json sidecar (save/loadThinkingLevel) is
  // deleted — the level persists as durable agent state through
  // `configure()` + `pi.agent` (issue #225: solo.test.ts pins it across
  // close and reopen), so attach restores it from the storage and no
  // sidecar read exists to test here.
  it('thinking clamps to model support', () => {
    const models = modelsWithFaux();
    const model = selectModel(models, undefined);
    const levels = supportedThinking(models, model);
    expect(Array.isArray(levels)).toBe(true);
    const clamped = clampThinking(models, model, 'max');
    expect(levels.includes(clamped)).toBe(true);
  });
});
