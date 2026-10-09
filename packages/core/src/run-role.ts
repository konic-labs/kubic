// The run role a heading and the agent tree's head row name: the `--role`
// name when one is selected, otherwise `default` (the stock run boots no role
// document). A role name is user-controlled, so it takes a fixed column the
// way the heading cuts its own text: a trailing `…` marks the cut.

import { truncateVisible } from './cli/width.js';

/** The role of a run without `--role`, as the run records and names it. */
export const DEFAULT_RUN_ROLE = 'default';

/** Columns a role name takes in a heading or a tree row. */
/** @internal */
export const RUN_ROLE_COLUMNS = 20;

/** The label a run's role takes in a heading or a tree row. */
export function runRoleLabel(role: string | undefined): string {
  return truncateVisible(role ?? DEFAULT_RUN_ROLE, RUN_ROLE_COLUMNS);
}
