// Role documents resolve at the project root (issue #229; §35.1): a
// `kubic run --role` from a subdirectory finds the same
// `<root>/.kubic/roles/*.md` as one from the root. In-memory bridge only:
// zero network, zero paid tokens.
import { describe, expect, it } from 'vitest';
import { loadRoles, selectRole } from './roles-boot.js';

// An in-memory FileBridge slice: listDir + readTextFile over a path→text
// map, so the loader is driven without touching the filesystem.
function memBridge(files: Record<string, string>): {
  listDir: (dir: string) => Array<{
    name: string;
    path: string;
    isDirectory: boolean;
    isSymbolicLink: boolean;
    size: number;
    mtimeMs: number;
  }>;
  readTextFile: (path: string) => string;
} {
  return {
    listDir: (dir) => {
      const prefix = `${dir}/`;
      const names = new Map<string, boolean>();
      for (const path of Object.keys(files)) {
        if (!path.startsWith(prefix)) continue;
        const rest = path.slice(prefix.length);
        const slash = rest.indexOf('/');
        if (slash === -1) names.set(rest, false);
        else names.set(rest.slice(0, slash), true);
      }
      return [...names.entries()].map(([name, isDirectory]) => ({
        name,
        path: `${prefix}${name}`,
        isDirectory,
        isSymbolicLink: false,
        size: 0,
        mtimeMs: 0,
      }));
    },
    readTextFile: (path) => {
      const text = files[path];
      if (text === undefined) {
        throw Object.assign(new Error(`ENOENT: ${path}`), {
          code: 'ENOENT',
          path,
        });
      }
      return text;
    },
  };
}

function roleDoc(name: string): string {
  return `---\nrole: ${name}\ntools: [read, ls, find, grep]\nfilesystem: read\nshell: false\nnetwork: none\ngit: false\ncredentials: none\n---\n\n# ${name}\n\n## Prompt\n\nDo ${name} things.\n`;
}

describe('role documents resolve at the project root (issue #229)', () => {
  it('finds a root role document from a subdirectory via projectRoot', () => {
    const bridge = memBridge({
      '/repo/.kubic/roles/scout.md': roleDoc('scout'),
    });
    const selected = selectRole({
      bridge,
      cwd: '/repo/sub/dir',
      projectRoot: '/repo',
      role: 'scout',
    });
    expect(selected.doc.name).toBe('scout');
    expect(selected.markdown).toContain('Do scout things.');
  });

  it('falls back to the cwd without projectRoot (subdir roles stay invisible)', () => {
    const bridge = memBridge({
      '/repo/.kubic/roles/scout.md': roleDoc('scout'),
    });
    expect(() =>
      selectRole({ bridge, cwd: '/repo/sub/dir', role: 'scout' }),
    ).toThrow(/no role document for 'scout'/);
  });

  it('attributes root documents to the repo source in loadRoles', () => {
    const bridge = memBridge({
      '/repo/.kubic/roles/scout.md': roleDoc('scout'),
    });
    const loaded = loadRoles({
      bridge,
      cwd: '/repo/sub',
      projectRoot: '/repo',
    });
    expect(loaded.sources['scout']).toBe('repo');
    expect(loaded.texts['scout']).toContain('Do scout things.');
  });

  it('still loads the embedded presets when the project root has no roles dir', () => {
    const bridge = memBridge({});
    const loaded = loadRoles({
      bridge,
      cwd: '/repo/sub',
      projectRoot: '/repo',
    });
    expect(loaded.docs.length).toBeGreaterThan(0);
    expect(loaded.sources['implementer']).toBe('builtin');
  });
});
