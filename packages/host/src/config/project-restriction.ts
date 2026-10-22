// `[policy] project_policy = "restricted"`: an organization's switch that
// keeps a repository from loosening what runs on a developer's machine. Set
// in a layer above the project (enterprise, product or global), it refuses a
// project config that auto-approves a capability, widens a permission class
// past what the layers above (or the defaults) allow, or declares `[verify]`
// gate commands — each named, before anything runs — and keeps the project's
// models.json providers out of the catalog (the models assembly names the
// file). A project may still narrow: a stricter permission class, a smaller
// tool set, a `deny` route.

import {
  CREDENTIAL_LEVELS,
  DEFAULT_PERMISSIONS,
  FILESYSTEM_LEVELS,
  GIT_LEVELS,
  NETWORK_LEVELS,
  type PermissionClasses,
  SHELL_LEVELS,
} from '@kubic/agent/permissions';
import type { ConfigLayer, KubicConfig } from './config.js';
import { ConfigError } from './errors.js';

export interface ProjectRestriction {
  // The layer whose `[policy] project_policy` set it.
  readonly layer: ConfigLayer;
}

const LEVELS: Record<keyof PermissionClasses, readonly unknown[]> = {
  filesystem: FILESYSTEM_LEVELS,
  shell: SHELL_LEVELS,
  network: NETWORK_LEVELS,
  git: GIT_LEVELS,
  credentials: CREDENTIAL_LEVELS,
};

const ABOVE_PROJECT: ReadonlySet<ConfigLayer> = new Set([
  'enterprise',
  'product',
  'global',
]);

type PerLayer = ReadonlyArray<{ layer: ConfigLayer; config: KubicConfig }>;

// The restriction in force, from the first layer above the project setting it.
function projectRestrictionOf(
  perLayer: PerLayer,
): ProjectRestriction | undefined {
  for (const { layer, config } of perLayer) {
    if (!ABOVE_PROJECT.has(layer)) continue;
    const policy = config.policy?.projectPolicy;
    if (policy === 'restricted') return { layer };
    if (policy === 'open') return undefined;
  }
  return undefined;
}

// The permission classes the project sets wider than the layers above it (or
// the defaults, where no layer above sets the class).
function widenedPermissions(
  perLayer: PerLayer,
  project: KubicConfig,
): string[] {
  const requested = (project.permissions ?? {}) as Record<string, unknown>;
  const widened: string[] = [];
  for (const key of Object.keys(LEVELS) as Array<keyof PermissionClasses>) {
    if (!(key in requested)) continue;
    const above = perLayer.find(
      (entry) =>
        ABOVE_PROJECT.has(entry.layer) &&
        entry.config.permissions !== undefined &&
        key in (entry.config.permissions as Record<string, unknown>),
    );
    const baseline =
      above === undefined
        ? DEFAULT_PERMISSIONS[key]
        : (above.config.permissions as Record<string, unknown>)[key];
    const levels = LEVELS[key];
    if (levels.indexOf(requested[key]) > levels.indexOf(baseline)) {
      widened.push(`permissions.${key}`);
    }
  }
  return widened;
}

/**
 * Refuses a project config that sets what the restriction forbids, naming
 * every such key. Returns the restriction in force (for the models assembly).
 */
export function checkProjectRestriction(
  perLayer: PerLayer,
  projectPath: string | undefined,
): ProjectRestriction | undefined {
  const restriction = projectRestrictionOf(perLayer);
  if (restriction === undefined) return undefined;
  const project = perLayer.find((entry) => entry.layer === 'project')?.config;
  if (project === undefined) return restriction;
  const forbidden = [
    ...((project.approvals?.autoApprove ?? []).length > 0
      ? ['approvals.autoApprove']
      : []),
    ...widenedPermissions(perLayer, project),
    ...Object.keys(project.verify ?? {})
      .filter((gate) => gate !== 'timeoutMs')
      .map((gate) => `verify.${gate}`),
  ];
  if (forbidden.length === 0) return restriction;
  throw new ConfigError(
    `project config ${projectPath ?? '.kubic/config.toml'} sets ${forbidden.map((key) => `'${key}'`).join(', ')}, which the ${restriction.layer} policy forbids ([policy] project_policy = "restricted": a project may narrow approvals and permissions, never widen them, and may not run [verify] commands) — remove ${forbidden.length === 1 ? 'it' : 'them'} from the project config`,
  );
}

/** Why the project's models.json providers stay out, when they do. */
export function projectProvidersRefusal(
  restriction: ProjectRestriction | undefined,
): string | undefined {
  return restriction === undefined
    ? undefined
    : `forbidden by the ${restriction.layer} policy ([policy] project_policy = "restricted")`;
}
