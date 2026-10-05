// The `/scoped-models` report (issue #255; §38.2): the role's resolved
// allowed set as one transcript line. Pure (no lane, no app) so the
// wording is pinned next to the code; the loop case only appends it.
import type { RoleModelEntry } from '../../../packages/host/src/config/config.js';

export function formatScopedModels(
  role: string | undefined,
  models: readonly RoleModelEntry[] | undefined,
): string {
  if (role === undefined) {
    return 'scoped-models: no role on this lane — every registered model is allowed';
  }
  if (models === undefined || models.length === 0) {
    return `scoped-models: role '${role}' allows every registered model (no set configured)`;
  }
  const entries = models
    .map((entry) =>
      entry.thinking === undefined
        ? entry.id
        : `${entry.id} (thinking ${entry.thinking})`,
    )
    .join(', ');
  return `scoped-models: role '${role}' allows ${entries} only`;
}
