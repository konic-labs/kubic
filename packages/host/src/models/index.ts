// Models: the catalogue assembled from the built-ins and models.json, provider
// probes, the offline faux provider, key hints, and `kubic models`.
export {
  FAUX_FOOTER,
  FAUX_MODEL_ID,
  /** @internal */ FAUX_MODEL_REF,
  FAUX_NOTICE,
  FAUX_PROVIDER_ID,
  fauxProviderActive,
  invalidProviderMessage,
  providerOverrideFromEnv,
} from './faux-provider.js';
export type { AssembledModels, ModelsCommandOptions } from './models-cli.js';
export {
  assembleModels,
  contextRoomProbeOf,
  /** @internal */ findModelsProjectRoot,
  modelsSourcesProbe,
  providerProbesOf,
  runModelsCommand,
} from './models-cli.js';
export type { /** @internal */ CatalogProvider } from './models-render.js';
export {
  formatContext,
  /** @internal */ renderModelsCatalog,
} from './models-render.js';
export { providerKeyHints } from './provider-key-hints.js';
