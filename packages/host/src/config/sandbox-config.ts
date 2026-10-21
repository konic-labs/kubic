// `[sandbox]`: whether the bash tool's commands run in the OS sandbox —
// `off` (the default), `auto` (when this machine has one) or `required`
// (refuse to run without one). The strictest mode any layer sets wins, so a
// repository can tighten it but never loosen it. `writable` adds paths a
// sandboxed command may write (a package cache), read from the enterprise,
// product and global layers only.

import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import type { ConfigLayer, KubicConfig } from './config.js';
import { ConfigError } from './errors.js';

type SandboxMode = 'off' | 'auto' | 'required';

export interface RuntimeSandbox {
  readonly mode: SandboxMode;
  // The layer that set the mode; absent for the default.
  readonly modeLayer?: ConfigLayer;
  readonly writable: readonly string[];
}

const MODES: readonly SandboxMode[] = ['off', 'auto', 'required'];
const WRITABLE_LAYERS: ReadonlySet<ConfigLayer> = new Set([
  'enterprise',
  'product',
  'global',
]);

function expandHome(path: string, home: string): string {
  return path === '~' || path.startsWith('~/')
    ? join(home, path.slice(1))
    : path;
}

export function sandboxOf(
  perLayer: ReadonlyArray<{ layer: ConfigLayer; config: KubicConfig }>,
  projectPath?: string,
  home: string = homedir(),
): RuntimeSandbox {
  let mode: SandboxMode = 'off';
  let modeLayer: ConfigLayer | undefined;
  const writable: string[] = [];
  for (const { layer, config } of perLayer) {
    const section = config.sandbox;
    if (section === undefined) continue;
    if (section.mode !== undefined) {
      if (!MODES.includes(section.mode as SandboxMode)) {
        throw new ConfigError(
          `'sandbox.mode' must be one of ${MODES.join(', ')} (got ${JSON.stringify(section.mode)})`,
        );
      }
      const candidate = section.mode as SandboxMode;
      if (MODES.indexOf(candidate) > MODES.indexOf(mode)) {
        mode = candidate;
        modeLayer = layer;
      }
    }
    if (section.writable !== undefined) {
      if (!WRITABLE_LAYERS.has(layer)) {
        throw new ConfigError(
          `'sandbox.writable' is read from the enterprise, product and global layers only; the ${layer} layer${layer === 'project' && projectPath !== undefined ? ` (${projectPath})` : ''} cannot widen what a sandboxed command may write`,
        );
      }
      for (const entry of section.writable) {
        const path = expandHome(entry, home);
        if (!isAbsolute(path)) {
          throw new ConfigError(
            `'sandbox.writable' entries are absolute or ~/ paths (got ${JSON.stringify(entry)})`,
          );
        }
        writable.push(path);
      }
    }
  }
  return {
    mode,
    ...(modeLayer === undefined ? {} : { modeLayer }),
    writable,
  };
}
