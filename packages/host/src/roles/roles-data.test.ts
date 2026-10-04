// Built-in roles as data — loader test (issue #44; §12, §38.2, §71).
// Reads the real `.kubic/roles/*.md` documents through the issue-#43
// resolver (read-only) and proves: all five validate, the spawn matrix
// matches the §12 tool sets, reviewer read-only-ness holds by tool
// absence, unknown roles fail the spawn, and per-role model defaults
// resolve (overridable via [roles.<r>].model / spawn_agent({model})).
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  createRoleToolGuard,
  loadRoleDocuments,
  type ParsedRoleDoc,
  resolveRole,
  roleDoctorChecks,
  validateResolvedRole,
} from './resolver.js';
import {
  BUILTIN_ROLE_NAMES,
  ROLE_THINKING_DEFAULTS,
  spawnForRole,
} from './roles-data.js';

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
  const found = docs.find((doc) => doc.name === name);
  if (found === undefined) throw new Error(`missing role document '${name}'`);
  return found;
}

describe('built-in role documents (issue #44)', () => {
  it('loads exactly the five built-in roles from .kubic/roles/*.md', () => {
    const docs = loadRoleDocuments(nodeBridge(), ROLES_DIR);
    // Sorted by filename (loader contract: deterministic), covering the
    // five built-ins exactly once.
    expect(docs.map((doc) => doc.name)).toEqual([
      'debugger',
      'implementer',
      'planner',
      'reviewer',
      'tester',
    ]);
    expect(new Set(docs.map((doc) => doc.name))).toEqual(
      new Set(BUILTIN_ROLE_NAMES),
    );
  });

  it('every role resolves and validates; doctor passes clean', () => {
    const docs = loadRoleDocuments(nodeBridge(), ROLES_DIR);
    const resolved = docs.map((doc) => resolveRole(doc, []));
    for (const role of resolved) {
      expect(() => validateResolvedRole(role)).not.toThrow();
    }
    const checks = roleDoctorChecks(resolved);
    expect(checks).toHaveLength(5);
    for (const check of checks) {
      expect(check).toMatchObject({ status: 'pass', reason: 'ok' });
    }
  });
});

describe('spawn matrix (§12 tool sets)', () => {
  it('planner is read-only: no write/edit/bash/git tools', () => {
    const docs = loadRoleDocuments(nodeBridge(), ROLES_DIR);
    const planner = resolveRole(docNamed(docs, 'planner'), []);
    expect(planner.tools).toContain('read');
    for (const banned of [
      'write',
      'edit',
      'bash',
      'git_status',
      'git_commit',
    ]) {
      expect(planner.tools).not.toContain(banned);
    }
  });

  it('reviewer is read-only: no write/edit/commit/bash tools', () => {
    const docs = loadRoleDocuments(nodeBridge(), ROLES_DIR);
    const reviewer = resolveRole(docNamed(docs, 'reviewer'), []);
    expect(reviewer.tools).toContain('read');
    expect(reviewer.tools).toContain('git_diff');
    for (const banned of ['write', 'edit', 'bash', 'git_commit']) {
      expect(reviewer.tools).not.toContain(banned);
    }
  });

  it('implementer, tester, and debugger hold write + bash tools', () => {
    const docs = loadRoleDocuments(nodeBridge(), ROLES_DIR);
    for (const name of ['implementer', 'tester', 'debugger']) {
      const resolved = resolveRole(docNamed(docs, name), []);
      expect(resolved.tools).toContain('write');
      expect(resolved.tools).toContain('bash');
    }
  });

  it('reviewer write calls fail tool-absent, never approval-gated', () => {
    const docs = loadRoleDocuments(nodeBridge(), ROLES_DIR);
    const reviewer = resolveRole(docNamed(docs, 'reviewer'), []);
    const guard = createRoleToolGuard(reviewer.name, reviewer.tools);
    const verdict = guard({
      toolCallId: 'call-1',
      toolName: 'write',
      args: { path: 'notes.txt' },
    });
    expect(verdict).toEqual({
      block: {
        reason: expect.stringContaining('tool-absent'),
        terminate: false,
      },
    });
    expect((verdict as { block: { reason: string } }).block.reason).not.toMatch(
      /approval/i,
    );
  });
});

describe('role spawn (unknown role, model defaults, overrides)', () => {
  it('unknown role fails the spawn with a named reason', () => {
    const docs = loadRoleDocuments(nodeBridge(), ROLES_DIR);
    const outcome = spawnForRole({
      role: 'teleporter',
      docs,
      sessionId: 'child-1',
      parentSessionId: 'parent-1',
      worktree: '/tmp/wt-child-1',
    });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.code).toBe('SPAWN_FAILED');
      expect(outcome.reason).toMatch(/unknown role 'teleporter'/);
    }
  });

  it('refuses the spawn when no level resolved a model (issue #202)', () => {
    // §38.1: the model comes from spawn_agent({model}), [roles.<r>].model or
    // the manager's own model — never a hardcoded provider. A caller with
    // none of them gets a named refusal, not `local/llama3`.
    const docs = loadRoleDocuments(nodeBridge(), ROLES_DIR);
    const outcome = spawnForRole({
      role: 'reviewer',
      docs,
      sessionId: 'child-reviewer',
      parentSessionId: 'parent-1',
      worktree: '/tmp/wt-child-1',
    });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.code).toBe('SPAWN_FAILED');
      expect(outcome.reason).toMatch(/no model for role 'reviewer'/);
      expect(outcome.reason).not.toMatch(/local/);
    }
  });

  it('resolves the model as spawn override > [roles.<r>].model > the manager model (issue #202)', () => {
    const docs = loadRoleDocuments(nodeBridge(), ROLES_DIR);
    // The manager's model is the fallback level, with the role's own thinking
    // default — the role preset no longer names a provider.
    for (const name of BUILTIN_ROLE_NAMES) {
      const outcome = spawnForRole({
        role: name,
        docs,
        sessionId: `child-${name}`,
        parentSessionId: 'parent-1',
        worktree: '/tmp/wt-child-1',
        parentModel: 'acme/m0',
      });
      expect(outcome.ok).toBe(true);
      if (outcome.ok) {
        expect(outcome.spec.role).toBe(name);
        expect(outcome.spec.model).toMatchObject({
          provider: 'acme',
          model: 'm0',
          thinking: ROLE_THINKING_DEFAULTS[name],
        });
      }
    }
  });

  it('[roles.<r>].model overrides the manager model, keeping the role thinking default', () => {
    const docs = loadRoleDocuments(nodeBridge(), ROLES_DIR);
    const outcome = spawnForRole({
      role: 'reviewer',
      docs,
      sessionId: 'child-reviewer',
      parentSessionId: 'parent-1',
      worktree: '/tmp/wt-child-1',
      parentModel: 'acme/m0',
      configModel: 'acme/m2',
    });
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.spec.model.provider).toBe('acme');
      expect(outcome.spec.model.model).toBe('m2');
      expect(outcome.spec.model.thinking).toBe(ROLE_THINKING_DEFAULTS.reviewer);
    }
  });

  it('spawn_agent({model}) beats the config override and stays in scope', () => {
    const docs = loadRoleDocuments(nodeBridge(), ROLES_DIR);
    const outcome = spawnForRole({
      role: 'reviewer',
      docs,
      sessionId: 'child-reviewer',
      parentSessionId: 'parent-1',
      worktree: '/tmp/wt-child-1',
      configModel: 'acme/m2',
      taskModel: { provider: 'acme', model: 'm9', thinking: 'high' },
    });
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.spec.model).toMatchObject({
        provider: 'acme',
        model: 'm9',
        thinking: 'high',
      });
    }
  });
});
