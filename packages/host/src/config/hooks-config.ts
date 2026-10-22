// The admin hooks in force: every `[[hooks]]` table of the enterprise,
// product and global layers, in that order — an organization's hooks and a
// user's own both run. A project config declaring hooks is refused by name:
// a repository must not run commands of its own around every tool call.

import type { ConfigLayer, KubicConfig } from './config.js';
import { ConfigError } from './errors.js';

export type HookEvent = 'beforeTool' | 'afterTool' | 'runEnd';

export interface AdminHook {
  readonly event: HookEvent;
  readonly command: string;
  // The tool names a tool hook applies to; absent: every tool.
  readonly tools?: readonly string[];
  readonly timeoutMs: number;
  readonly layer: ConfigLayer;
}

const DEFAULT_HOOK_TIMEOUT_MS = 5_000;

// The order the hooks run in: the organization's first.
const HOOK_LAYERS: readonly ConfigLayer[] = ['enterprise', 'product', 'global'];

export function adminHooksOf(
  perLayer: ReadonlyArray<{ layer: ConfigLayer; config: KubicConfig }>,
  projectPath?: string,
): AdminHook[] {
  for (const { layer, config } of perLayer) {
    if ((config.hooks ?? []).length === 0 || HOOK_LAYERS.includes(layer)) {
      continue;
    }
    throw new ConfigError(
      `'[[hooks]]' is read from the enterprise, product and global layers only; the ${layer} layer${layer === 'project' && projectPath !== undefined ? ` (${projectPath})` : ''} cannot declare hooks`,
    );
  }
  return HOOK_LAYERS.flatMap((layer) =>
    perLayer
      .filter((entry) => entry.layer === layer)
      .flatMap(({ config }) =>
        (config.hooks ?? []).map(
          (table): AdminHook => ({
            event: table.event as HookEvent,
            command: table.command,
            ...(table.tools === undefined ? {} : { tools: [...table.tools] }),
            timeoutMs: table.timeoutMs ?? DEFAULT_HOOK_TIMEOUT_MS,
            layer,
          }),
        ),
      ),
  );
}
