// Role documents resolve at the project root (issue #229; §35.1): a
// `kubic run --role` from a subdirectory finds the same
// `<root>/.kubic/roles/*.md` as one from the root. In-memory bridge only:
// zero network, zero paid tokens.
import { describe, expect, it } from 'vitest';
import {
  loadRoles,
  RoleBootError,
  rolePromptFor,
  rolesDoctorProbe,
  selectRole,
} from './roles-boot.js';

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
describe('one malformed document never blocks the other roles (issue #236)', () => {
  const files = {
    '/repo/.kubic/roles/a.md': roleDoc('a'),
    // No closing fence: unparseable, but role `a` must still resolve.
    '/repo/.kubic/roles/b.md': '---\nrole: b\ntools: [read]\n\n# b\n',
  };
  const input = {
    bridge: memBridge(files),
    cwd: '/repo',
    projectRoot: '/repo',
    trusted: true,
  };

  it('selects the healthy role despite the malformed sibling', () => {
    const selected = selectRole({ ...input, role: 'a' });
    expect(selected.doc.name).toBe('a');
  });

  it('reports the malformed document by name without throwing', () => {
    const loaded = loadRoles(input);
    expect(loaded.docs.map((doc) => doc.name)).toContain('a');
    expect(loaded.invalid).toHaveLength(1);
    expect(loaded.invalid[0]?.path).toContain('b.md');
    expect(loaded.invalid[0]?.reason).toContain('never closed');
  });

  it('fails the malformed document in doctor, naming the file', () => {
    const checks = rolesDoctorProbe(input);
    const bad = checks.filter((check) => check.id === 'role:b');
    expect(bad).toHaveLength(1);
    expect(bad[0]?.status).toBe('fail');
    expect(bad[0]?.detail).toContain('b.md');
    expect(bad[0]?.detail).toContain('never closed');
  });

  it('still refuses selecting the malformed role itself, with the parse error', () => {
    expect(() => selectRole({ ...input, role: 'b' })).toThrow(
      /b\.md.*never closed/,
    );
  });

  it('refuses the malformed name even when a builtin preset shares it', () => {
    // A malformed `planner.md` must not silently fall back to the
    // embedded planner preset — the breakage must surface.
    const shadowed = {
      bridge: memBridge({
        '/repo/.kubic/roles/planner.md': 'not frontmatter at all\n',
      }),
      cwd: '/repo',
      projectRoot: '/repo',
      trusted: true,
    };
    expect(() => selectRole({ ...shadowed, role: 'planner' })).toThrow(
      /planner\.md.*must open with/,
    );
  });
});

describe('the prompt comes from the file that declared the role (issue #293)', () => {
  // roleDocPath is gone: selectRole carries the listed file's own text as
  // `markdown`, so the prompt can never be re-read from `<name>.md`.
  const reviewMd = `---\nrole: reviewer\ntools: [read, ls, find, grep]\nfilesystem: read\nshell: false\nnetwork: none\ngit: false\ncredentials: none\n---\n\n## Prompt\n\nReview from review.md.\n`;
  const input = {
    bridge: memBridge({ '/repo/.kubic/roles/review.md': reviewMd }),
    cwd: '/repo',
    projectRoot: '/repo',
    trusted: true,
  };

  it('boots review.md declaring role: reviewer with review.md prompt body', () => {
    const selected = selectRole({ ...input, role: 'reviewer' });
    expect(selected.doc.name).toBe('reviewer');
    expect(selected.markdown).toContain('Review from review.md.');
  });

  it('never cross-wires the prompt when another file owns <name>.md', () => {
    // reviewer.md declares a DIFFERENT role: selecting `reviewer` must
    // still read review.md's prompt, never reviewer.md's body.
    const crossed = memBridge({
      '/repo/.kubic/roles/review.md': reviewMd,
      '/repo/.kubic/roles/reviewer.md': reviewMd
        .replace('role: reviewer', 'role: other')
        .replace('Review from review.md.', 'WRONG PROMPT from reviewer.md.'),
    });
    const selected = selectRole({
      bridge: crossed,
      cwd: '/repo',
      projectRoot: '/repo',
      trusted: true,
      role: 'reviewer',
    });
    expect(selected.markdown).toContain('Review from review.md.');
    expect(selected.markdown).not.toContain('WRONG PROMPT');
  });
});

describe('duplicate role names are refused by name (issue #236)', () => {
  const files = {
    '/repo/.kubic/roles/first.md': roleDoc('x'),
    '/repo/.kubic/roles/second.md': roleDoc('x'),
    '/repo/.kubic/roles/ok.md': roleDoc('ok'),
  };
  const input = {
    bridge: memBridge(files),
    cwd: '/repo',
    projectRoot: '/repo',
    trusted: true,
  };

  it('reports the duplicate with both files and offers neither copy', () => {
    const loaded = loadRoles(input);
    expect(loaded.duplicates).toEqual([
      {
        name: 'x',
        paths: ['/repo/.kubic/roles/first.md', '/repo/.kubic/roles/second.md'],
      },
    ]);
    // Fail-closed: no copy wins silently, and the healthy role is unaffected.
    expect(loaded.docs.map((doc) => doc.name)).not.toContain('x');
    expect(loaded.docs.map((doc) => doc.name)).toContain('ok');
  });

  it('refuses the duplicated name, listing both files', () => {
    expect(() => selectRole({ ...input, role: 'x' })).toThrow(
      /first\.md.*second\.md|second\.md.*first\.md/,
    );
  });

  it('fails the duplicated name in doctor, listing both files', () => {
    const checks = rolesDoctorProbe(input);
    const dup = checks.filter((check) => check.id === 'role:x');
    expect(dup).toHaveLength(1);
    expect(dup[0]?.status).toBe('fail');
    expect(dup[0]?.detail).toContain('first.md');
    expect(dup[0]?.detail).toContain('second.md');
  });

  it('still selects the healthy role despite the duplicate pair', () => {
    expect(selectRole({ ...input, role: 'ok' }).doc.name).toBe('ok');
  });
});
describe('rolePromptFor refuses instruction-less roles by name (issue #211)', () => {
  const frontmatter =
    '---\nrole: promptless\ntools: [read, ls, find, grep]\nfilesystem: read\nshell: false\nnetwork: none\ngit: false\ncredentials: none\n---\n\n# promptless\n\n';

  function selectedWithBody(body: string): ReturnType<typeof selectRole> {
    const bridge = memBridge({
      '/repo/.kubic/roles/promptless.md': `${frontmatter}${body}`,
    });
    return selectRole({
      bridge,
      cwd: '/repo',
      trusted: true,
      role: 'promptless',
    });
  }

  it("a missing '## Prompt' section names the role", () => {
    const selected = selectedWithBody('Just prose, no prompt heading.\n');
    expect(() => rolePromptFor(selected.doc, selected.markdown)).toThrow(
      RoleBootError,
    );
    expect(() => rolePromptFor(selected.doc, selected.markdown)).toThrow(
      "role 'promptless' has no '## Prompt' section",
    );
  });

  it("an empty '## Prompt' section names the role", () => {
    const selected = selectedWithBody('## Prompt\n\n   \n');
    expect(() => rolePromptFor(selected.doc, selected.markdown)).toThrow(
      RoleBootError,
    );
    expect(() => rolePromptFor(selected.doc, selected.markdown)).toThrow(
      "role 'promptless' has an empty '## Prompt' section",
    );
  });

  it("'## Prompt' followed by '## Notes' returns only the prompt", () => {
    const selected = selectedWithBody(
      '## Prompt\n\nDo the thing.\n\n## Notes\n\nLater notes.\n',
    );
    expect(rolePromptFor(selected.doc, selected.markdown)).toBe(
      'Do the thing.',
    );
  });

  it('trims surrounding whitespace', () => {
    const selected = selectedWithBody('## Prompt\n\n   Do the thing.   \n');
    expect(rolePromptFor(selected.doc, selected.markdown)).toBe(
      'Do the thing.',
    );
  });
});

describe('selectRole unknown roles (issue #211)', () => {
  it('lists the loaded names in the refusal', () => {
    const bridge = memBridge({
      '/repo/.kubic/roles/scout.md': roleDoc('scout'),
    });
    expect(() =>
      selectRole({ bridge, cwd: '/repo', trusted: true, role: 'ghost' }),
    ).toThrow(/no role document for 'ghost' under \.kubic\/roles/);
    try {
      selectRole({ bridge, cwd: '/repo', trusted: true, role: 'ghost' });
      expect.unreachable('selectRole(ghost) must throw');
    } catch (error) {
      const message = (error as Error).message;
      expect(message).toContain('(loaded: ');
      expect(message).toContain('scout');
      expect(message).toContain('implementer');
    }
  });
});
