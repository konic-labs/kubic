// Extension startup gate (issue #93; §31.2 loading, §32 facets/services).
// SCOPE: this is the LOADING half. `kubic run`, `kubic tui`, and
// `kubic orchestrate` load the first-party bundle set at composition-root
// startup — solo and manager lanes alike — and hand the resulting object
// down, so `kubic doctor` reports the SAME object's loaded/refused counts
// instead of running a second probe (postureFromStartup below).
//
// The trust gates, manifest read, pin check, activation and both bypass
// tripwires are the proven #80 implementation (startup.ts): this module adds
// no second loader. It only decides what a FAILED load means at startup —
// fail closed with ExtensionStartupError, never a silent skip and never
// doctor-only.
//
// The returned object carries the live ServiceRegistry plus the facet
// readers real surfaces consume, so no declared facet is dead:
//   tui facet    → budgetStatusOf (status text a surface renders)
//   worker facet → budgetToolGate / firstBreachedLimit (limits applied to
//                  the harness tool stack and to usage readings)

import type { BudgetLimits } from './bundles/budget/contract.js';
import { BUDGET_SERVICE } from './bundles/budget/contract.js';
import { renderBudgetStatus } from './bundles/budget/tui.js';
import type { BudgetUsage } from './bundles/budget/worker.js';
import { checkBudgetExhausted } from './bundles/budget/worker.js';
import type { BundleLoad, PostureOptions } from './startup.js';
import { ExtensionStartupError, loadFirstPartyBundle } from './startup.js';

export class ExtensionBudgetError extends Error {
  readonly limit: string;

  constructor(limit: string) {
    super(
      `extension budget exhausted: ${limit} limit breached (worker facet of the loaded first-party bundle)`,
    );
    this.name = 'ExtensionBudgetError';
    this.limit = limit;
  }
}

// Structural mirror of the worker's ToolContribution ({ id, wrap }): the
// extensions package must never import worker implementation (dep-lint), and
// the worker must not import extensions, so the composition root passes this
// shape across the seam exactly as it passes lane options.
export interface ToolGateContribution {
  readonly id: string;
  readonly wrap: (
    next: (...args: unknown[]) => unknown,
    toolName: string,
  ) => (...args: unknown[]) => unknown;
}

function startupMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// The startup gate. Loads the first-party bundle set through the same trust
// gates the doctor probe uses and returns the object every caller shares.
// A missing/unreadable/rejected bundle throws ExtensionStartupError here —
// the process refuses to boot rather than running bare.
export async function startFirstPartyExtensions(
  options: PostureOptions,
): Promise<BundleLoad> {
  const load = await loadFirstPartyBundle(options);
  if (!load.ok) {
    throw new ExtensionStartupError(
      `extension startup failed closed: ${load.detail}`,
    );
  }
  return load;
}

// The commands whose startup loads the bundle set: the two lane boots
// (solo `run`/`tui` and the manager `orchestrate`) plus `doctor`, which
// reports the counts. Kept here, not in the composition root, so the list
// and the loader cannot drift apart.
export const EXTENSION_STARTUP_COMMANDS = [
  'run',
  'tui',
  'orchestrate',
  'doctor',
] as const;

export function commandLoadsExtensions(command: string | undefined): boolean {
  return (
    command !== undefined &&
    (EXTENSION_STARTUP_COMMANDS as readonly string[]).includes(command)
  );
}

// Doctor's posture input, derived from the startup object the lanes booted
// with — a pure projection, never a second probe. Counts therefore cannot
// drift from what actually loaded.
export function postureFromStartup(startup: BundleLoad): {
  ok: boolean;
  loaded: string[];
  refusedCount: number;
  detail: string;
} {
  return {
    ok: startup.ok,
    loaded: [...startup.loaded],
    refusedCount: startup.refused.length,
    detail: startup.detail,
  };
}

// tui facet consumer: the live status text for the limits that loaded.
// Throws rather than returning a placeholder when the startup object carries
// no service — a surface must never render a status it did not load.
export function budgetStatusOf(startup: BundleLoad): string {
  if (!startup.ok) {
    throw new ExtensionStartupError(
      `extension startup object is degraded: ${startup.detail}`,
    );
  }
  try {
    return renderBudgetStatus(startup.limits);
  } catch (error) {
    throw new ExtensionStartupError(
      `budget status unavailable: ${startupMessage(error)}`,
    );
  }
}

// worker facet consumer: the first breached limit for a live usage reading,
// or undefined when inside budget. Reads the service through the registry
// (the same one the bundle provided into) so a missing service fails closed.
export function firstBreachedLimit(
  startup: BundleLoad,
  usage: BudgetUsage,
): string | undefined {
  if (!startup.ok) {
    throw new ExtensionStartupError(
      `extension startup object is degraded: ${startup.detail}`,
    );
  }
  const limits = startup.registry.use(BUDGET_SERVICE) as BudgetLimits;
  return checkBudgetExhausted(usage, limits);
}

export function budgetLimitsOf(startup: BundleLoad): BudgetLimits {
  if (!startup.ok) {
    throw new ExtensionStartupError(
      `extension startup object is degraded: ${startup.detail}`,
    );
  }
  return startup.registry.use(BUDGET_SERVICE) as BudgetLimits;
}

// The live consumer of the worker facet (issue #93): a tool-wrap
// contribution the solo lane composes into its real tool stack, so the
// limits the CLI started with actually bound the run — the facet is not
// dead. Accounting matches the worker's own interceptor: every attempt
// counts, in-flight call included, so `maxToolCalls: 1` admits exactly one
// call and refuses the next.
// Issue #283 (§71): `onBreach` fires when a call is refused (before the
// throw), so a headless run can trip its guard and end budget_exhausted
// instead of letting the model talk past the refusal. Lanes without the
// callback (the TUI) keep refusal-as-tool-error semantics.
export function budgetToolGate(
  startup: BundleLoad,
  onBreach?: (limit: string) => void,
): ToolGateContribution {
  const limits = budgetLimitsOf(startup);
  let attempts = 0;
  return {
    id: 'extension-budget',
    wrap:
      (next, _toolName) =>
      async (...args) => {
        attempts += 1;
        const breached = checkBudgetExhausted({ toolCalls: attempts }, limits);
        if (breached !== undefined) {
          onBreach?.(breached);
          throw new ExtensionBudgetError(breached);
        }
        return next(...args);
      },
  };
}

export { BUDGET_SERVICE };
