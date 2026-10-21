// The config layers a load reads, in precedence order: each file layer
// parsed (the project layer only once trusted), the programmatic layers, and
// the source of every leaf.

import { join } from 'node:path';
import { findProjectRoot } from '../cli/index.js';
import { safeExists } from './bridge-reads.js';
import { isRecord } from './checks.js';
import type { ConfigLayer, KubicConfig, LayerInput } from './config.js';
import {
  defaultLayerPaths,
  parseLayerConfig,
  resolveConfigSkills,
} from './config.js';
import { ConfigError, ProjectUntrustedError } from './errors.js';
import {
  type ManagedReport,
  managedConfigDirs,
  managedFilePath,
  managedKeyPath,
  readManagedRemote,
  verifyManagedText,
} from './managed.js';
import type {
  ConfigLayerReport,
  ConfigValueSource,
  RuntimeConfigInputs,
} from './runtime-types.js';

export const LAYER_ORDER: readonly ConfigLayer[] = [
  'enterprise',
  'product',
  'global',
  'project',
  'session',
  'agent',
];

export interface LoadedLayers {
  inputs: LayerInput[];
  // Each present layer's own parsed config, in precedence order: the
  // policy resolution needs per-layer inputs so a lower layer
  // can narrow a higher one's deny list without the pre-flattened merge
  // dropping the addition.
  perLayer: Array<{ layer: ConfigLayer; config: KubicConfig }>;
  sources: Record<string, ConfigValueSource>;
  paths: Record<ConfigLayer, string | undefined>;
  reports: ConfigLayerReport[];
  // The managed (enterprise) config's provenance: its file, whether its
  // signature verified, and the remote policy merged into it.
  managed?: ManagedReport;
}

// Per-layer parse, in precedence order, with the trust gate applied before
// any project file is read. Each layer's own leaves are recorded so the
// source of an effective value is the layer that set it — never a guess.
export function loadLayers(
  inputs: RuntimeConfigInputs,
  projectTrusted: boolean,
): LoadedLayers {
  const dirs = inputs.managedDirs ?? managedConfigDirs();
  const paths = defaultLayerPaths({
    home: inputs.home,
    projectRoot:
      inputs.projectRoot ??
      findProjectRoot(inputs.bridge, inputs.cwd, inputs.home),
    enterprisePath:
      inputs.enterprisePath ??
      managedFilePath(inputs.bridge, 'config.toml', dirs),
    productPath:
      inputs.productPath ??
      managedFilePath(inputs.bridge, 'product.toml', dirs),
  });
  let managed: ManagedReport | undefined;
  const layerInputs: LayerInput[] = [];
  const perLayer: Array<{ layer: ConfigLayer; config: KubicConfig }> = [];
  const sources: Record<string, ConfigValueSource> = {};
  const reports: ConfigLayerReport[] = [];
  for (const layer of LAYER_ORDER) {
    const path = paths[layer];
    if (layer === 'session' || layer === 'agent') {
      const programmatic = layer === 'session' ? inputs.session : inputs.agent;
      reports.push({
        layer,
        path,
        present: programmatic !== undefined,
        trusted: true,
      });
      if (programmatic !== undefined) {
        // Programmatic layers declare no file, so their
        // relative `skills` entries anchor at the invoking cwd.
        const resolved = resolveConfigSkills(
          programmatic,
          join(inputs.cwd, 'config.toml'),
        );
        layerInputs.push({ layer, config: resolved });
        perLayer.push({ layer, config: resolved });
      }
      continue;
    }
    const present = path !== undefined && safeExists(inputs.bridge, path);
    reports.push({
      layer,
      path,
      present,
      trusted: layer === 'project' ? projectTrusted : true,
    });
    if (layer === 'project' && !projectTrusted) {
      if (present) {
        // Refused pre-trust, before the file is read. Named by path
        // so the operator knows exactly which layer is waiting on trust,
        // and with the remedies named: the durable grant or the
        // per-invocation env opt-in.
        throw new ProjectUntrustedError(
          inputs.projectTrustChanged === true
            ? `project-local config changed since the project was trusted: ${path} — review the project's .kubic/ files, models.json and skills, then run 'kubic trust' to accept them, or set KUBIC_TRUST_PROJECT=1 for this invocation`
            : `project-local config refused pre-trust: ${path} — run 'kubic trust' to accept this project, or set KUBIC_TRUST_PROJECT=1 for this invocation`,
        );
      }
      continue;
    }
    if (!present || path === undefined) continue;
    const text = inputs.bridge.readTextFile(path);
    const parsed = parseLayerConfig(layer, text);
    const remote = managedLayer(inputs, layer, path, text, parsed);
    if (remote !== undefined) {
      managed = remote.report;
      // The organization's remote policy sits above the local file.
      if (remote.config !== undefined) {
        layerInputs.push({ layer, config: remote.config });
        perLayer.push({ layer, config: remote.config });
        for (const leaf of Object.keys(flatten(remote.config))) {
          if (!(leaf in sources)) sources[leaf] = layer;
        }
      }
    }
    // Relative `skills` entries anchor at the config
    // file that declared them — a project config's `../shared/skills`
    // names the project's sibling, wherever the run was invoked from.
    const resolved = resolveConfigSkills(parsed, path);
    layerInputs.push({
      layer,
      config: resolved,
      ...(layer === 'project' ? { trusted: true as const } : {}),
    });
    perLayer.push({ layer, config: resolved });
    for (const leaf of Object.keys(flatten(parsed))) {
      if (!(leaf in sources)) sources[leaf] = layer;
    }
  }
  return {
    inputs: layerInputs,
    perLayer,
    sources,
    paths,
    reports,
    ...(managed === undefined ? {} : { managed }),
  };
}

// The managed layers' own rules: an enterprise or product file whose
// directory holds a policy.pub must carry a signature that verifies, only the
// enterprise file may set `[managed]`, and its `url` brings the verified
// remote policy in. Returns the enterprise layer's provenance and the remote
// policy's config, when there is one.
function managedLayer(
  inputs: RuntimeConfigInputs,
  layer: ConfigLayer,
  path: string,
  text: string,
  parsed: KubicConfig,
): { report: ManagedReport; config?: KubicConfig } | undefined {
  if (layer !== 'enterprise' && layer !== 'product') {
    if (parsed.managed !== undefined) {
      throw new ConfigError(
        `'[managed]' is read only from the managed config; the ${layer} layer (${path}) cannot set it`,
      );
    }
    return undefined;
  }
  const keyPath = managedKeyPath(inputs.bridge, path);
  if (keyPath !== undefined) {
    verifyManagedText(inputs.bridge, path, text, keyPath);
  }
  if (layer === 'product') {
    if (parsed.managed !== undefined) {
      throw new ConfigError(
        `'[managed]' is read only from the managed config.toml; the product layer (${path}) cannot set it`,
      );
    }
    return undefined;
  }
  const url = parsed.managed?.url;
  const report: ManagedReport = {
    configPath: path,
    signed: keyPath !== undefined,
  };
  if (url === undefined) return { report };
  const remote = readManagedRemote(
    inputs.bridge,
    inputs.home,
    {
      url,
      ...(parsed.managed?.refreshHours === undefined
        ? {}
        : { refreshHours: parsed.managed.refreshHours }),
    },
    keyPath,
  );
  const config = parseLayerConfig('enterprise', remote.text);
  if (config.managed !== undefined) {
    throw new ConfigError(
      `the managed policy from ${url} sets '[managed]': a remote policy cannot point at another one`,
    );
  }
  return {
    report: {
      ...report,
      remote: { url, fetchedAt: remote.fetchedAt, cachePath: remote.cachePath },
    },
    config,
  };
}

export function flatten(value: unknown, prefix = ''): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const walk = (entry: unknown, path: string): void => {
    if (isRecord(entry)) {
      for (const [key, child] of Object.entries(entry)) {
        walk(child, path === '' ? key : `${path}.${key}`);
      }
      return;
    }
    out[path] = entry;
  };
  walk(value, prefix);
  return out;
}

// [agent] systemPromptFile: resolve the configured path against the declaring
// layer and read it now, through the bridge — fail-closed. `~` expands to the
// home directory; an absolute path is taken as typed; a relative path resolves
// against the declaring config file's directory (programmatic session/agent
// layers are never files, so a relative path there is refused, never guessed).
// The project layer additionally requires containment in the project root: a
// trusted path outside it is refused by name. Global and higher layers are
// unrestricted. A missing or unreadable file is a named ConfigError. Source
// attribution for the programmatic session/agent layers: first layer in
// precedence order that sets the leaf. File layers always win over these (they
// precede them), so this is only the fallback when no file source recorded the
// key.
export function programmaticSourceFor(
  inputs: RuntimeConfigInputs,
  key: string,
): ConfigLayer | undefined {
  for (const layer of ['session', 'agent'] as const) {
    const scoped = inputs[layer];
    if (scoped !== undefined && flatten(scoped)[key] !== undefined) {
      return layer;
    }
  }
  return undefined;
}
