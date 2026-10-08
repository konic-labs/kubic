// The ONE lane-model projection `kubic run` and `kubic tui` share. Both boots
// resolve the same inputs in the same order — the faux testing pin, then the
// runtime pin the config's `cli`/`env`/`[model]` layers projected
// (runtimeModelPin), then the resolved role's `[roles.<name>].model` default,
// then the first usable provider — so the interactive path can never pick a
// different model than the headless one, and the resume rule reads one answer
// for both.

import {
  ModelSelectError,
  type ModelSelection,
} from '../../../packages/agent/src/model-select.js';

// Where a selection came from, keyed by the selection OBJECT: the
// named "unknown model/provider" refusal says which input carried the bad pin
// (`--model`, `KUBIC_MODEL`, a config layer, a role) instead of calling every
// explicit selection `--model`. The label rides beside the object, never on
// it, so a selection still compares equal to a plain `{ provider, id }` and
// the two boots (`kubic run`, `kubic tui`) need no extra dep to carry it; a
// selection copied on the way loses its label and falls back to selectModel's
// own wording.
const selectionOrigins = new WeakMap<object, string>();

export function withSelectionOrigin<T extends ModelSelection>(
  selection: T,
  origin: string,
): T {
  selectionOrigins.set(selection, origin);
  return selection;
}

export function selectionOrigin(selection: ModelSelection): string | undefined {
  return selectionOrigins.get(selection);
}

// `[roles.<name>].model` is written as one `provider/id` string; split it
// with the same rule — and the same named refusal — as `--model`.
export function roleModelSelection(
  ref: string | undefined,
): ModelSelection | undefined {
  if (ref === undefined) return undefined;
  const slash = ref.indexOf('/');
  if (slash <= 0 || slash === ref.length - 1) {
    throw new ModelSelectError(
      `[roles.<name>].model must be 'provider/id' (got ${JSON.stringify(ref)})`,
    );
  }
  return withSelectionOrigin(
    { provider: ref.slice(0, slash), id: ref.slice(slash + 1) },
    'role model',
  );
}

// A pin (any explicit selection — faux, runtime, or
// role) switches a resumed session whose stored model differs; the default
// pick never does. One answer for both boots.
export function hasExplicitModelSelection(input: {
  fauxPinned: boolean;
  pin: ModelSelection | undefined;
  roleModel: string | undefined;
}): boolean {
  return (
    input.fauxPinned ||
    input.pin !== undefined ||
    roleModelSelection(input.roleModel) !== undefined
  );
}
