// `kubic policy` CLI tests (issue #79; §58). RED first: policy-cli.ts
// lands after this file. The command is a routing offer only — it never
// enforces, never mutates. Faux-only, zero network.
import { describe, expect, it } from 'vitest';
import { type EffectivePolicy, resolveEffectivePolicy } from './enterprise.js';
import { runPolicyCommand } from './policy-cli.js';
import { REDACTED_SECRET } from './secret-shapes.js';

function capture() {
  const lines: string[] = [];
  return {
    lines,
    out: (line: string): void => {
      lines.push(line);
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

describe('kubic policy tool query (issue #79)', () => {
  it('denies by default with no enterprise allow', async () => {
    const cap = capture();
    const code = await runPolicyCommand(['--tool', 'bash'], {
      resolvePolicy: emptyPolicy,
      out: cap.out,
    });
    expect(code).toBe(0);
    expect(cap.lines).toEqual(['deny bash']);
  });

  it('offers allow for an allowlisted tool', async () => {
    const cap = capture();
    const code = await runPolicyCommand(['--tool', 'bash'], {
      resolvePolicy: allowBash,
      out: cap.out,
    });
    expect(code).toBe(0);
    expect(cap.lines).toEqual(['allow bash']);
  });

  it('holds the enterprise denial against a lower-layer allow', async () => {
    const cap = capture();
    const code = await runPolicyCommand(['--tool', 'bash'], {
      resolvePolicy: () =>
        resolveEffectivePolicy([
          { layer: 'enterprise', policy: { tools: { deny: ['bash'] } } },
          { layer: 'project', policy: { tools: { allow: ['bash'] } } },
        ]).policy,
      out: cap.out,
    });
    expect(code).toBe(0);
    expect(cap.lines).toEqual(['deny bash']);
  });

  it('matches tool names case- and whitespace-insensitively', async () => {
    const cap = capture();
    const code = await runPolicyCommand(['--tool', ' Bash '], {
      resolvePolicy: allowBash,
      out: cap.out,
    });
    expect(code).toBe(0);
    expect(cap.lines).toEqual(['allow Bash']);
  });
});

describe('kubic policy --json (issue #79)', () => {
  it('emits the tool decision as JSON', async () => {
    const cap = capture();
    const code = await runPolicyCommand(['--tool', 'bash', '--json'], {
      resolvePolicy: allowBash,
      out: cap.out,
    });
    expect(code).toBe(0);
    expect(JSON.parse(cap.lines.join('\n'))).toEqual({
      tool: 'bash',
      decision: 'allow',
    });
  });
});

describe('kubic policy usage (issue #79, §78)', () => {
  it('exits 2 without --tool', async () => {
    const cap = capture();
    const code = await runPolicyCommand([], {
      resolvePolicy: emptyPolicy,
      out: cap.out,
    });
    expect(code).toBe(2);
    expect(cap.lines[0]).toMatch(/^usage: kubic policy/);
  });

  it('exits 2 when --tool has no value', async () => {
    const cap = capture();
    const code = await runPolicyCommand(['--tool'], {
      resolvePolicy: emptyPolicy,
      out: cap.out,
    });
    expect(code).toBe(2);
  });

  it('exits 2 on an unknown flag', async () => {
    const cap = capture();
    const code = await runPolicyCommand(['--tool', 'bash', '--bogus'], {
      resolvePolicy: emptyPolicy,
      out: cap.out,
    });
    expect(code).toBe(2);
  });
});

describe('kubic policy secret backstop (issue #79 fix cycle 1)', () => {
  // Tool names are free-form argv: a secret-shaped tool echoes back in the
  // routing offer unless the echo is redacted.
  const SHAPED_TOOL = 'SK-FAUX-TEST-KEY-0001';

  it('redacts a secret-shaped tool name in the text offer', async () => {
    const cap = capture();
    const code = await runPolicyCommand(['--tool', SHAPED_TOOL], {
      resolvePolicy: emptyPolicy,
      out: cap.out,
    });
    expect(code).toBe(0);
    const text = cap.lines.join('\n');
    expect(text).not.toContain(SHAPED_TOOL);
    expect(text).toContain(REDACTED_SECRET);
    expect(text).toMatch(/^deny /);
  });

  it('redacts a secret-shaped tool name under --json', async () => {
    const cap = capture();
    const code = await runPolicyCommand(['--tool', SHAPED_TOOL, '--json'], {
      resolvePolicy: emptyPolicy,
      out: cap.out,
    });
    expect(code).toBe(0);
    const text = cap.lines.join('\n');
    expect(text).not.toContain(SHAPED_TOOL);
    expect(JSON.parse(text)).toEqual({
      tool: REDACTED_SECRET,
      decision: 'deny',
    });
  });
});
