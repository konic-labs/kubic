// A FileBridge over a FakeExecutionEnv, and skill files to put in it: the
// skills loader tests discover, gate and invoke skills on this fake disk.
import type { FileBridge } from '@kubic/exec/file-bridge';
import { FakeExecutionEnv } from '@kubic/exec/test-support/fake-env';

export function bridgeFromEnv(
  env: FakeExecutionEnv,
  links: Record<string, string> = {},
): FileBridge {
  const isDir = (dir: string, name: string): boolean => {
    const clean = dir.replace(/\/*$/, '');
    const full = clean === '' ? name : `${clean}/${name}`;
    try {
      return env.fs.stat(full).isDirectory;
    } catch {
      return false;
    }
  };
  return {
    cwd: env.cwd,
    absolutePath: (path: string): string => path,
    joinPath: (parts: string[]): string => parts.join('/'),
    readTextFile: (path: string): string => env.fs.readFile(path),
    readBinaryFile: (path: string): Uint8Array =>
      new TextEncoder().encode(env.fs.readFile(path)),
    readTextLines: (path: string, maxLines?: number): string[] => {
      const lines = env.fs.readFile(path).split('\n');
      if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
      return maxLines === undefined ? lines : lines.slice(0, maxLines);
    },
    openTextLineReader: (path: string) => {
      const reader = bridgeFromEnv(env);
      const lines = reader.readTextLines(path);
      let index = 0;
      return {
        readLine: (): string | undefined =>
          index < lines.length ? lines[index++] : undefined,
        close: (): void => undefined,
      };
    },
    writeFile: (path: string, content: string | Uint8Array): void => {
      env.fs.writeFile(path, typeof content === 'string' ? content : '{}');
    },
    appendFile: (path: string, content: string | Uint8Array): void => {
      const prior = (() => {
        try {
          return env.fs.readFile(path);
        } catch {
          return '';
        }
      })();
      env.fs.writeFile(
        path,
        prior + (typeof content === 'string' ? content : '{}'),
      );
    },
    renameFile: (source: string, destination: string): void => {
      env.fs.rename(source, destination);
    },
    fileInfo: (path: string) => ({
      name: path.split('/').pop() ?? path,
      path,
      isDirectory: false,
      isSymbolicLink: false,
      size: 0,
      mtimeMs: 0,
    }),
    listDir: (path: string) =>
      env.fs.listDir(path).map((name) => ({
        name,
        path: `${path.replace(/\/*$/, '')}/${name}`,
        isDirectory: isDir(path, name),
        isSymbolicLink: false,
        size: 0,
        mtimeMs: 0,
      })),
    exists: (path: string): boolean => {
      try {
        env.fs.stat(path);
        return true;
      } catch {
        return false;
      }
    },
    createDir: (): void => undefined,
    remove: (): void => undefined,
    createTempDir: (): string => '/fake-tmp',
    createTempFile: (): string => '/fake-tmp-file',
    // Symlink stand-in — the fake fs cannot model links, so
    // tests declare lexical-prefix → target mappings here. Longest prefix
    // wins, applied iteratively so chained links resolve fully.
    realPath: (path: string): string => {
      let resolved = path.replace(/\/*$/, '') || '/';
      for (let i = 0; i < 10; i++) {
        const from = Object.keys(links)
          .sort((a, b) => b.length - a.length)
          .find(
            (candidate) =>
              resolved === candidate || resolved.startsWith(`${candidate}/`),
          );
        if (from === undefined) break;
        resolved = `${links[from]}${resolved.slice(from.length)}`;
      }
      return resolved || '/';
    },
  };
}

export function skillMd(frontmatter: string, body = 'Skill body.'): string {
  return `---\n${frontmatter}\n---\n${body}\n`;
}

export function setup(): { env: FakeExecutionEnv; bridge: FileBridge } {
  const env = new FakeExecutionEnv({});
  return { env, bridge: bridgeFromEnv(env) };
}

export const HOME = '/fakehome';

export const CWD = '/fakehome/proj';
