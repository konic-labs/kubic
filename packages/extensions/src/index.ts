// @kubic/extensions — first-party facet bundles (issue #37; §31–§32).
// v1 loads owned code only; third-party is refused with no bypass.

export type { BudgetLimits, BudgetStatus } from './bundles/budget/contract.js';
export { BUDGET_SERVICE } from './bundles/budget/contract.js';
export { registerBudgetService } from './bundles/budget/host.js';
export { BUDGET_MANIFEST, createBudgetBundle } from './bundles/budget/index.js';
export { renderBudgetStatus } from './bundles/budget/tui.js';
export type { BudgetUsage } from './bundles/budget/worker.js';
export { checkBudgetExhausted } from './bundles/budget/worker.js';
export type { CancellationDomain } from './cancellation.js';
export {
  CANCELLATION_DOMAINS,
  DisconnectController,
  TaskScope,
} from './cancellation.js';
export type { ExtensionManifest, FacetKind } from './contract.js';
export { ExtensionRefusedError, FACET_KINDS } from './contract.js';
export { assertFacetImports, FacetBoundaryError } from './facets.js';
export type {
  ActivationEnv,
  BundleFactory,
  FlushStage,
} from './loader.js';
export { ExtensionLoader, FLUSH_ORDER } from './loader.js';
export type { CellDelta, CellSnapshot } from './replicated.js';
export { ReplicatedCell } from './replicated.js';
export {
  budgetLimitsOf,
  budgetStatusOf,
  budgetToolGate,
  commandLoadsExtensions,
  EXTENSION_STARTUP_COMMANDS,
  ExtensionBudgetError,
  firstBreachedLimit,
  postureFromStartup,
  startFirstPartyExtensions,
} from './runtime.js';
export type { SecretFacade } from './secrets.js';
export { SecretRemoteError, SecretStore } from './secrets.js';
export type {
  LoaderEnvView,
  ServiceEntry,
  ServiceOptions,
  UseOptions,
} from './services.js';
export {
  createEnv,
  ServiceNotFoundError,
  ServiceRegistry,
  ServiceRemoteError,
} from './services.js';
export type {
  BundleDirFiles,
  BundleLoad,
  ExtensionPosture,
  PostureOptions,
  RefusedAttempt,
} from './startup.js';
export {
  BUNDLE_MANIFEST_FILE,
  ExtensionStartupError,
  FIRST_PARTY_BUNDLE_NAME,
  loadFirstPartyBundle,
  probeFirstPartyPosture,
} from './startup.js';
export type { TrustOptions, TrustSubject } from './trust.js';
export {
  assertFirstParty,
  FIRST_PARTY_PUBLISHERS,
  isFirstParty,
  isOwnedPath,
} from './trust.js';
