// An in-memory stand-in for the file bridge the config load reads through.
import type { FileBridge } from '@kubic/exec/file-bridge';

export type BridgePick = Pick<FileBridge, 'exists' | 'readTextFile'>;

export function fakeBridge(files: Record<string, string>): BridgePick {
  const store = new Map(Object.entries(files));
  return {
    exists: (path: string): boolean => store.has(path),
    readTextFile: (path: string): string => {
      const hit = store.get(path);
      if (hit === undefined) throw new Error(`no such file: ${path}`);
      return hit;
    },
  };
}
