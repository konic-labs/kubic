// Path confinement: tool paths resolved inside the workspace.
import { isAbsolute, join, resolve } from 'node:path';

export function confinePath(
  workspace: string,
  path: string,
): { confined: string; rewritten: boolean } {
  const root = resolve(workspace);
  const resolved = isAbsolute(path) ? resolve(path) : resolve(root, path);
  if (resolved === root || resolved.startsWith(`${root}/`))
    return { confined: resolved, rewritten: false };
  // Re-root under the workspace. The rewritten path is operator-visible in
  // the tool call, so a same-named workspace file can confuse but never
  // silently serve an outside file.
  const tail = resolved
    .split('/')
    .filter((part) => part !== '' && part !== '..' && part !== '.');
  return { confined: join(root, tail.join('/')), rewritten: true };
}

// Tools whose path-like args are confined. read/write/edit/ls take `path`,
// find/grep take `root`.
const CONFINED_TOOLS: Record<string, string[]> = {
  read: ['path'],
  write: ['path'],
  edit: ['path'],
  ls: ['path'],
  find: ['root'],
  grep: ['root'],
};

// Rewrites the confined path/root arguments of a call. The input is Pi's
// `JsonObject` (the harness hands the hook its own `ToolCall`), read here
// through the plain `Record<string, unknown>` every argument bag satisfies;
// every rewrite replaces one string with another, so the shape is preserved.
export function confineArgs(
  toolName: string,
  args: Record<string, unknown>,
  workspace: string,
): Record<string, unknown> | undefined {
  const keys = CONFINED_TOOLS[toolName];
  if (keys === undefined) return undefined;
  let rewritten = false;
  const next = { ...args };
  for (const key of keys) {
    const value = next[key];
    if (typeof value !== 'string') continue;
    const { confined, rewritten: hit } = confinePath(workspace, value);
    if (hit) {
      next[key] = confined;
      rewritten = true;
    }
  }
  return rewritten ? next : undefined;
}
