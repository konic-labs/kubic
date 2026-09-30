// The ONE lane-model projection `kubic run` and `kubic tui` share
// (issue #227; §38.1, issue #133). Both boots resolve the same inputs in the
// same order — the faux testing pin, then the runtime pin the config's
// `cli`/`env`/`[model]` layers projected (runtimeModelPin), then the
// resolved role's `[roles.<name>].model` default, then the first usable
// provider — so the interactive path can never pick a different model than
// the headless one, and the #148 resume rule reads one answer for both.

import {
  FAUX_MODEL_ID,
  FAUX_PROVIDER_ID,
} from '../../../packages/host/src/faux-provider.js';
import {
  type AnyModel,
  ModelSelectError,
  type ModelSelection,
  selectModel,
} from '../../../packages/worker/src/model-select.js';
import type { MutableModels } from '../../../packages/worker/src/pi-boundary.js';

export interface LaneModelInput {
  models: MutableModels;
  /** `KUBIC_PROVIDER=faux`: the testing pin is the selection, announced. */
  fauxPinned: boolean;
  /** The runtimeModelPin projection (cli > env > [model]), if one is set. */
  pin: ModelSelection | undefined;
  /** The resolved role's `[roles.<name>].model` ref, if it declares one. */
  roleModel: string | undefined;
  /** Issue #221: implicit picks never take a keyless built-in. */
  fallbackProviders: readonly string[] | undefined;
}

// Where a selection came from, keyed by the selection OBJECT (issue #295): the
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

export function selectLaneModel(input: LaneModelInput): AnyModel {
  return selectModel(
    input.models,
    input.fauxPinned
      ? { provider: FAUX_PROVIDER_ID, id: FAUX_MODEL_ID }
      : input.pin,
    roleModelSelection(input.roleModel),
    input.fallbackProviders,
  );
}

// Issue #148 (§26.1): a pin (any explicit selection — faux, runtime, or
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
