// Admin hooks: shell commands from the managed and user config, run before
// and after each tool call and when a run ends.
export type { HookContext } from './run-hooks.js';
export {
  runAfterToolHooks,
  runBeforeToolHooks,
  runRunEndHooks,
} from './run-hooks.js';
