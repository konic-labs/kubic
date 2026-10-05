// Role resolver tests (issue #43): per-role tool filtering + policy
// validation. Fixture role documents are inline strings — never real
// filesystem roles (role contents land in issue #44).
import { describe, expect, it } from 'vitest';
import {
  applyRoleToLane,
  createRolePolicyGuard,
  createRoleToolGuard,
  loadRoleDocuments,
  mergeRoleLayers,
  parseRoleDocument,
  RoleRefusedError,
  resolveRole,
  roleDebugLine,
  roleDoctorChecks,
  validateResolvedRole,
} from './resolver.js';

const PLANNER_MD = `---
role: planner
tools: [read, ls, find, grep]
filesystem: read
shell: false
network: none
git: false
credentials: none
---
# Planner
Plans only.
`;

describe('parseRoleDocument', () => {
  it('parses role name, tools, and tool_policy classes from frontmatter', () => {
    const doc = parseRoleDocument(PLANNER_MD);
    expect(doc.name).toBe('planner');
    expect(doc.tools).toEqual(['read', 'ls', 'find', 'grep']);
    expect(doc.skills).toBeUndefined();
    expect(doc.classes).toMatchObject({
      filesystem: 'read',
      shell: false,
      network: 'none',
      git: false,
      credentials: 'none',
    });
  });

  // Issue #181 (§29.4): a role document may declare the skills it sees.
  it("parses the role document's skills list", () => {
    const doc = parseRoleDocument(
      `---\nrole: reviewer\nskills: [diff-skill, lint-skill]\n---\n# Reviewer\n`,
    );
    expect(doc.name).toBe('reviewer');
    expect(doc.skills).toEqual(['diff-skill', 'lint-skill']);
  });
});

const REVIEWER_MD = `---
role: reviewer
tools: [read, ls, find, grep, git_status, git_diff, git_log, git_show]
filesystem: read
shell: false
network: none
git: workspace
credentials: none
---
# Reviewer
Reviews only.
`;

describe('mergeRoleLayers', () => {
  it('enterprise tools win over agent tools; attempts are reported', () => {
    const doc = parseRoleDocument(PLANNER_MD);
    const merged = mergeRoleLayers(doc, [
      { layer: 'agent', roles: { planner: { tools: ['read', 'write'] } } },
      { layer: 'enterprise', roles: { planner: { tools: ['read'] } } },
    ]);
    expect(merged.tools).toEqual(['read']);
    expect(merged.overriddenAttempts).toContain('roles.planner.tools');
  });

  it('per-class keys merge first-wins with the doc as fallback', () => {
    const doc = parseRoleDocument(PLANNER_MD);
    const merged = mergeRoleLayers(doc, [
      {
        layer: 'agent',
        roles: { planner: { classes: { shell: true, network: 'full' } } },
      },
      {
        layer: 'enterprise',
        roles: { planner: { classes: { network: 'none' } } },
      },
    ]);
    expect(merged.classes.network).toBe('none');
    expect(merged.classes.shell).toBe(true);
    expect(merged.overriddenAttempts).toContain(
      'roles.planner.tool_policy.network',
    );
  });

  it('model pins merge first-wins; attempts are reported (issue #133)', () => {
    const doc = parseRoleDocument(PLANNER_MD);
    const merged = mergeRoleLayers(doc, [
      { layer: 'agent', roles: { planner: { model: 'local/llama3' } } },
      { layer: 'enterprise', roles: { planner: { model: 'acme/big' } } },
    ]);
    expect(merged.model).toBe('acme/big');
    expect(merged.overriddenAttempts).toContain('roles.planner.model');
    // No layer sets one: the merge invents nothing.
    expect(mergeRoleLayers(doc, []).model).toBeUndefined();
  });
});

describe('resolveRole', () => {
  it('planner resolves with no write/edit tools', () => {
    const resolved = resolveRole(parseRoleDocument(PLANNER_MD), []);
    expect(resolved.tools).not.toContain('write');
    expect(resolved.tools).not.toContain('edit');
    expect(resolved.tools).toContain('read');
  });

  it('reviewer resolves with no write/edit/commit tools', () => {
    const resolved = resolveRole(parseRoleDocument(REVIEWER_MD), []);
    expect(resolved.tools).not.toContain('write');
    expect(resolved.tools).not.toContain('edit');
    expect(resolved.tools).not.toContain('git_commit');
  });

  it('contradictory roles (filesystem read + write tool) are refused with reason', () => {
    const doc = parseRoleDocument(PLANNER_MD);
    const resolved = resolveRole({ ...doc, tools: ['read', 'write'] }, [], {
      validate: false,
    });
    expect(() => validateResolvedRole(resolved)).toThrow(RoleRefusedError);
    expect(() => validateResolvedRole(resolved)).toThrow(
      /filesystem.*read.*write/i,
    );
  });

  it('unknown tools are refused fail-closed', () => {
    const doc = parseRoleDocument(PLANNER_MD);
    const resolved = resolveRole({ ...doc, tools: ['read', 'teleport'] }, [], {
      validate: false,
    });
    expect(() => validateResolvedRole(resolved)).toThrow(
      /unknown tool 'teleport'/,
    );
  });
});

describe('enterprise policy on role grants (issue #288)', () => {
  const IMPLEMENTER_MD = `---
role: implementer
tools: [read, write, edit, bash]
filesystem: workspace-write
shell: true
network: none
git: false
credentials: none
---
# Implementer
Writes code.
`;

  it('refuses a role declaring an enterprise-denied tool, naming the reason', async () => {
    const { resolveEffectivePolicy } = await import('../policy/enterprise.js');
    const policy = resolveEffectivePolicy([
      { layer: 'enterprise', policy: { tools: { deny: ['bash'] } } },
    ]).policy;
    const doc = parseRoleDocument(IMPLEMENTER_MD);
    expect(() => resolveRole(doc, [], { toolPolicy: policy })).toThrow(
      RoleRefusedError,
    );
    expect(() => resolveRole(doc, [], { toolPolicy: policy })).toThrow(
      /'bash'.*denied.*enterprise denial holds/,
    );
  });

  it('refuses a role tool outside an enterprise allow list, never widening it', async () => {
    const { resolveEffectivePolicy } = await import('../policy/enterprise.js');
    const policy = resolveEffectivePolicy([
      {
        layer: 'enterprise',
        policy: { tools: { allow: ['read', 'write', 'edit'] } },
      },
    ]).policy;
    const doc = parseRoleDocument(IMPLEMENTER_MD);
    expect(() => resolveRole(doc, [], { toolPolicy: policy })).toThrow(
      /'bash' denied/,
    );
  });

  it('keeps a role whose tools the policy allows, never adding any', async () => {
    const { resolveEffectivePolicy } = await import('../policy/enterprise.js');
    const policy = resolveEffectivePolicy([
      {
        layer: 'enterprise',
        policy: { tools: { allow: ['read', 'ls', 'find', 'grep'] } },
      },
    ]).policy;
    const resolved = resolveRole(parseRoleDocument(PLANNER_MD), [], {
      toolPolicy: policy,
    });
    // The policy admits every declared tool; the resolved set is exactly the
    // role's own — a policy can never widen a role's grant.
    expect(resolved.tools).toEqual(['find', 'grep', 'ls', 'read']);
  });

  it('leaves a role alone when the enterprise layer has no tool policy', async () => {
    const { resolveEffectivePolicy } = await import('../policy/enterprise.js');
    const policy = resolveEffectivePolicy([
      { layer: 'enterprise', policy: { models: { allowed: ['faux/*'] } } },
    ]).policy;
    const doc = parseRoleDocument(IMPLEMENTER_MD);
    expect(() => resolveRole(doc, [], { toolPolicy: policy })).not.toThrow();
    expect(resolveRole(doc, [], { toolPolicy: policy }).tools).toContain(
      'bash',
    );
  });

  // The role grant uses the lane gate's allow-semantics
  // (isToolAllowedByEnterprise): a deny list narrows, and an absent allow
  // list means "everything not denied" — it is not deny-by-default.
  const REVIEWER_READ_GREP_MD = `---
role: reviewer
tools: [read, grep]
filesystem: read
shell: false
network: none
git: false
credentials: none
---
# Reviewer
Reads only.
`;

  it('a deny-only policy does not refuse a role that declares no denied tool', async () => {
    const { resolveEffectivePolicy, isToolAllowedByEnterprise } = await import(
      '../policy/enterprise.js'
    );
    const policy = resolveEffectivePolicy([
      { layer: 'enterprise', policy: { tools: { deny: ['bash'] } } },
    ]).policy;
    // The lane gate lets grep through; the role grant must agree.
    expect(isToolAllowedByEnterprise(policy, 'grep')).toBe(true);
    const resolved = resolveRole(parseRoleDocument(REVIEWER_READ_GREP_MD), [], {
      toolPolicy: policy,
    });
    expect(resolved.tools).toEqual(['grep', 'read']);
    // A class-derived tool set (no `tools:` list) is judged the same way.
    const planner = resolveRole(parseRoleDocument(PLANNER_MD), [], {
      toolPolicy: policy,
    });
    expect(planner.tools).toEqual(['find', 'grep', 'ls', 'read']);
  });

  it('a deny-only policy still refuses a role declaring the denied tool, case-insensitively', async () => {
    const { resolveEffectivePolicy } = await import('../policy/enterprise.js');
    const policy = resolveEffectivePolicy([
      { layer: 'enterprise', policy: { tools: { deny: ['Bash'] } } },
    ]).policy;
    expect(() =>
      resolveRole(parseRoleDocument(IMPLEMENTER_MD), [], {
        toolPolicy: policy,
      }),
    ).toThrow(/role 'implementer'.*'bash' denied.*enterprise denial holds/);
  });

  it('a denied tool stays refused when an allow list names it too', async () => {
    const { resolveEffectivePolicy } = await import('../policy/enterprise.js');
    const policy = resolveEffectivePolicy([
      {
        layer: 'enterprise',
        policy: { tools: { allow: ['read', 'grep', 'bash'], deny: ['bash'] } },
      },
    ]).policy;
    expect(
      resolveRole(parseRoleDocument(REVIEWER_READ_GREP_MD), [], {
        toolPolicy: policy,
      }).tools,
    ).toEqual(['grep', 'read']);
    expect(() =>
      resolveRole(parseRoleDocument(IMPLEMENTER_MD), [], {
        toolPolicy: policy,
      }),
    ).toThrow(RoleRefusedError);
  });
});

function fakeLane(): {
  calls: string[][];
  setActiveTools: (tools: string[], context: unknown) => Promise<void>;
} {
  const calls: string[][] = [];
  return {
    calls,
    setActiveTools: (tools: string[]) => {
      calls.push([...tools]);
      return Promise.resolve();
    },
  };
}

describe('applyRoleToLane', () => {
  it('allow-lists the lane to the resolved role tools', async () => {
    const resolved = resolveRole(parseRoleDocument(PLANNER_MD), []);
    const lane = fakeLane();
    const applied = await applyRoleToLane(lane, resolved, undefined);
    expect(applied).toEqual(resolved.tools);
    expect(lane.calls).toEqual([resolved.tools]);
  });

  it('refuses a contradictory role before touching the lane', async () => {
    const doc = parseRoleDocument(PLANNER_MD);
    const resolved = resolveRole({ ...doc, tools: ['read', 'write'] }, [], {
      validate: false,
    });
    const lane = fakeLane();
    await expect(applyRoleToLane(lane, resolved, undefined)).rejects.toThrow(
      RoleRefusedError,
    );
    expect(lane.calls).toEqual([]);
  });

  it('an empty tool set allow-lists no tools (noTools)', async () => {
    const doc = parseRoleDocument(PLANNER_MD);
    const resolved = resolveRole({ ...doc, tools: [] }, [], {
      validate: false,
    });
    const lane = fakeLane();
    await applyRoleToLane(lane, resolved, undefined);
    expect(lane.calls).toEqual([[]]);
  });
});

describe('createRoleToolGuard', () => {
  it('unregistered calls fail tool-absent, not approval-gated', () => {
    const resolved = resolveRole(parseRoleDocument(PLANNER_MD), []);
    const guard = createRoleToolGuard(resolved.name, resolved.tools);
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

  it('registered calls pass through', () => {
    const resolved = resolveRole(parseRoleDocument(PLANNER_MD), []);
    const guard = createRoleToolGuard(resolved.name, resolved.tools);
    expect(
      guard({ toolCallId: 'call-2', toolName: 'read', args: { path: 'a' } }),
    ).toBeUndefined();
  });
});

describe('createRolePolicyGuard', () => {
  const guard = createRolePolicyGuard('implementer', {
    workspace: '/work',
    network: 'none',
  });

  it('destructive commands block with terminate:false toward approval', () => {
    const verdict = guard({
      toolCallId: 'call-1',
      toolName: 'bash',
      args: { command: 'rm -rf /' },
    });
    expect(verdict).toEqual({
      block: {
        reason: expect.stringContaining('destructive-shell'),
        terminate: false,
      },
    });
  });

  it('network, push, install, and outside-write commands each block', () => {
    const cases: Array<{
      toolName: string;
      args: Record<string, unknown>;
      capability: string;
    }> = [
      {
        toolName: 'bash',
        args: { command: 'curl https://example.com' },
        capability: 'network',
      },
      {
        toolName: 'bash',
        args: { command: 'git push origin main' },
        capability: 'git-push',
      },
      {
        toolName: 'bash',
        args: { command: 'npm install leftpad' },
        capability: 'install',
      },
      {
        toolName: 'write',
        args: { path: '/etc/passwd' },
        capability: 'outside-write',
      },
    ];
    for (const { toolName, args, capability } of cases) {
      const verdict = guard({
        toolCallId: `call-${capability}`,
        toolName,
        args,
      });
      expect(verdict).toEqual({
        block: {
          reason: expect.stringContaining(capability),
          terminate: false,
        },
      });
    }
  });

  it('clean calls pass through', () => {
    expect(
      guard({
        toolCallId: 'call-ok',
        toolName: 'bash',
        args: { command: 'echo hi' },
      }),
    ).toBeUndefined();
  });
});

describe('deterministic ordering', () => {
  it('identical definitions resolve to identically-ordered lists', () => {
    const doc = parseRoleDocument(PLANNER_MD);
    const shuffled = {
      ...doc,
      tools: ['grep', 'read', 'find', 'ls', 'read'],
    };
    const first = resolveRole(doc, []);
    const second = resolveRole(shuffled, []);
    expect(first.tools).toEqual(second.tools);
    expect(first.tools).toEqual([...first.tools].sort());
  });

  it('every role tool is a known tool (roles x tools matrix)', () => {
    for (const md of [PLANNER_MD, REVIEWER_MD]) {
      const resolved = resolveRole(parseRoleDocument(md), []);
      for (const tool of resolved.tools) {
        expect(() =>
          validateResolvedRole({ ...resolved, tools: [tool] }),
        ).not.toThrow();
      }
    }
  });

  it('unknown-tool fuzz is denied', () => {
    const doc = parseRoleDocument(PLANNER_MD);
    for (let i = 0; i < 50; i += 1) {
      const resolved = resolveRole(
        { ...doc, tools: ['read', `fuzz-tool-${i}`] },
        [],
        { validate: false },
      );
      expect(() => validateResolvedRole(resolved)).toThrow(RoleRefusedError);
    }
  });
});

describe('roleDebugLine', () => {
  it('emits a [policy] line naming the role and its tools', () => {
    const resolved = resolveRole(parseRoleDocument(PLANNER_MD), []);
    expect(roleDebugLine(resolved)).toBe(
      `[policy] role=planner tools=${resolved.tools.join(',')}`,
    );
  });
});

describe('roleDoctorChecks', () => {
  it('passes valid roles and fails contradictory ones with the reason', () => {
    const good = resolveRole(parseRoleDocument(PLANNER_MD), []);
    const bad = resolveRole(
      { ...parseRoleDocument(PLANNER_MD), tools: ['read', 'write'] },
      [],
      { validate: false },
    );
    const checks = roleDoctorChecks([good, bad]);
    expect(checks[0]).toMatchObject({
      id: 'role:planner',
      status: 'pass',
      reason: 'ok',
    });
    expect(checks[1]).toMatchObject({
      id: 'role:planner',
      status: 'fail',
      reason: 'policy-mismatch',
    });
    expect(checks[1]?.detail).toMatch(/filesystem.*read.*write/i);
  });
});

describe('loadRoleDocuments', () => {
  it('reads *.md role files through the FileBridge in sorted order', () => {
    const files: Record<string, string> = {
      '/roles/b.md': REVIEWER_MD,
      '/roles/a.md': PLANNER_MD,
    };
    const bridge = {
      listDir: (dir: string) => [
        {
          name: 'b.md',
          path: `${dir}/b.md`,
          isDirectory: false,
          isSymbolicLink: false,
          size: 1,
          mtimeMs: 0,
        },
        {
          name: 'notes.txt',
          path: `${dir}/notes.txt`,
          isDirectory: false,
          isSymbolicLink: false,
          size: 1,
          mtimeMs: 0,
        },
        {
          name: 'a.md',
          path: `${dir}/a.md`,
          isDirectory: false,
          isSymbolicLink: false,
          size: 1,
          mtimeMs: 0,
        },
      ],
      readTextFile: (path: string) => files[path] ?? '',
    };
    const docs = loadRoleDocuments(bridge, '/roles');
    expect(docs.map((doc) => doc.name)).toEqual(['planner', 'reviewer']);
  });
});
