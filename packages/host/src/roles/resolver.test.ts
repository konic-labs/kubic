// Role resolver tests: per-role tool filtering + policy
// validation. Fixture role documents are inline strings — never real
// filesystem roles (role contents land).
import { describe, expect, it } from 'vitest';
import { DEFAULT_PERMISSIONS } from '../../../agent/src/policy.js';
import {
  effectiveRoleClasses,
  mergeRoleLayers,
  parseRoleDocument,
  RoleRefusedError,
  resolveRole,
  roleDoctorChecks,
  roleModelAllowed,
  validateResolvedRole,
} from './resolver.js';
import { loadRoles } from './roles-boot.js';

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

  // A role document may declare the skills it sees.
  it("parses the role document's skills list", () => {
    const doc = parseRoleDocument(
      `---\nrole: reviewer\nskills: [diff-skill, lint-skill]\n---\n# Reviewer\n`,
    );
    expect(doc.name).toBe('reviewer');
    expect(doc.skills).toEqual(['diff-skill', 'lint-skill']);
  });

  // Windows line endings and a leading BOM are normalized
  // before fence detection — a CRLF doc parses like its LF twin.
  it('parses CRLF and BOM-prefixed documents like their LF twin', () => {
    const lf = `---\nrole: reviewer\ntools: [read]\n---\n\n# Reviewer\n`;
    const crlf = lf.replace(/\n/g, '\r\n');
    expect(parseRoleDocument(crlf)).toEqual(parseRoleDocument(lf));
    expect(parseRoleDocument(`\uFEFF${lf}`)).toEqual(parseRoleDocument(lf));
  });

  // The Pi-agent keys: `name` aliases `role`, `description` is shown by
  // doctor, and `model` is a validated provider/id pin.
  it('parses name/description/model from a Pi-agent-shaped doc', () => {
    const doc = parseRoleDocument(
      `---\nname: reviewer\ndescription: Reviews diffs\ntools: [read]\nmodel: acme/reviewer-1\n---\n# Reviewer\n`,
    );
    expect(doc.name).toBe('reviewer');
    expect(doc.description).toBe('Reviews diffs');
    expect(doc.model).toBe('acme/reviewer-1');
  });

  it("refuses disagreeing 'role' and 'name' by name", () => {
    expect(() =>
      parseRoleDocument(`---\nrole: reviewer\nname: writer\n---\n# Reviewer\n`),
    ).toThrow(/disagree/);
  });

  it('refuses a malformed model ref with a named reason', () => {
    expect(() =>
      parseRoleDocument(`---\nrole: reviewer\nmodel: not-a-ref\n---\n# R\n`),
    ).toThrow(/model.*provider\/id/);
  });

  it('refuses an unknown frontmatter key by name', () => {
    expect(() =>
      parseRoleDocument(`---\nrole: reviewer\npriority: high\n---\n# R\n`),
    ).toThrow(/unknown frontmatter key 'priority'/);
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

  it('model pins merge first-wins; attempts are reported', () => {
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

  it('thinking defaults merge first-wins; attempts are reported', () => {
    const doc = parseRoleDocument(PLANNER_MD);
    const merged = mergeRoleLayers(doc, [
      { layer: 'agent', roles: { planner: { thinking: 'low' } } },
      { layer: 'enterprise', roles: { planner: { thinking: 'high' } } },
    ]);
    expect(merged.thinking).toBe('high');
    expect(merged.overriddenAttempts).toContain('roles.planner.thinking');
    expect(mergeRoleLayers(doc, []).thinking).toBeUndefined();
    expect(
      resolveRole(parseRoleDocument(PLANNER_MD), [
        { layer: 'project', roles: { planner: { thinking: 'medium' } } },
      ]).thinking,
    ).toBe('medium');
  });

  it('models merge first-wins whole-list; attempts are reported', () => {
    const doc = parseRoleDocument(PLANNER_MD);
    const merged = mergeRoleLayers(doc, [
      {
        layer: 'project',
        roles: { planner: { models: [{ id: 'acme/*' }] } },
      },
      {
        layer: 'enterprise',
        roles: { planner: { models: [{ id: 'local/*' }] } },
      },
    ]);
    expect(merged.models).toEqual([{ id: 'local/*' }]);
    expect(merged.overriddenAttempts).toEqual(['roles.planner.models']);
    const resolved = resolveRole(doc, [
      {
        layer: 'project',
        roles: {
          planner: {
            models: [{ id: 'local/*' }, { id: 'acme/big', thinking: 'high' }],
          },
        },
      },
    ]);
    expect(resolved.models).toEqual([
      { id: 'local/*' },
      { id: 'acme/big', thinking: 'high' },
    ]);
    // No layer sets a list: undefined (allow-all), never [].
    expect(resolveRole(doc, []).models).toBeUndefined();
  });

  it('escalate merges first-wins whole-list; attempts reported', () => {
    const doc = parseRoleDocument(PLANNER_MD);
    const merged = mergeRoleLayers(doc, [
      {
        layer: 'project',
        roles: { planner: { escalate: ['local/a', 'local/b'] } },
      },
      {
        layer: 'enterprise',
        roles: { planner: { escalate: ['local/a', 'acme/big'] } },
      },
    ]);
    expect(merged.escalate).toEqual(['local/a', 'acme/big']);
    expect(merged.overriddenAttempts).toEqual(['roles.planner.escalate']);
    // Copied, and unset stays undefined (no ladder).
    const resolved = resolveRole(doc, [
      {
        layer: 'project',
        roles: { planner: { escalate: ['local/a', 'local/b'] } },
      },
    ]);
    expect(resolved.escalate).toEqual(['local/a', 'local/b']);
    expect(resolved.escalate).not.toBe(
      (doc as unknown as { escalate?: unknown }).escalate,
    );
    expect(resolveRole(doc, []).escalate).toBeUndefined();
  });

  it('roleModelAllowed matches exact and provider/*, boundary-safe', () => {
    const set = [{ id: 'local/*' }, { id: 'acme/big' }];
    expect(roleModelAllowed(undefined, 'acme', 'x')).toBe(true);
    expect(roleModelAllowed([], 'acme', 'x')).toBe(true);
    expect(roleModelAllowed(set, 'local', 'anything')).toBe(true);
    expect(roleModelAllowed(set, 'acme', 'big')).toBe(true);
    expect(roleModelAllowed(set, 'acme', 'small')).toBe(false);
    expect(roleModelAllowed(set, 'localfoo', 'x')).toBe(false);
    expect(roleModelAllowed(set, 'other', 'x')).toBe(false);
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

  // The document model resolves when no layer sets
  // one; a layer pin outranks it (spawn/CLI > config > document).
  it('a document model resolves, and a layer pin outranks it', () => {
    const doc = parseRoleDocument(
      `---\nrole: reviewer\nmodel: acme/doc-1\n---\n# R\n`,
    );
    expect(resolveRole(doc, []).model).toBe('acme/doc-1');
    expect(
      resolveRole(doc, [
        { layer: 'project', roles: { reviewer: { model: 'acme/cfg-1' } } },
      ]).model,
    ).toBe('acme/cfg-1');
  });
});

describe('enterprise policy on role grants', () => {
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

describe('the role tool allow-list', () => {
  it('resolves the planner document to its read-only tools', () => {
    const resolved = resolveRole(parseRoleDocument(PLANNER_MD), []);
    expect(resolved.tools).toEqual(['find', 'grep', 'ls', 'read']);
  });

  it('refuses a contradictory role when it is resolved with validation', () => {
    const doc = parseRoleDocument(PLANNER_MD);
    expect(() =>
      resolveRole({ ...doc, tools: ['read', 'write'] }, [], { validate: true }),
    ).toThrow(RoleRefusedError);
  });

  it('an empty tool set resolves to no tools (noTools)', () => {
    const doc = parseRoleDocument(PLANNER_MD);
    const resolved = resolveRole({ ...doc, tools: [] }, [], {
      validate: false,
    });
    expect(resolved.tools).toEqual([]);
  });
});

describe('effectiveRoleClasses', () => {
  const FULL = {
    filesystem: 'full',
    shell: true,
    network: 'full',
    git: 'full',
    credentials: 'allowlist',
  } as const;

  it('takes the tighter level per key', () => {
    expect(
      effectiveRoleClasses(
        { ...FULL, network: 'full' },
        { ...FULL, network: 'none' },
      ).network,
    ).toBe('none');
  });

  it('never widens: a permissive role keeps the config levels', () => {
    const config = {
      filesystem: 'read',
      shell: false,
      network: 'none',
      git: false,
      credentials: 'none',
    } as const;
    expect(effectiveRoleClasses(config, FULL)).toEqual(config);
  });

  it('merges every key independently', () => {
    expect(
      effectiveRoleClasses(
        {
          filesystem: 'full',
          shell: true,
          network: 'full',
          git: 'full',
          credentials: 'allowlist',
        },
        {
          filesystem: 'read',
          shell: 'read-only-allowlist',
          network: 'allowlist',
          git: 'workspace',
          credentials: 'none',
        },
      ),
    ).toEqual({
      filesystem: 'read',
      shell: 'read-only-allowlist',
      network: 'allowlist',
      git: 'workspace',
      credentials: 'none',
    });
  });
});

describe('role approval requires', () => {
  it('parses the requires list from the role document', () => {
    const doc = parseRoleDocument(
      '---\nrole: reviewer\nrequires: [write, bash]\n---\n# Reviewer\n',
    );
    expect(doc.requires).toEqual(['write', 'bash']);
  });

  it('unions the document and layer lists, sorted', () => {
    const doc = parseRoleDocument(
      '---\nrole: reviewer\nrequires: [write]\n---\n# Reviewer\n',
    );
    const merged = mergeRoleLayers(doc, [
      {
        layer: 'global',
        roles: { reviewer: { requires: ['bash', 'write'] } },
      },
    ]);
    expect(merged.requires).toEqual(['bash', 'write']);
    expect(resolveRole(doc, []).requires).toEqual(['write']);
  });

  it('resolves no requires to an empty list', () => {
    expect(resolveRole(parseRoleDocument(PLANNER_MD), []).requires).toEqual([]);
  });
});
describe('roleDoctorChecks effective classes', () => {
  it('names the most-restrictive merge and the requires when config classes are given', () => {
    const resolved = resolveRole(parseRoleDocument(PLANNER_MD), []);
    const [check] = roleDoctorChecks([resolved], {}, DEFAULT_PERMISSIONS);
    expect(check?.status).toBe('pass');
    expect(check?.detail).toContain('effective');
    expect(check?.detail).toContain('network:none');
  });

  it('keeps the tool list when no config classes are given', () => {
    const resolved = resolveRole(parseRoleDocument(PLANNER_MD), []);
    const [check] = roleDoctorChecks([resolved], {});
    expect(check?.detail).toContain('tool(s):');
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

  // The document description is shown by doctor.
  it('shows the document description in the role detail', () => {
    const doc = parseRoleDocument(
      `---\nrole: planner\ndescription: Plans only\ntools: [read]\n---\n# P\n`,
    );
    const checks = roleDoctorChecks([resolveRole(doc, [])]);
    expect(checks[0]?.detail).toContain('Plans only');
  });
});

describe('repo role files', () => {
  it('reads the repo role documents through the bridge and ignores other files', () => {
    const repoRoles = '/repo/.kubic/roles';
    const files: Record<string, string> = {
      [`${repoRoles}/reviewer.md`]: REVIEWER_MD,
      [`${repoRoles}/planner.md`]: PLANNER_MD,
    };
    const entry = (dir: string, name: string) => ({
      name,
      path: `${dir}/${name}`,
      isDirectory: false,
      isSymbolicLink: false,
      size: 1,
      mtimeMs: 0,
    });
    const bridge = {
      listDir: (dir: string) =>
        dir === repoRoles
          ? ['reviewer.md', 'notes.txt', 'planner.md'].map((name) =>
              entry(dir, name),
            )
          : [],
      readTextFile: (path: string) => files[path] ?? '',
    };
    const loaded = loadRoles({ bridge, cwd: '/repo', trusted: true });
    expect(loaded.sources.planner).toBe('repo');
    expect(loaded.sources.reviewer).toBe('repo');
    expect(loaded.texts.planner).toBe(PLANNER_MD);
    expect(loaded.texts.notes).toBeUndefined();
  });
});
