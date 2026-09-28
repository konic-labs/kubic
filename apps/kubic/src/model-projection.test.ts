// The shared lane-model projection (issue #227; §38.1, §133). Both boots
// (`kubic run`, `kubic tui`) resolve through these functions, so their
// precedence and refusals are pinned here directly — the prod-path tests
// prove the wiring, these prove the order.
import { describe, expect, it } from 'vitest';
import { ModelSelectError } from '../../../packages/worker/src/model-select.js';
import {
  createModels,
  fauxAssistantMessage,
  fauxProvider,
} from '../../../packages/worker/src/pi-boundary.js';
import {
  hasExplicitModelSelection,
  roleModelSelection,
  selectLaneModel,
} from './model-projection.js';

// Two providers: `faux` (first registered, the default pick) and `alt`.
function catalog() {
  const models = createModels();
  const faux = fauxProvider({
    provider: 'faux',
    models: [
      { id: 'big', contextWindow: 200000 },
      { id: 'small', contextWindow: 120000 },
      { id: 'echo', contextWindow: 100000 },
    ],
  });
  faux.setResponses([fauxAssistantMessage('faux')]);
  models.setProvider(faux.provider);
  const alt = fauxProvider({
    provider: 'alt',
    models: [{ id: 'm1', contextWindow: 100000 }],
  });
  alt.setResponses([fauxAssistantMessage('alt')]);
  models.setProvider(alt.provider);
  return models;
}

describe('roleModelSelection (issue #227)', () => {
  it('splits provider/id and refuses every malformed ref by name', () => {
    expect(roleModelSelection(undefined)).toBeUndefined();
    expect(roleModelSelection('alt/m1')).toEqual({
      provider: 'alt',
      id: 'm1',
    });
    for (const bad of ['nope', '/m1', 'alt/']) {
      expect(() => roleModelSelection(bad)).toThrow(ModelSelectError);
      expect(() => roleModelSelection(bad)).toThrow(
        `[roles.<name>].model must be 'provider/id' (got ${JSON.stringify(bad)})`,
      );
    }
  });
});

describe('selectLaneModel (issue #227)', () => {
  it('pins the faux provider over every other selection', () => {
    const picked = selectLaneModel({
      models: catalog(),
      fauxPinned: true,
      pin: { provider: 'alt', id: 'm1' },
      roleModel: 'alt/m1',
      fallbackProviders: undefined,
    });
    expect(`${picked.provider}/${picked.id}`).toBe('faux/echo');
  });

  it('takes the runtime pin over the role default and the first provider', () => {
    const picked = selectLaneModel({
      models: catalog(),
      fauxPinned: false,
      pin: { provider: 'faux', id: 'small' },
      roleModel: 'alt/m1',
      fallbackProviders: undefined,
    });
    expect(`${picked.provider}/${picked.id}`).toBe('faux/small');
  });

  it('falls back to the role default, then the first usable provider', () => {
    const models = catalog();
    const role = selectLaneModel({
      models,
      fauxPinned: false,
      pin: undefined,
      roleModel: 'alt/m1',
      fallbackProviders: undefined,
    });
    expect(`${role.provider}/${role.id}`).toBe('alt/m1');
    const first = selectLaneModel({
      models,
      fauxPinned: false,
      pin: undefined,
      roleModel: undefined,
      fallbackProviders: undefined,
    });
    expect(`${first.provider}/${first.id}`).toBe('faux/big');
  });

  it('refuses an unknown runtime pin by name', () => {
    expect(() =>
      selectLaneModel({
        models: catalog(),
        fauxPinned: false,
        pin: { provider: 'faux', id: 'nope' },
        roleModel: undefined,
        fallbackProviders: undefined,
      }),
    ).toThrow("unknown model 'nope' on provider 'faux' (--model)");
  });
});

describe('hasExplicitModelSelection (issue #227)', () => {
  it('is true for each explicit source and false for the default pick', () => {
    expect(
      hasExplicitModelSelection({
        fauxPinned: true,
        pin: undefined,
        roleModel: undefined,
      }),
    ).toBe(true);
    expect(
      hasExplicitModelSelection({
        fauxPinned: false,
        pin: { provider: 'faux', id: 'small' },
        roleModel: undefined,
      }),
    ).toBe(true);
    expect(
      hasExplicitModelSelection({
        fauxPinned: false,
        pin: undefined,
        roleModel: 'alt/m1',
      }),
    ).toBe(true);
    expect(
      hasExplicitModelSelection({
        fauxPinned: false,
        pin: undefined,
        roleModel: undefined,
      }),
    ).toBe(false);
  });
});
