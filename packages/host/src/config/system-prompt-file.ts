// `[agent] systemPromptFile`: resolved against the layer that declared it,
// confined to that layer's root, and read once at load.

import { dirname, isAbsolute, join, relative } from 'node:path';
import type { FileBridge } from '@kubic/exec/file-bridge';
import { safeExists } from './bridge-reads.js';
import type { ConfigLayer } from './config.js';
import { ConfigError } from './errors.js';
import type {
  ConfigValueSource,
  RuntimeSystemPrompt,
} from './runtime-types.js';

// Whether `path` lies outside `root` (the root itself counts as outside:
// it is a directory, never the file).
function outsideRoot(path: string, root: string): boolean {
  const rel = relative(root, path);
  return rel === '' || rel.startsWith('..') || isAbsolute(rel);
}

// The real path, or undefined when the bridge cannot resolve it (a missing
// file is then reported by the existence check that follows).
function realPathOf(
  bridge: Pick<FileBridge, 'realPath'>,
  path: string,
): string | undefined {
  try {
    return bridge.realPath?.(path);
  } catch {
    return undefined;
  }
}

export function resolveSystemPromptFile(args: {
  bridge: Pick<FileBridge, 'exists' | 'readTextFile' | 'realPath'>;
  home: string;
  projectRoot: string;
  configured: string | undefined;
  source: ConfigValueSource | undefined;
  layerPath: string | undefined;
}): RuntimeSystemPrompt | undefined {
  const { configured, source } = args;
  if (configured === undefined) return undefined;
  if (typeof configured !== 'string' || configured === '') {
    throw new ConfigError(
      `'agent': 'systemPromptFile' must be a non-empty string`,
    );
  }
  if (source === undefined || source === 'defaults') {
    // The key is set but no layer owns it: attribution would be a guess.
    throw new ConfigError(
      `'agent': 'systemPromptFile' is set but no config layer owns it`,
    );
  }
  const layer = source as ConfigLayer;
  let resolved: string;
  if (configured.startsWith('~/')) {
    resolved = join(args.home, configured.slice(2));
  } else if (isAbsolute(configured)) {
    resolved = configured;
  } else if (args.layerPath === undefined) {
    throw new ConfigError(
      `'agent': 'systemPromptFile' '${configured}' is a relative path with no declaring config file — use an absolute path`,
    );
  } else {
    resolved = join(dirname(args.layerPath), configured);
  }
  if (layer === 'project') {
    if (outsideRoot(resolved, args.projectRoot)) {
      throw new ConfigError(
        `'agent': 'systemPromptFile' '${resolved}' is outside the project root '${args.projectRoot}'`,
      );
    }
    // A symlink inside the root can still point out of it: the target is
    // contained too, measured against the root's own real path.
    const real = realPathOf(args.bridge, resolved);
    const realRoot = realPathOf(args.bridge, args.projectRoot);
    if (
      real !== undefined &&
      realRoot !== undefined &&
      outsideRoot(real, realRoot)
    ) {
      throw new ConfigError(
        `'agent': 'systemPromptFile' '${resolved}' resolves outside the project root '${args.projectRoot}' (to '${real}')`,
      );
    }
  }
  if (!safeExists(args.bridge, resolved)) {
    throw new ConfigError(
      `'agent': 'systemPromptFile' '${resolved}' does not exist`,
    );
  }
  let contents: string;
  try {
    contents = args.bridge.readTextFile(resolved);
  } catch (error) {
    throw new ConfigError(
      `'agent': 'systemPromptFile' '${resolved}' cannot be read: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return { path: resolved, contents, source };
}
