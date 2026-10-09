// Paths as the TUI shows them.
import { homedir } from 'node:os';

// A path under the home directory, written `~/…`.
export function tildePath(path: string, home: string = homedir()): string {
  if (home === '' || home === '/') return path;
  if (path === home) return '~';
  return path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path;
}
