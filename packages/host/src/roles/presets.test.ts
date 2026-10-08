// The five shipped role presets, pinned to the table.
//
// The presets are the documents in `builtin-presets.ts`. This test loads them
// through the real resolver and compares each one's
// resolved tool set and permission classes to the table below — a literal
// fixture, so a preset drifting from the design fails here instead of in a
// lane at runtime. Deviations are deliberate (the git levels are
// `false`, `workspace`, `full`; the read-only shell level is the shipped
// spelling of reviewer/planner `shell: true`; the level itself is the closed
// allowlist).
import { describe, expect, it } from 'vitest';
import type { PermissionClasses } from '../../../agents/src/policy.js';
import { BUILTIN_ROLE_NAMES, BUILTIN_ROLE_PRESETS } from './builtin-presets.js';
import {
  type ParsedRoleDoc,
  parseRoleDocument,
  resolveRole,
} from './resolver.js';

function docNamed(docs: ParsedRoleDoc[], name: string): ParsedRoleDoc {
  const doc = docs.find((entry) => entry.name === name);
  if (doc === undefined) throw new Error(`no role document for '${name}'`);
  return doc;
}

interface Preset {
  tools: string[];
  classes: PermissionClasses;
}

// As shipped. Tools are the resolver's own sorted,
// deduped set.
const TABLE: Record<string, Preset> = {
  // Read, grep, find, ls; filesystem read, shell
  // read-only-allowlist, git false. The read-only shell is what makes the
  // "read-only inspection commands" capability safe (the closed
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
  // Full coding set; workspace-write, shell true, git
  // `workspace`.
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
  // Workspace-write, shell true, git false — so the tester runs tests
  // and fixes them, and holds no git tool (read-only or writer): git state
  // changes are the implementer's, never a test run's.
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
  // The debugger gets the full coding set and has no class row of its own,
  // so it follows the implementer's classes.
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
  // Read, grep, find, ls, bash (read-only checks); filesystem
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

describe('shipped role presets match the table', () => {
  const docs = [...BUILTIN_ROLE_NAMES]
    .sort()
    .map((name) => parseRoleDocument(BUILTIN_ROLE_PRESETS[name]));

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

  // The embedded text is what a workspace with no roles directory runs, so the
  // same table must hold for the parsed text directly as well.
  describe('the copy embedded in the binary', () => {
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
    // 's reviewer runs "targeted checks" and the planner "read-only
    // inspection commands": both need bash, and both must be blocked from
    // writing through it (the allowlist is what enforces that).
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
