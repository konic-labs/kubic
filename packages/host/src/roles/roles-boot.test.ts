// Role documents resolve at the project root (issue #229; §35.1): a
// `kubic run --role` from a subdirectory finds the same
// `<root>/.kubic/roles/*.md` as one from the root. In-memory bridge only:
// zero network, zero paid tokens.
import { describe, expect, it } from 'vitest';
import { loadRoles, rolesDoctorProbe, selectRole } from './roles-boot.js';

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
      trusted: true,
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
      trusted: true,
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

describe('project role documents are trust-gated (issue #430, §33)', () => {
  const files = {
    '/repo/.kubic/roles/scout.md':
      '---\nrole: scout\ntools: [read, ls, find, grep]\nfilesystem: read\nshell: false\nnetwork: none\ngit: false\ncredentials: none\n---\n\n# scout\n\n## Prompt\n\nDo scout things.\n',
  };

  it('withholds repo documents from an untrusted root, naming them', () => {
    const loaded = loadRoles({
      bridge: memBridge(files),
      cwd: '/repo/sub',
      projectRoot: '/repo',
    });
    expect(loaded.docs.map((doc) => doc.name)).not.toContain('scout');
    expect(loaded.sources['scout']).toBeUndefined();
    expect(loaded.withheld).toEqual([
      {
        name: 'scout',
        reason: expect.stringContaining('withheld: untrusted project root'),
      },
    ]);
  });

  it('refuses --role naming a withheld document with the trust message', () => {
    expect(() =>
      selectRole({
        bridge: memBridge(files),
        cwd: '/repo/sub',
        projectRoot: '/repo',
        role: 'scout',
      }),
    ).toThrow(/withheld: untrusted project root/);
  });

  it('still resolves the builtins from an untrusted root', () => {
    const selected = selectRole({
      bridge: memBridge(files),
      cwd: '/repo/sub',
      projectRoot: '/repo',
      role: 'implementer',
    });
    expect(selected.source).toBe('builtin');
  });

  it('loads repo documents when trusted, by flag or per-path check', () => {
    for (const trust of [
      { trusted: true },
      { trustProject: () => true },
    ] as const) {
      const selected = selectRole({
        bridge: memBridge(files),
        cwd: '/repo/sub',
        projectRoot: '/repo',
        ...trust,
        role: 'scout',
      });
      expect(selected.source).toBe('repo');
    }
    const loaded = loadRoles({
      bridge: memBridge(files),
      cwd: '/repo/sub',
      projectRoot: '/repo',
      trustProject: () => false,
    });
    expect(loaded.withheld.map((entry) => entry.name)).toEqual(['scout']);
  });

  it('names withheld roles in the doctor probe as warnings', () => {
    const checks = rolesDoctorProbe({
      bridge: memBridge(files),
      cwd: '/repo/sub',
      projectRoot: '/repo',
    });
    const held = checks.filter((check) => check.id === 'role:scout');
    expect(held).toHaveLength(1);
    expect(held[0]?.status).toBe('warn');
    expect(held[0]?.detail).toContain('withheld: untrusted project root');
  });
});
