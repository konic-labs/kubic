// The lane-model projection: the role default and the explicit selection the
// boots hand to the policy-gated pick. The prod-path tests prove the wiring;
// these prove the order.
import { describe, expect, it } from 'vitest';
import { ModelSelectError } from '../../../packages/worker/src/model-select.js';
import {
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  type MutableModels,
} from '../../../packages/worker/src/pi-boundary.js';
import { selectBootModel } from './config-runtime.js';
import {
  hasExplicitModelSelection,
  roleModelSelection,
  selectionOrigin,
  withSelectionOrigin,
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

describe('roleModelSelection', () => {
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

describe('selection origin labels', () => {
  it('rides beside the selection: the object stays a plain { provider, id }', () => {
    const plain = { provider: 'alt', id: 'm1' };
    expect(selectionOrigin(plain)).toBeUndefined();
    const tagged = withSelectionOrigin(plain, 'KUBIC_MODEL');
    // The same object, now labelled — and still equal to a plain selection.
    expect(tagged).toBe(plain);
    expect(selectionOrigin(tagged)).toBe('KUBIC_MODEL');
    expect(tagged).toEqual({ provider: 'alt', id: 'm1' });
    expect(Object.keys(tagged)).toEqual(['provider', 'id']);
    // A copy is a different selection: it loses the label (falls back to
    // selectModel's own wording) instead of inheriting a stale one.
    expect(selectionOrigin({ ...tagged })).toBeUndefined();
  });

  it('labels a role model pin as `role model`', () => {
    const role = roleModelSelection('alt/m1');
    expect(role).toEqual({ provider: 'alt', id: 'm1' });
    expect(role === undefined ? undefined : selectionOrigin(role)).toBe(
      'role model',
    );
  });
});

describe('the boot selection the policy gate receives', () => {
  // A faux pin is the explicit selection; otherwise the runtime pin is. The
  // role default is the config default. The boots pass them in this order.
  const pick = (input: {
    models: MutableModels;
    fauxPinned: boolean;
    pin: { provider: string; id: string } | undefined;
    roleModel: string | undefined;
    fallbackProviders: readonly string[] | undefined;
  }) => selectBootModel({ ...input, policy: undefined });

  it('pins the faux provider over every other selection', () => {
    const picked = pick({
      models: catalog(),
      fauxPinned: true,
      pin: { provider: 'alt', id: 'm1' },
      roleModel: 'alt/m1',
      fallbackProviders: undefined,
    });
    expect(`${picked.provider}/${picked.id}`).toBe('faux/echo');
  });

  it('takes the runtime pin over the role default and the first provider', () => {
    const picked = pick({
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
    const role = pick({
      models,
      fauxPinned: false,
      pin: undefined,
      roleModel: 'alt/m1',
      fallbackProviders: undefined,
    });
    expect(`${role.provider}/${role.id}`).toBe('alt/m1');
    const first = pick({
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
      pick({
        models: catalog(),
        fauxPinned: false,
        pin: { provider: 'faux', id: 'nope' },
        roleModel: undefined,
        fallbackProviders: undefined,
      }),
    ).toThrow("unknown model 'nope' on provider 'faux' (--model)");
  });
});

describe('hasExplicitModelSelection', () => {
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
