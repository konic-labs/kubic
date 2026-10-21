// The boot's model step: the catalogue (assembled or injected), the faux
// provider pin, and the boot model selected under the enterprise and role
// gates.

import { ModelSelectError } from '@kubic/agent/model-select';
import type { MutableModels } from '@kubic/agent/pi-boundary';
import { createSecretCommandRunner } from '@kubic/exec/secret-runner';
import { createLedgerModelKeyResolver } from '@kubic/host/audit';
import {
  assembleModels,
  FAUX_NOTICE,
  invalidProviderMessage,
  providerOverrideFromEnv,
} from '@kubic/host/models';
import { roleModelScope, selectBootModel } from '../config/model-selection.js';
import { hasExplicitModelSelection } from '../model-projection.js';
import type { BootRefusal, SessionBoot } from './bootstrap.js';
import { regionGateFor, selectFallbackModel } from './fallback.js';

// The provider ids and model ids a catalog names: the words a live key value
// must not be scrubbed out of.
function catalogIdentity(models: MutableModels): string[] {
  return models
    .getProviders()
    .flatMap((provider) => [
      provider.id,
      ...models.getModels(provider.id).map((model) => model.id),
    ]);
}

// The model catalog and the boot model. Provider keys resolve per request,
// and each use lands in the ledger of the run's workspace.
export async function assembleBootCatalog(
  boot: SessionBoot,
): Promise<BootRefusal | undefined> {
  const { config, sinks } = boot;
  const workspace = config.env?.cwd ?? process.cwd();
  let fallbackProviders: readonly string[] | undefined;
  if (config.models === undefined) {
    let identityWords: string[] | undefined;
    const keyResolver = createLedgerModelKeyResolver({
      workspace,
      role: boot.role?.resolved.name ?? 'root',
      sessionId: () => boot.id,
      onError: (message) =>
        sinks.debug?.(`[session] credential use not audited: ${message}`),
      // A dummy key that IS its provider's name (LM Studio's `lm-studio`)
      // is identity, not a secret: the catalog's provider and model ids
      // are read once assembled.
      identity: () => {
        if (identityWords !== undefined) return identityWords;
        if (boot.models === undefined) return [];
        identityWords = catalogIdentity(boot.models);
        return identityWords;
      },
      // `!command` secret refs execute in the run's workspace through the
      // production runner — rerun per request.
      runCommand: createSecretCommandRunner({ cwd: workspace }),
    });
    boot.liveSecrets = keyResolver.live;
    const modelsEnv = Object.fromEntries(
      Object.entries(process.env).filter(
        (entry): entry is [string, string] => entry[1] !== undefined,
      ),
    );
    const assembled = await assembleModels(
      config.modelsCwd ?? process.cwd(),
      modelsEnv,
      {
        resolveApiKey: keyResolver.resolve,
        ...(config.trustProject === undefined
          ? {}
          : { projectTrust: config.trustProject }),
        ...(config.projectProvidersRefusal === undefined
          ? {}
          : { projectProvidersRefusal: config.projectProvidersRefusal }),
      },
    );
    // A refused models.json is a config error the user must see: it goes
    // to the warning channel; a successful load is a debug receipt.
    for (const note of assembled.notes) {
      if (note.startsWith('models.json ignored')) sinks.warn(note);
      else sinks.debug?.(note);
    }
    boot.assembled = assembled;
    boot.models = assembled.models;
    fallbackProviders = assembled.fallbackProviders;
  } else {
    boot.models = config.models;
  }
  // The faux testing provider (`KUBIC_PROVIDER=faux`): registered by
  // assembleModels and pinned here, so it is the model that answers —
  // announced on the warning channel, never silent. Any other
  // KUBIC_PROVIDER value is refused by name.
  const override = providerOverrideFromEnv(process.env);
  if (override.kind === 'invalid') {
    return {
      kind: 'provider',
      message: invalidProviderMessage(override.value),
    };
  }
  const fauxPinned = override.kind === 'faux' && config.models === undefined;
  if (fauxPinned) sinks.fauxNotice?.(FAUX_NOTICE);
  const roleModel = boot.role?.resolved.model;
  boot.regionGate = regionGateFor(
    config.modelPolicy,
    boot.models,
    config.providerRegions,
  );
  try {
    // An explicit pin wins over default selection; the role layer's own
    // `provider/id` pin is the next default, and with neither the first
    // usable provider is taken (customs first; never a keyless built-in).
    // Enterprise policy and the role's allowed set gate the explicit
    // selection and the implicit pool alike.
    boot.model = selectBootModel({
      models: boot.models,
      fauxPinned,
      pin: config.model,
      roleModel,
      fallbackProviders,
      policy: config.modelPolicy,
      roleScope: roleModelScope(boot.role?.resolved),
      ...(boot.regionGate === undefined ? {} : { regionGate: boot.regionGate }),
    });
  } catch (error) {
    if (!(error instanceof ModelSelectError)) throw error;
    // The selected model cannot be used: the `[model] fallback` chain is
    // tried in order before the boot gives up.
    const primary =
      config.model === undefined
        ? (roleModel ?? 'the default model')
        : `${config.model.provider}/${config.model.id}`;
    const fallback = selectFallbackModel(
      boot,
      boot.models,
      primary,
      error.message,
    );
    if (fallback === undefined) {
      return { kind: 'provider', message: error.message };
    }
    boot.model = fallback;
  }
  // A fallback is an explicit selection: a resumed session moves to it.
  boot.explicitModel =
    boot.fallbacks.length > 0 ||
    hasExplicitModelSelection({
      fauxPinned,
      pin: config.model,
      roleModel,
    });
  boot.liveModelRef = `${boot.model.provider}/${boot.model.id}`;
  return undefined;
}
