// The five shipped role presets, pinned to the §12/§12.1 table (issue #157).
//
// `.kubic/roles/*.md` is the reviewable source of the presets, so this test
// loads the REAL documents through the REAL resolver and compares each one's
// resolved tool set and permission classes to the table below — a literal
// fixture, so a preset drifting from the design fails here instead of in a
// lane at runtime. Deviations from §12.1 are deliberate and each one names
// its drift entry (docs/design-drift.md row 23 for the git vocabulary; the
// read-only shell level is the shipped spelling of §12.1's reviewer/planner
// `shell: true` — the issue that moved them there is #157, and the level
// itself is #161's closed allowlist).
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { PermissionClasses } from '../../../agents/src/policy.js';
import { BUILTIN_ROLE_PRESETS } from './builtin-presets.js';
import {
  loadRoleDocuments,
  type ParsedRoleDoc,
  parseRoleDocument,
  resolveRole,
} from './resolver.js';

const ROLES_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
  '..',
  '.kubic',
  'roles',
);

function nodeBridge(): {
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
    listDir: (dir) =>
      readdirSync(dir, { withFileTypes: true }).map((entry) => ({
        name: entry.name,
        path: join(dir, entry.name),
        isDirectory: entry.isDirectory(),
        isSymbolicLink: entry.isSymbolicLink(),
        size: 0,
        mtimeMs: 0,
      })),
    readTextFile: (path) => readFileSync(path, 'utf8'),
  };
}

function docNamed(docs: ParsedRoleDoc[], name: string): ParsedRoleDoc {
  const doc = docs.find((entry) => entry.name === name);
  if (doc === undefined) throw new Error(`no role document for '${name}'`);
  return doc;
}

interface Preset {
  tools: string[];
  classes: PermissionClasses;
}

// §12/§12.1, as shipped (issue #157). Tools are the resolver's own sorted,
// deduped set.
const TABLE: Record<string, Preset> = {
  // §12: read, grep, find, ls; §12.1: filesystem read, shell
  // read-only-allowlist, git false. The read-only shell is what makes the
  // "read-only inspection commands" capability safe (issue #161's closed
  // allowlist), and it is how the planner reads git state.
  planner: {
    tools: ['bash', 'find', 'grep', 'ls', 'read'],
    classes: {
      filesystem: 'read',
      shell: 'read-only-allowlist',
      network: 'none',
      git: false,
      credentials: 'none',
    },
  },
  // §12: full coding set; §12.1: workspace-write, shell true, git
  // `worktree` — shipped as `workspace` (drift row 23: the level is spelled
  // `workspace`, and in orchestrator mode the workspace IS the worktree).
  implementer: {
    tools: [
      'bash',
      'edit',
      'find',
      'git_branch',
      'git_checkpoint',
      'git_commit',
      'git_diff',
      'git_log',
      'git_show',
      'git_stage',
      'git_status',
      'grep',
      'ls',
      'read',
      'write',
    ],
    classes: {
      filesystem: 'workspace-write',
      shell: true,
      network: 'none',
      git: 'workspace',
      credentials: 'none',
    },
  },
  // §12.1: workspace-write, shell true, git false — so the tester runs tests
  // and fixes them, and holds no git tool (read-only or writer): git state
  // changes are the implementer's or the manager's, never a test run's.
  tester: {
    tools: ['bash', 'edit', 'find', 'grep', 'ls', 'read', 'write'],
    classes: {
      filesystem: 'workspace-write',
      shell: true,
      network: 'none',
      git: false,
      credentials: 'none',
    },
  },
  // §12 gives the debugger the full coding set; §12.1 has no debugger row,
  // so it follows the implementer's classes (drift: named here, not in the
  // table).
  debugger: {
    tools: [
      'bash',
      'edit',
      'find',
      'git_branch',
      'git_checkpoint',
      'git_diff',
      'git_log',
      'git_show',
      'git_stage',
      'git_status',
      'grep',
      'ls',
      'read',
      'write',
    ],
    classes: {
      filesystem: 'workspace-write',
      shell: true,
      network: 'none',
      git: 'workspace',
      credentials: 'none',
    },
  },
  // §12: read, grep, find, ls, bash (read-only checks); §12.1: filesystem
  // read, git false. The reviewer runs its targeted checks through the
  // read-only shell — including `git status/diff/log/show`, which the
  // allowlist admits — and holds no writer tool.
  reviewer: {
    tools: ['bash', 'find', 'grep', 'ls', 'read'],
    classes: {
      filesystem: 'read',
      shell: 'read-only-allowlist',
      network: 'none',
      git: false,
      credentials: 'none',
    },
  },
};

describe('shipped role presets match §12/§12.1 (issue #157)', () => {
  const docs = loadRoleDocuments(nodeBridge(), ROLES_DIR);

  it('ships exactly the five presets the table names', () => {
    expect(docs.map((doc) => doc.name).sort()).toEqual(
      Object.keys(TABLE).sort(),
    );
  });

  it.each(Object.keys(TABLE))(
    "resolves '%s' to the table's tools and classes",
    (name) => {
      const expected = TABLE[name] as Preset;
      const resolved = resolveRole(docNamed(docs, name), []);
      expect([...resolved.tools].sort()).toEqual([...expected.tools].sort());
      expect(resolved.classes).toEqual(expected.classes);
    },
  );

  // The SAME pin for the copy that ships inside the binary (issue #203):
  // `.kubic/roles/*.md` is the reviewable source, but a workspace with no
  // roles directory runs `builtin-presets.ts`, so that text must match the
  // table too — and match the documents byte for byte, or the two copies
  // drift with every gate green.
  describe('the copy embedded in the binary (issue #203)', () => {
    it('is byte-identical to .kubic/roles/*.md', () => {
      for (const doc of docs) {
        expect(
          BUILTIN_ROLE_PRESETS[doc.name as keyof typeof BUILTIN_ROLE_PRESETS],
        ).toBe(nodeBridge().readTextFile(`${ROLES_DIR}/${doc.name}.md`));
      }
    });

    it.each(Object.keys(TABLE))(
      "resolves the embedded '%s' to the table's tools and classes",
      (name) => {
        const expected = TABLE[name] as Preset;
        const text =
          BUILTIN_ROLE_PRESETS[name as keyof typeof BUILTIN_ROLE_PRESETS];
        const resolved = resolveRole(parseRoleDocument(text), []);
        expect([...resolved.tools].sort()).toEqual([...expected.tools].sort());
        expect(resolved.classes).toEqual(expected.classes);
      },
    );
  });

  it('keeps the read-only roles on a shell level that can actually read', () => {
    // §12's reviewer runs "targeted checks" and the planner "read-only
    // inspection commands": both need bash, and both must be blocked from
    // writing through it (issue #161's allowlist is what enforces that).
    for (const name of ['planner', 'reviewer']) {
      const resolved = resolveRole(docNamed(docs, name), []);
      expect(resolved.classes.shell).toBe('read-only-allowlist');
      expect(resolved.tools).toContain('bash');
    }
  });

  it('keeps every preset free of a tool its classes forbid', () => {
    for (const doc of docs) {
      const resolved = resolveRole(doc, []);
      if (resolved.classes.git === false) {
        expect(
          resolved.tools.filter((tool) => tool.startsWith('git_')),
        ).toEqual([]);
      }
      if (resolved.classes.filesystem === 'read') {
        expect(
          resolved.tools.filter((tool) => tool === 'write' || tool === 'edit'),
        ).toEqual([]);
      }
    }
  });
});
