// Model selection, one-way escalation, thinking clamp.
import { describe, expect, it } from 'vitest';
import {
  clampThinking,
  type EscalationLadder,
  escalateModel,
  parseThinkingFlag,
  resolveThinkingLevel,
  selectModel,
  supportedThinking,
} from './model-select.js';
import { createModels, fauxProvider } from './pi-boundary.js';

function modelsWithFaux(): ReturnType<typeof createModels> {
  const models = createModels();
  models.setProvider(fauxProvider().provider);
  return models;
}

describe('model selection + escalation + thinking', () => {
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

  it('names the closest provider and model when one is near', () => {
    const models = modelsWithFaux();
    const fauxId = models.getModels('faux')[0]?.id ?? 'faux-model';
    expect(() => selectModel(models, { provider: 'fuax', id: fauxId })).toThrow(
      /unknown provider 'fuax' \(--model\); did you mean 'faux'\?/,
    );
    const typo = `${fauxId.slice(0, -1)}${fauxId.endsWith('x') ? 'y' : 'x'}`;
    expect(() => selectModel(models, { provider: 'faux', id: typo })).toThrow(
      new RegExp(`did you mean '${fauxId}'\\?`),
    );
    expect(() =>
      selectModel(models, { provider: 'faux', id: 'zzzzzzzzzzzzzz' }),
    ).toThrow(/unknown model 'zzzzzzzzzzzzzz' on provider 'faux' \(--model\)$/);
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

  // The thinking.json sidecar (save/loadThinkingLevel) is
  // deleted — the level persists as durable agent state through
  // `configure()` + `pi.agent` (boot.test.ts pins it across
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

describe('thinking level resolution at lane boot', () => {
  function reasoningModel() {
    const models = createModels();
    const faux = fauxProvider({
      provider: 'think',
      models: [{ id: 'deep', reasoning: true }],
    });
    models.setProvider(faux.provider);
    return selectModel(models, { provider: 'think', id: 'deep' });
  }

  it('orders override > session > role > config', () => {
    const model = reasoningModel();
    const config = { level: 'high', source: 'project' };
    expect(
      resolveThinkingLevel(model, {
        override: { level: 'minimal', source: 'cli' },
        persisted: 'low',
        role: 'medium',
        config,
      }),
    ).toMatchObject({ level: 'minimal', source: 'cli' });
    expect(
      resolveThinkingLevel(model, {
        persisted: 'low',
        role: 'medium',
        config,
      }),
    ).toMatchObject({ level: 'low', source: 'session' });
    expect(
      resolveThinkingLevel(model, { role: 'medium', config }),
    ).toMatchObject({ level: 'medium', source: 'role' });
    expect(resolveThinkingLevel(model, { config })).toMatchObject({
      level: 'high',
      source: 'project',
    });
    expect(resolveThinkingLevel(model, {})).toEqual({
      level: 'off',
      source: 'default',
    });
  });

  it('clamps an unsupported level with a named notice', () => {
    const models = modelsWithFaux();
    const model = selectModel(models, undefined);
    const resolved = resolveThinkingLevel(model, {
      config: { level: 'high', source: 'project' },
    });
    expect(resolved.level).toBe('off');
    expect(resolved.notice).toMatch(/thinking 'high'.*clamped to 'off'/);
    expect(resolved.notice).toContain(`${model.provider}/${model.id}`);
  });

  it('refuses an unknown level by name, never silently', () => {
    const model = reasoningModel();
    expect(() =>
      resolveThinkingLevel(model, {
        override: { level: 'banana', source: 'KUBIC_MODEL_THINKING' },
      }),
    ).toThrow(/"banana".*KUBIC_MODEL_THINKING/);
  });

  it('parses --thinking against the known levels', () => {
    expect(parseThinkingFlag('high')).toBe('high');
    expect(() => parseThinkingFlag('banana')).toThrow(
      /unknown thinking level 'banana'/,
    );
  });
});
