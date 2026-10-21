// `[model] fallback` and `[policy] allowed_regions` on a boot: the region
// gate over this boot's catalog, the boot model taken from the fallback
// chain when the selected one cannot be used, and the move a run makes to
// the next rung when its model fails with a provider error. Every move is
// named on stderr and recorded with the error that caused it.

import { homedir } from 'node:os';
import type { Lane } from '@kubic/agent/lane/boot';
import { escalateLaneModel } from '@kubic/agent/lane/boot';
import type { EscalationLadder } from '@kubic/agent/model-select';
import { ModelSelectError } from '@kubic/agent/model-select';
import type { Context, MutableModels } from '@kubic/agent/pi-boundary';
import { regionRefusal } from '@kubic/host/models';
import type { EffectivePolicy } from '@kubic/host/policy';
import {
  type RegionGate,
  roleModelScope,
  selectModelUnderPolicy,
} from '../config/model-selection.js';
import type { SessionBoot } from './bootstrap.js';

export interface ModelFallback {
  readonly from: string;
  readonly to: string;
  readonly reason: string;
  readonly at: number;
}

/** The region gate over `models`, or undefined when no region is gated. */
export function regionGateFor(
  policy: EffectivePolicy | undefined,
  models: MutableModels,
  declared: Readonly<Record<string, string>> | undefined,
  env: NodeJS.ProcessEnv = process.env,
  home: string = homedir(),
): RegionGate | undefined {
  if (policy?.models.regions === undefined) return undefined;
  const ctx = {
    env,
    home,
    declared: declared ?? {},
    baseUrlOf: (provider: string) => models.getModels(provider)[0]?.baseUrl,
  };
  return (provider) => regionRefusal(policy, provider, ctx);
}

function refOf(rung: string): { provider: string; id: string } {
  const slash = rung.indexOf('/');
  return { provider: rung.slice(0, slash), id: rung.slice(slash + 1) };
}

/**
 * The first rung of the fallback chain this boot can select, after the
 * selected model was refused with `refusal`; undefined when none can.
 */
export function selectFallbackModel(
  boot: SessionBoot,
  models: MutableModels,
  primary: string,
  refusal: string,
): ReturnType<typeof selectModelUnderPolicy> | undefined {
  for (const rung of boot.config.modelFallback ?? []) {
    try {
      const picked = selectModelUnderPolicy(
        models,
        refOf(rung),
        undefined,
        undefined,
        boot.config.modelPolicy,
        roleModelScope(boot.role?.resolved),
        boot.regionGate,
      );
      recordFallback(boot, primary, rung, refusal);
      return picked;
    } catch (error) {
      if (!(error instanceof ModelSelectError)) throw error;
      boot.sinks.debug?.(`model: fallback ${rung} skipped: ${error.message}`);
    }
  }
  return undefined;
}

function recordFallback(
  boot: SessionBoot,
  from: string,
  to: string,
  reason: string,
): void {
  boot.fallbacks.push({ from, to, reason, at: Date.now() });
  boot.sinks.warn(`model: ${from} is unavailable (${reason}); using ${to}`);
}

/**
 * Moves the live lane to the next rung after `failed`, once its model failed
 * with a provider error; resolves the rung it moved to, or undefined when
 * no rung is left (or none can be selected).
 */
export async function fallBackLane(
  boot: SessionBoot,
  lane: Lane,
  ladder: EscalationLadder,
  failed: string,
  context: Context,
): Promise<string | undefined> {
  const models = boot.models;
  if (models === undefined) return undefined;
  const from = boot.liveModelRef;
  const rungs = ladder.steps.slice(ladder.steps.indexOf(from) + 1);
  for (const rung of rungs) {
    try {
      selectModelUnderPolicy(
        models,
        refOf(rung),
        undefined,
        undefined,
        boot.config.modelPolicy,
        roleModelScope(boot.role?.resolved),
        boot.regionGate,
      );
      await escalateLaneModel(
        lane,
        ladder,
        rung,
        `fallback: ${failed}`,
        context,
      );
    } catch (error) {
      boot.sinks.debug?.(
        `model: fallback ${rung} skipped: ${error instanceof Error ? error.message : String(error)}`,
      );
      continue;
    }
    boot.liveModelRef = rung;
    recordFallback(boot, from, rung, failed);
    return rung;
  }
  return undefined;
}

/** The ladder a run's fallbacks climb: the boot model, then each rung. */
export function fallbackLadder(
  boot: SessionBoot,
): EscalationLadder | undefined {
  const rungs = (boot.config.modelFallback ?? []).filter(
    (rung) => rung !== boot.liveModelRef,
  );
  if (rungs.length === 0) return undefined;
  return {
    steps: [boot.liveModelRef, ...rungs],
    maxEscalations: rungs.length,
    record: [],
  };
}
