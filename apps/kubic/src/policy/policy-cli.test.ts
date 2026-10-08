// `kubic policy` CLI tests. Policy-cli.ts
// lands after this file. The command is a routing offer only — it never
// enforces, never mutates. Faux-only, zero network.
import { describe, expect, it } from 'vitest';
import { createCliTheme } from '../../../../packages/core/src/cli/theme.js';
import { REDACTED_SECRET } from '../../../../packages/core/src/secret-shapes.js';
import {
  type EffectivePolicy,
  isToolAllowed,
  resolveEffectivePolicy,
} from '../../../../packages/host/src/policy/enterprise.js';
import {
  policyWithInstalledAllowlist,
  runPolicyCommand,
} from '../../../../packages/host/src/policy/policy-cli.js';

// stdout (`lines`) and stderr (`errs`) captured separately.
function capture() {
  const lines: string[] = [];
  const errs: string[] = [];
  return {
    lines,
    errs,
    out: (line: string): void => {
      lines.push(line);
    },
    err: (line: string): void => {
      errs.push(line);
    },
  };
}

function emptyPolicy(): EffectivePolicy {
  return resolveEffectivePolicy([]).policy;
}

function allowBash(): EffectivePolicy {
  return resolveEffectivePolicy([
    { layer: 'enterprise', policy: { tools: { allow: ['bash'] } } },
  ]).policy;
}

describe('kubic policy names unsupported levels', () => {
  const unsupported = [
    {
      class: 'network',
      level: 'allowlist',
      enforcedAs: 'none',
      reason: 'no domain list can be supplied',
    },
    {
      class: 'filesystem',
      level: 'full',
      enforcedAs: 'workspace-write',
      reason: 'no outside-workspace write tool exists',
    },
  ];

  it('warns on stderr once per unsupported level; stdout stays the decision', async () => {
    const cap = capture();
    const code = (
      await runPolicyCommand(
        { tool: 'bash' },
        { resolvePolicy: allowBash, unsupported: () => unsupported, ...cap },
      )
    ).exitCode;
    expect(code).toBe(0);
    expect(cap.lines).toEqual(['allow bash (enterprise)']);
    expect(cap.errs).toEqual([
      "warn: network 'allowlist' is unsupported — enforced as 'none': no domain list can be supplied",
      "warn: filesystem 'full' is unsupported — enforced as 'workspace-write': no outside-workspace write tool exists",
    ]);
  });

  it('carries the unsupported levels in the --json document', async () => {
    const cap = capture();
    await runPolicyCommand(
      { tool: 'bash', json: true },
      { resolvePolicy: allowBash, unsupported: () => unsupported, ...cap },
    );
    const doc = JSON.parse(cap.lines.join('\n')) as {
      unsupported: { class: string; level: string }[];
    };
    expect(doc.unsupported.map((u) => `${u.class}:${u.level}`)).toEqual([
      'network:allowlist',
      'filesystem:full',
    ]);
    expect(cap.errs).toEqual([]);
  });
});

describe('kubic policy names the deciding layer', () => {
  it('reports deny (enterprise) under an enterprise deny', async () => {
    const cap = capture();
    const code = (
      await runPolicyCommand(
        { tool: 'bash' },
        {
          resolvePolicy: () =>
            resolveEffectivePolicy([
              { layer: 'enterprise', policy: { tools: { deny: ['bash'] } } },
              {
                layer: 'session',
                policy: { tools: { allow: ['read', 'bash'] } },
              },
            ]).policy,
          out: cap.out,
          err: cap.err,
        },
      )
    ).exitCode;
    expect(code).toBe(0);
    expect(cap.lines).toEqual(['deny bash (enterprise)']);
  });

  it('names the installed allowlist when it is what admits the tool', async () => {
    const cap = capture();
    await runPolicyCommand(
      { tool: 'bash' },
      {
        resolvePolicy: () =>
          policyWithInstalledAllowlist(emptyPolicy(), ['read', 'bash']),
        out: cap.out,
        err: cap.err,
      },
    );
    expect(cap.lines).toEqual(['allow bash (installed)']);
  });

  it('carries the source in the --json document', async () => {
    const cap = capture();
    await runPolicyCommand(
      { tool: 'bash', json: true },
      {
        resolvePolicy: () =>
          resolveEffectivePolicy([
            { layer: 'enterprise', policy: { tools: { deny: ['bash'] } } },
          ]).policy,
        out: cap.out,
        err: cap.err,
      },
    );
    expect(JSON.parse(cap.lines.join('\n'))).toEqual({
      tool: 'bash',
      decision: 'deny',
      source: 'enterprise',
    });
  });
});

describe('policyWithInstalledAllowlist', () => {
  it('intersects the installed allowlist with an enterprise allow, never widening', () => {
    const enterprise = resolveEffectivePolicy([
      {
        layer: 'enterprise',
        policy: { tools: { allow: ['read', 'bash'], deny: ['git_push'] } },
      },
    ]).policy;
    const merged = policyWithInstalledAllowlist(enterprise, [
      'read',
      'bash',
      'write',
    ]);
    expect(isToolAllowed(merged, 'read')).toBe(true);
    // the installed allowlist offers write, the enterprise allow does not:
    // the intersection is what a run from this cwd actually installs.
    expect(isToolAllowed(merged, 'write')).toBe(false);
    expect(isToolAllowed(merged, 'git_push')).toBe(false);
    expect(merged.tools.allowSource).toBe('enterprise');
  });

  it('installs the installed allowlist when the enterprise layer names none', () => {
    const enterprise = resolveEffectivePolicy([
      { layer: 'enterprise', policy: { tools: { deny: ['bash'] } } },
    ]).policy;
    const merged = policyWithInstalledAllowlist(enterprise, ['read', 'bash']);
    expect(isToolAllowed(merged, 'read')).toBe(true);
    expect(isToolAllowed(merged, 'bash')).toBe(false);
    expect(merged.tools.allowSource).toBe('session');
  });
});

describe('kubic policy tool query', () => {
  it('denies by default with no enterprise allow', async () => {
    const cap = capture();
    const code = (
      await runPolicyCommand(
        { tool: 'bash' },
        {
          resolvePolicy: emptyPolicy,
          out: cap.out,
          err: cap.err,
        },
      )
    ).exitCode;
    expect(code).toBe(0);
    expect(cap.lines).toEqual(['deny bash (defaults)']);
  });

  it('offers allow for an allowlisted tool', async () => {
    const cap = capture();
    const code = (
      await runPolicyCommand(
        { tool: 'bash' },
        {
          resolvePolicy: allowBash,
          out: cap.out,
          err: cap.err,
        },
      )
    ).exitCode;
    expect(code).toBe(0);
    expect(cap.lines).toEqual(['allow bash (enterprise)']);
  });

  it('holds the enterprise denial against a lower-layer allow', async () => {
    const cap = capture();
    const code = (
      await runPolicyCommand(
        { tool: 'bash' },
        {
          resolvePolicy: () =>
            resolveEffectivePolicy([
              { layer: 'enterprise', policy: { tools: { deny: ['bash'] } } },
              { layer: 'project', policy: { tools: { allow: ['bash'] } } },
            ]).policy,
          out: cap.out,
          err: cap.err,
        },
      )
    ).exitCode;
    expect(code).toBe(0);
    expect(cap.lines).toEqual(['deny bash (enterprise)']);
  });

  it('matches tool names case- and whitespace-insensitively', async () => {
    const cap = capture();
    const code = (
      await runPolicyCommand(
        { tool: ' Bash ' },
        {
          resolvePolicy: allowBash,
          out: cap.out,
          err: cap.err,
        },
      )
    ).exitCode;
    expect(code).toBe(0);
    expect(cap.lines).toEqual(['allow Bash (enterprise)']);
  });
});

describe('kubic policy --json', () => {
  it('emits the tool decision as JSON', async () => {
    const cap = capture();
    const code = (
      await runPolicyCommand(
        { tool: 'bash', json: true },
        {
          resolvePolicy: allowBash,
          out: cap.out,
          err: cap.err,
        },
      )
    ).exitCode;
    expect(code).toBe(0);
    expect(JSON.parse(cap.lines.join('\n'))).toEqual({
      tool: 'bash',
      decision: 'allow',
      source: 'enterprise',
    });
  });
});

// Argv syntax (unknown flags, a missing --tool value, --help) is
// commander's: apps/kubic/src/commands/analysis.test.ts pins it.
describe('kubic policy usage', () => {
  it('exits 2 without --tool (direct callers; commander requires it)', async () => {
    const cap = capture();
    const code = (
      await runPolicyCommand(
        {},
        { resolvePolicy: emptyPolicy, out: cap.out, err: cap.err },
      )
    ).exitCode;
    expect(code).toBe(2);
    expect(cap.lines).toEqual([]);
    expect(cap.errs).toEqual([
      "error: required option '--tool <name>' not specified",
    ]);
  });

  it('exits 2 on an empty (whitespace-only) tool name', async () => {
    const cap = capture();
    const code = (
      await runPolicyCommand(
        { tool: '   ' },
        { resolvePolicy: emptyPolicy, out: cap.out, err: cap.err },
      )
    ).exitCode;
    expect(code).toBe(2);
    expect(cap.lines).toEqual([]);
    expect(cap.errs).toEqual(['error: --tool needs a non-empty value']);
  });
});

describe('kubic policy colour', () => {
  it('colours the decision word only with a coloured theme', async () => {
    const cap = capture();
    await runPolicyCommand(
      { tool: 'bash' },
      {
        resolvePolicy: allowBash,
        out: cap.out,
        err: cap.err,
        theme: createCliTheme('truecolor'),
      },
    );
    expect(cap.lines[0]).toContain('\u001b[');
    expect(cap.lines[0]).toMatch(/ bash \(enterprise\)$/);
  });
});

describe('kubic policy secret backstop', () => {
  // Tool names are free-form argv: a secret-shaped tool echoes back in the
  // routing offer unless the echo is redacted.
  const SHAPED_TOOL = 'SK-FAUX-TEST-KEY-0001';

  it('redacts a secret-shaped tool name in the text offer', async () => {
    const cap = capture();
    const code = (
      await runPolicyCommand(
        { tool: SHAPED_TOOL },
        {
          resolvePolicy: emptyPolicy,
          out: cap.out,
          err: cap.err,
        },
      )
    ).exitCode;
    expect(code).toBe(0);
    const text = cap.lines.join('\n');
    expect(text).not.toContain(SHAPED_TOOL);
    expect(text).toContain(REDACTED_SECRET);
    expect(text).toMatch(/^deny /);
  });

  it('redacts a secret-shaped tool name under --json', async () => {
    const cap = capture();
    const code = (
      await runPolicyCommand(
        { tool: SHAPED_TOOL, json: true },
        {
          resolvePolicy: emptyPolicy,
          out: cap.out,
          err: cap.err,
        },
      )
    ).exitCode;
    expect(code).toBe(0);
    const text = cap.lines.join('\n');
    expect(text).not.toContain(SHAPED_TOOL);
    expect(JSON.parse(text)).toEqual({
      tool: REDACTED_SECRET,
      decision: 'deny',
      source: 'defaults',
    });
  });
});
