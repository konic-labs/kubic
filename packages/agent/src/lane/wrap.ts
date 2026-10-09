// Deterministic tool-wrap composition.
// Contributions compose in listed order: the first contribution wraps
// closest to the core, the last is outermost. Rebuilds are pure — removing
// an extension means recomposing without it, never an inverse mutation.
// Composition stays pre-registration: the Kubic extension is
// installed with whatever `composeTools` returned, and pi-durable's own
// `wrapTool` decorators apply on top of that.
import type { ToolRegistration } from '../pi-boundary.js';

/** @internal */
export type ExecuteFn = (...args: unknown[]) => unknown;

export interface ToolContribution {
  id: string;
  wrap: (next: ExecuteFn, toolName: string) => ExecuteFn;
}

export function composeTools(
  base: readonly ToolRegistration[],
  contributions: ToolContribution[],
): ToolRegistration[] {
  return base.map((tool) => {
    let execute = tool.execute as unknown as ExecuteFn;
    for (const contribution of contributions) {
      execute = contribution.wrap(execute, tool.name);
    }
    return {
      ...tool,
      execute: execute as unknown as ToolRegistration['execute'],
    };
  });
}

/** @internal */
export class PolicyDeniedError extends Error {
  constructor(toolName: string) {
    super(`tool '${toolName}' denied by policy wrapper`);
    this.name = 'PolicyDeniedError';
  }
}

// Permission wrapper: defense in depth behind setActiveTools — denies at
// execute time what the allowlist should already have removed.
export function withPermissionCheck(
  isAllowed: (toolName: string) => boolean,
): ToolContribution {
  return {
    id: 'permission',
    wrap:
      (next, toolName) =>
      async (...args) => {
        if (!isAllowed(toolName)) throw new PolicyDeniedError(toolName);
        return next(...args);
      },
  };
}

export interface TelemetryRecord {
  toolName: string;
  durationMs: number;
}

// Telemetry wrapper: outermost by convention, so it times the full
// permission(core) stack. The sink decides what "emit" means. Denied
// attempts are recorded too — the audit trail must show the attempt,
// not just the successes.
export function withTelemetry(
  sink: (record: TelemetryRecord) => void,
): ToolContribution {
  return {
    id: 'telemetry',
    wrap:
      (next, toolName) =>
      async (...args) => {
        const start = Date.now();
        try {
          return await next(...args);
        } finally {
          sink({ toolName, durationMs: Date.now() - start });
        }
      },
  };
}
