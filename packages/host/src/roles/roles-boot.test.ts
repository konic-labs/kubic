// Role documents resolve at the project root: a
// `kubic run --role` from a subdirectory finds the same
// `<root>/.kubic/roles/*.md` as one from the root. In-memory bridge only:
// zero network, zero paid tokens.
import { describe, expect, it } from 'vitest';
import type { RoleLayerInput } from './resolver.js';
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

describe('role documents resolve at the project root', () => {
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
    expect(loaded.sources.scout).toBe('repo');
    expect(loaded.texts.scout).toContain('Do scout things.');
  });

  it('still loads the embedded presets when the project root has no roles dir', () => {
    const bridge = memBridge({});
    const loaded = loadRoles({
      bridge,
      cwd: '/repo/sub',
      projectRoot: '/repo',
    });
    expect(loaded.docs.length).toBeGreaterThan(0);
    expect(loaded.sources.implementer).toBe('builtin');
  });
});

describe('project role documents are trust-gated', () => {
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
    expect(loaded.sources.scout).toBeUndefined();
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
describe('one malformed document never blocks the other roles', () => {
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

describe('doctor judges roles under the same config layers as the run', () => {
  const docX =
    '---\nrole: x\ntools: [read, ls, find, grep]\nfilesystem: read\nshell: false\nnetwork: none\ngit: false\ncredentials: none\n---\n\n## Prompt\n\nDo x things.\n';
  const base = {
    bridge: memBridge({ '/repo/.kubic/roles/x.md': docX }),
    cwd: '/repo',
    projectRoot: '/repo',
    trusted: true,
  };

  it('a layer contradicting the document fails doctor with the run refusal, word for word', () => {
    // Typed as the loader's own input: `as const` would freeze the tool
    // lists readonly, which RoleLayerSpec does not accept.
    const layers: RoleLayerInput[] = [
      { layer: 'project', roles: { x: { tools: ['read', 'write'] } } },
    ];
    const input = { ...base, layers };
    // The run refusal: selectRole resolves under the same layers.
    let runReason = '';
    try {
      selectRole({ ...input, role: 'x' });
    } catch (error) {
      runReason = (error as Error).message;
    }
    expect(runReason).toMatch(/filesystem.*read.*write/i);
    // Doctor fails the same role with the identical reason.
    const fail = rolesDoctorProbe(input).find((check) => check.id === 'role:x');
    expect(fail?.status).toBe('fail');
    expect(fail?.detail).toBe(runReason);
  });

  it('a layer fixing an otherwise-invalid document makes doctor pass it', () => {
    const broken = {
      bridge: memBridge({
        '/repo/.kubic/roles/y.md': docX
          .replace('role: x', 'role: y')
          .replace('tools: [read, ls, find, grep]', 'tools: [write]'),
      }),
      cwd: '/repo',
      projectRoot: '/repo',
      trusted: true,
    };
    // Alone the document contradicts its own classes: refused both ways.
    expect(() => selectRole({ ...broken, role: 'y' })).toThrow(
      /filesystem.*read.*write/i,
    );
    expect(
      rolesDoctorProbe(broken).find((check) => check.id === 'role:y')?.status,
    ).toBe('fail');
    // The layer narrows the tool away: run and doctor agree it is fine.
    const fixed = {
      ...broken,
      layers: [
        { layer: 'project', roles: { y: { tools: ['read'] } } },
      ] as RoleLayerInput[],
    };
    expect(selectRole({ ...fixed, role: 'y' }).doc.name).toBe('y');
    expect(
      rolesDoctorProbe(fixed).find((check) => check.id === 'role:y')?.status,
    ).toBe('pass');
  });
});

describe('the prompt comes from the file that declared the role', () => {
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

describe('duplicate role names are refused by name', () => {
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
describe('rolePromptFor refuses instruction-less roles by name', () => {
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

describe('global ~/.kubic/roles layer', () => {
  const HOME = '/home';
  const globalDoc = (name: string): Record<string, string> => ({
    [`${HOME}/.kubic/roles/${name}.md`]: roleDoc(name),
  });

  it('resolves a role defined only in the global dir, with no trust flags', () => {
    const bridge = memBridge(globalDoc('scout'));
    const selected = selectRole({
      bridge,
      cwd: '/repo',
      home: HOME,
      role: 'scout',
    });
    expect(selected.doc.name).toBe('scout');
    expect(selected.source).toBe('global');
    expect(selected.markdown).toContain('Do scout things.');
  });

  it('a project document with the same name wins over the global one', () => {
    const bridge = memBridge({
      ...globalDoc('scout'),
      '/repo/.kubic/roles/scout.md': roleDoc('scout').replace(
        'Do scout things.',
        'Do project scout things.',
      ),
    });
    const loaded = loadRoles({
      bridge,
      cwd: '/repo',
      projectRoot: '/repo',
      trusted: true,
      home: HOME,
    });
    expect(loaded.sources.scout).toBe('repo');
    expect(loaded.texts.scout).toContain('Do project scout things.');
  });

  it('a global document overrides the builtin preset of the same name', () => {
    const bridge = memBridge({
      [`${HOME}/.kubic/roles/reviewer.md`]: roleDoc('reviewer'),
    });
    const loaded = loadRoles({ bridge, cwd: '/repo', home: HOME });
    expect(loaded.sources.reviewer).toBe('global');
    expect(loaded.texts.reviewer).toContain('Do reviewer things.');
  });

  it('an absent global dir is silent: builtins still resolve', () => {
    const bridge = memBridge({});
    const loaded = loadRoles({ bridge, cwd: '/repo', home: HOME });
    expect(loaded.sources.reviewer).toBe('builtin');
    expect(loaded.docs.some((doc) => doc.name === 'reviewer')).toBe(true);
  });

  it('an unreadable global document names its own path', () => {
    const bad = `${HOME}/.kubic/roles/bad.md`;
    const bridge = memBridge(globalDoc('scout'));
    const throwing = {
      ...bridge,
      readTextFile: (path: string): string => {
        if (path === bad) throw new Error('EACCES: permission denied');
        return bridge.readTextFile(path);
      },
      listDir: (dir: string) => [
        ...bridge.listDir(dir),
        ...(dir === `${HOME}/.kubic/roles`
          ? [
              {
                name: 'bad.md',
                path: bad,
                isDirectory: false,
                isSymbolicLink: false,
                size: 0,
                mtimeMs: 0,
              },
            ]
          : []),
      ],
    };
    expect(() =>
      loadRoles({ bridge: throwing, cwd: '/repo', home: HOME }),
    ).toThrow(new RegExp(`role document ${bad} is unreadable`));
  });

  it('the doctor probe lists a global role with its source', () => {
    const bridge = memBridge(globalDoc('scout'));
    const checks = rolesDoctorProbe({ bridge, cwd: '/repo', home: HOME });
    const check = checks.find((entry) => entry.id === 'role:scout');
    expect(check?.status).toBe('pass');
    expect(check?.detail).toContain('global role');
  });

  it('an untrusted root still loads the global layer (trust gates repo only)', () => {
    const bridge = memBridge({
      ...globalDoc('scout'),
      '/repo/.kubic/roles/held.md': roleDoc('held'),
    });
    const loaded = loadRoles({ bridge, cwd: '/repo', home: HOME });
    expect(loaded.sources.scout).toBe('global');
    expect(loaded.withheld.map((entry) => entry.name)).toContain('held');
    expect(loaded.sources.held).toBeUndefined();
  });

  it('a malformed global document is recorded, never aborting the load', () => {
    // Same per-document rules as the repo layer: the parse
    // failure is recorded with its stem and path, the healthy global
    // role still resolves, selecting the bad stem refuses.
    const bridge = memBridge({
      ...globalDoc('scout'),
      [`${HOME}/.kubic/roles/b.md`]: '---\nrole: b\ntools: [read]\n\n# b\n',
    });
    const input = { bridge, cwd: '/repo', home: HOME };
    const loaded = loadRoles(input);
    expect(loaded.sources.scout).toBe('global');
    expect(loaded.invalid).toHaveLength(1);
    expect(loaded.invalid[0]?.path).toContain('b.md');
    expect(loaded.invalid[0]?.reason).toContain('never closed');
    expect(() => selectRole({ ...input, role: 'b' })).toThrow(
      /b\.md.*never closed/,
    );
  });

  it('two global documents declaring one name are a fork: refused by name', () => {
    const bridge = memBridge({
      [`${HOME}/.kubic/roles/first.md`]: roleDoc('x'),
      [`${HOME}/.kubic/roles/second.md`]: roleDoc('x'),
      ...globalDoc('scout'),
    });
    const input = { bridge, cwd: '/repo', home: HOME };
    const loaded = loadRoles(input);
    expect(loaded.duplicates).toEqual([
      {
        name: 'x',
        paths: [
          `${HOME}/.kubic/roles/first.md`,
          `${HOME}/.kubic/roles/second.md`,
        ],
      },
    ]);
    // Fail-closed: no copy wins, and the healthy global role is unaffected.
    expect(loaded.docs.map((doc) => doc.name)).not.toContain('x');
    expect(selectRole({ ...input, role: 'scout' }).doc.name).toBe('scout');
    expect(() => selectRole({ ...input, role: 'x' })).toThrow(
      /first\.md.*second\.md/,
    );
  });

  it('a repo fork poisons the name even when the global copy is unique', () => {
    // A name forked in EITHER layer resolves to nothing: an ambiguous
    // project layer never silently falls back to the global copy — not
    // even when a builtin preset shares the name.
    const bridge = memBridge({
      ...globalDoc('scout'),
      '/repo/.kubic/roles/first.md': roleDoc('scout'),
      '/repo/.kubic/roles/second.md': roleDoc('scout'),
    });
    const input = {
      bridge,
      cwd: '/repo',
      projectRoot: '/repo',
      trusted: true,
      home: HOME,
    };
    const loaded = loadRoles(input);
    expect(loaded.duplicates.map((dup) => dup.name)).toEqual(['scout']);
    expect(() => selectRole({ ...input, role: 'scout' })).toThrow(/ambiguous/);
  });
});

describe('selectRole unknown roles', () => {
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
