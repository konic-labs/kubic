// Path confinement: tool paths resolved inside the workspace. Platform paths
// throughout (`paths` is node:path; a test passes `win32`): on Windows a `\`
// separates, a drive letter's case does not matter, and a path on another
// drive is outside.
import * as nodePath from 'node:path';

// node:path's API, for one platform or the other (`posix`, `win32`).
type PlatformPath = typeof nodePath.posix;

/** Whether `path` is `root` or below it; both absolute. */
export function isInsideRoot(
  root: string,
  path: string,
  paths: PlatformPath = nodePath,
): boolean {
  const rel = paths.relative(root, path);
  return (
    rel === '' ||
    (!paths.isAbsolute(rel) &&
      rel !== '..' &&
      !rel.startsWith(`..${paths.sep}`))
  );
}

export function confinePath(
  workspace: string,
  path: string,
  paths: PlatformPath = nodePath,
): { confined: string; rewritten: boolean } {
  const root = paths.resolve(workspace);
  const resolved = paths.isAbsolute(path)
    ? paths.resolve(path)
    : paths.resolve(root, path);
  if (isInsideRoot(root, resolved, paths)) {
    return { confined: resolved, rewritten: false };
  }
  // Re-root under the workspace. The rewritten path is operator-visible in
  // the tool call, so a same-named workspace file can confuse but never
  // silently serve an outside file.
  const tail = resolved
    .slice(paths.parse(resolved).root.length)
    .split(paths.sep)
    .filter((part) => part !== '' && part !== '..' && part !== '.');
  return { confined: paths.join(root, ...tail), rewritten: true };
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
