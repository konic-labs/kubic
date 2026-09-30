// Slice C: before_tool interceptors on the solo lane (issue #15).
import { afterAll, describe, expect, it } from 'vitest';
import { FakeExecutionEnv } from '../../../exec/src/env.js';
import {
  type AgentLane,
  BACKGROUND_CONTEXT,
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
  type HarnessEvent,
  type JsonValue,
  MemorySessionRepo,
  type Session,
} from '../pi-boundary.js';
import {
  confinePath,
  defaultIsDestructive,
  isNetworkCommand,
  redactReason,
  registerPolicyInterceptors,
} from './interceptors.js';
import { bootSoloLane, driveToSettled } from './solo.js';

const sessions: Session[] = [];
afterAll(async () => {
  for (const session of sessions.splice(0)) {
    await session.close(BACKGROUND_CONTEXT);
  }
});

interface Booted {
  harness: {
    events: {
      on: (
        type: 'tool_end',
        listener: (event: HarnessEvent) => void,
      ) => () => void;
    };
    hooks: Parameters<typeof registerPolicyInterceptors>[0];
  };
  lane: AgentLane;
  env: FakeExecutionEnv;
}

async function boot(
  calls: Array<{ name: string; args: Record<string, JsonValue> }>,
): Promise<Booted> {
  const env = new FakeExecutionEnv({});
  env.fs.writeFile('notes.txt', 'workspace notes\n');
  const repo = new MemorySessionRepo();
  const session = await repo.create({}, BACKGROUND_CONTEXT);
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  faux.setResponses([
    fauxAssistantMessage(
      calls.map((call) => fauxToolCall(call.name, call.args)),
    ),
    fauxAssistantMessage('done'),
  ]);
  const booted = await bootSoloLane({
    session,
    models,
    model: faux.getModel(),
    env,
    sessionId: session.metadata.id,
    agentId: 'root',
  });
  sessions.push(session);
  return { ...(booted as unknown as Booted), env };
}

async function driveToolEnds(booted: Booted): Promise<HarnessEvent[]> {
  const ends: HarnessEvent[] = [];
  const off = booted.harness.events.on('tool_end', (event) => {
    ends.push(event);
  });
  try {
    const admission = await booted.lane.accept(
      { kind: 'prompt', prompt: 'run the tools' },
      BACKGROUND_CONTEXT,
    );
    if (!admission.ok) throw new Error('accept failed');
    await driveToSettled(
      booted.lane,
      admission.value.operationId,
      BACKGROUND_CONTEXT,
    );
  } finally {
    off();
  }
  return ends;
}

describe('policy interceptors (issue #15, slice C)', () => {
  it('blocks destructive bash with a reason and terminate:false', async () => {
    const booted = await boot([
      { name: 'bash', args: { command: 'rm -rf /tmp/x' } },
    ]);
    registerPolicyInterceptors(booted.harness.hooks, { workspace: '/work' });
    const ends = await driveToolEnds(booted);
    expect(ends).toHaveLength(1);
    const end = ends[0];
    expect(end.type).toBe('tool_end');
    if (end.type !== 'tool_end') throw new Error('unreachable');
    expect(end.isError).toBe(true);
    expect(end.terminate).toBe(false);
    expect(JSON.stringify(end.result)).toContain('destructive command blocked');
  });

  it('confines reads outside the workspace, chained across two interceptors', async () => {
    const booted = await boot([
      { name: 'read', args: { path: '/etc/passwd' } },
    ]);
    registerPolicyInterceptors(booted.harness.hooks, { workspace: '/work' });
    const seenBySecond: Array<Record<string, unknown>> = [];
    booted.harness.hooks.on('before_tool', (event) => {
      seenBySecond.push({ ...(event.args as Record<string, unknown>) });
      return undefined;
    });
    const ends = await driveToolEnds(booted);
    expect(ends).toHaveLength(1);
    // The second interceptor saw the confined args (chaining), and the tool ran confined.
    expect(seenBySecond).toHaveLength(1);
    expect(seenBySecond[0]?.path).toBe('/work/etc/passwd');
    const end = ends[0];
    if (end.type !== 'tool_end') throw new Error('unreachable');
    expect(JSON.stringify(end.result)).toContain('/work/etc/passwd');
  });

  it('confines write paths the same as reads', async () => {
    const booted = await boot([
      { name: 'write', args: { path: '/etc/cron.d/x', content: 'nope' } },
    ]);
    registerPolicyInterceptors(booted.harness.hooks, { workspace: '/work' });
    const seenBySecond: Array<Record<string, unknown>> = [];
    booted.harness.hooks.on('before_tool', (event) => {
      seenBySecond.push({ ...(event.args as Record<string, unknown>) });
      return undefined;
    });
    const ends = await driveToolEnds(booted);
    expect(ends).toHaveLength(1);
    expect(seenBySecond).toHaveLength(1);
    expect(seenBySecond[0]?.path).toBe('/work/etc/cron.d/x');
    const end = ends[0];
    if (end?.type !== 'tool_end') throw new Error('unreachable');
    expect(end.isError).toBe(false);
    // The write landed at the confined path, never the requested one.
    expect(booted.env.fs.readFile('/work/etc/cron.d/x')).toBe('nope');
    expect(() => booted.env.fs.readFile('/etc/cron.d/x')).toThrow();
  });

  it('lets read open an advertised skill root, and nothing else (issue #173)', async () => {
    const skill = '/home/u/.agents/skills/a/SKILL.md';
    const booted = await boot([
      { name: 'read', args: { path: skill } },
      { name: 'write', args: { path: skill, content: 'pwned' } },
      { name: 'edit', args: { path: skill, oldText: 'a', newText: 'b' } },
      { name: 'read', args: { path: '/etc/passwd' } },
      { name: 'ls', args: { path: '/home/u/.agents/skills/a' } },
    ]);
    const seen: { tool: string; path: unknown }[] = [];
    registerPolicyInterceptors(booted.harness.hooks, {
      workspace: '/work',
      readRoots: ['/home/u/.agents/skills/a'],
    });
    booted.harness.hooks.on('before_tool', (event) => {
      seen.push({ tool: event.toolName, path: event.args.path });
      return undefined;
    });
    await driveToolEnds(booted);
    expect(seen).toEqual([
      { tool: 'read', path: skill },
      { tool: 'write', path: '/work/home/u/.agents/skills/a/SKILL.md' },
      { tool: 'edit', path: '/work/home/u/.agents/skills/a/SKILL.md' },
      { tool: 'read', path: '/work/etc/passwd' },
      { tool: 'ls', path: '/work/home/u/.agents/skills/a' },
    ]);
  });

  it('blocks network commands under a domain-less allowlist (issue #166)', async () => {
    const blocked = await boot([
      { name: 'bash', args: { command: 'curl https://evil.example' } },
    ]);
    registerPolicyInterceptors(blocked.harness.hooks, {
      workspace: '/work',
      network: 'allowlist',
    });
    const ends = await driveToolEnds(blocked);
    expect(JSON.stringify(ends[0])).toContain('network command blocked');
    expect(JSON.stringify(ends[0])).toContain('allowlist');
  });

  it('blocks network commands when network is none, allows otherwise', async () => {
    const blocked = await boot([
      { name: 'bash', args: { command: 'curl https://example.com' } },
    ]);
    registerPolicyInterceptors(blocked.harness.hooks, {
      workspace: '/work',
      network: 'none',
    });
    const blockedEnds = await driveToolEnds(blocked);
    expect(JSON.stringify(blockedEnds[0])).toContain('network command blocked');

    const allowed = await boot([
      { name: 'bash', args: { command: 'curl https://example.com' } },
    ]);
    registerPolicyInterceptors(allowed.harness.hooks, { workspace: '/work' });
    const allowedEnds = await driveToolEnds(allowed);
    expect(allowedEnds).toHaveLength(1);
    const allowedEnd = allowedEnds[0];
    if (allowedEnd?.type !== 'tool_end') throw new Error('unreachable');
    expect(allowedEnd.isError).toBe(false);
    expect(JSON.stringify(allowedEnd)).not.toContain('network command blocked');
  });

  it('denies through the approval decider and stands down guards only when challenged', async () => {
    const denied = await boot([
      { name: 'bash', args: { command: 'rm -rf /tmp/x' } },
    ]);
    registerPolicyInterceptors(denied.harness.hooks, {
      workspace: '/work',
      approve: () =>
        Promise.resolve({ approved: false, reason: 'user said no' }),
    });
    const deniedEnds = await driveToolEnds(denied);
    expect(JSON.stringify(deniedEnds[0])).toContain(
      'not approved: user said no',
    );

    // Challenged + granted: the destructive guard stands down and the call runs.
    const challenged = await boot([
      { name: 'bash', args: { command: 'rm -rf /tmp/x' } },
    ]);
    registerPolicyInterceptors(challenged.harness.hooks, {
      workspace: '/work',
      approve: () => Promise.resolve({ approved: true, challenged: true }),
    });
    const challengedEnds = await driveToolEnds(challenged);
    expect(challengedEnds).toHaveLength(1);
    const challengedEnd = challengedEnds[0];
    if (challengedEnd?.type !== 'tool_end') throw new Error('unreachable');
    expect(challengedEnd.isError).toBe(false);
    expect(JSON.stringify(challengedEnd)).not.toContain('blocked');

    // Unchallenged fast-path: approved, but every #15 guard stays up — the
    // outside read is still confined.
    const fast = await boot([{ name: 'read', args: { path: '/etc/passwd' } }]);
    registerPolicyInterceptors(fast.harness.hooks, {
      workspace: '/work',
      approve: () => Promise.resolve({ approved: true, challenged: false }),
    });
    const fastEnds = await driveToolEnds(fast);
    expect(fastEnds).toHaveLength(1);
    expect(JSON.stringify(fastEnds[0])).toContain('/work/etc/passwd');
  });

  it('counts blocked attempts against the budget', async () => {
    const booted = await boot([
      { name: 'bash', args: { command: 'rm -rf /tmp/x' } },
      { name: 'ls', args: { path: '.' } },
    ]);
    const triggers: Array<{ kind: string; count: number }> = [];
    registerPolicyInterceptors(booted.harness.hooks, {
      workspace: '/work',
      maxToolCalls: 1,
      onTrigger: (trigger) => {
        triggers.push(trigger);
      },
    });
    const ends = await driveToolEnds(booted);
    expect(ends).toHaveLength(2);
    // First attempt passes the budget (count 1) but the destructive guard
    // blocks it; the second attempt exceeds the budget.
    expect(JSON.stringify(ends)).toContain('destructive command blocked');
    expect(JSON.stringify(ends)).toContain('maxToolCalls (1) exceeded');
    expect(triggers).toEqual([
      { kind: 'max_tool_calls', toolName: 'ls', count: 2 },
    ]);
  });

  it('fails closed when a policy handler throws', async () => {
    const booted = await boot([{ name: 'ls', args: { path: '.' } }]);
    registerPolicyInterceptors(booted.harness.hooks, { workspace: '/work' });
    booted.harness.hooks.on('before_tool', () => {
      throw new Error('policy exploded');
    });
    const ends = await driveToolEnds(booted);
    expect(ends).toHaveLength(1);
    const end = ends[0];
    if (end.type !== 'tool_end') throw new Error('unreachable');
    expect(end.isError).toBe(true);
    expect(JSON.stringify(end.result)).toContain('policy exploded');
  });

  it('blocks past maxToolCalls and emits the trigger once', async () => {
    const booted = await boot([
      { name: 'ls', args: { path: '.' } },
      { name: 'ls', args: { path: '.' } },
    ]);
    const triggers: Array<{ kind: string; count: number }> = [];
    registerPolicyInterceptors(booted.harness.hooks, {
      workspace: '/work',
      maxToolCalls: 1,
      onTrigger: (trigger) => {
        triggers.push(trigger);
      },
    });
    const ends = await driveToolEnds(booted);
    expect(ends).toHaveLength(2);
    const blocked = ends.find((end) =>
      JSON.stringify(end).includes('maxToolCalls (1) exceeded'),
    );
    if (blocked?.type !== 'tool_end')
      throw new Error('no blocked call observed');
    expect(blocked.isError).toBe(true);
    expect(triggers).toEqual([
      { kind: 'max_tool_calls', toolName: 'ls', count: 2 },
    ]);
  });

  it('matches destructive commands and confines paths at unit level', () => {
    expect(defaultIsDestructive('rm -rf /tmp/x')).toBe(true);
    expect(defaultIsDestructive('rm -Rf --no-preserve-root /')).toBe(true);
    expect(defaultIsDestructive('rm -f ~/.ssh/id_rsa', '/work')).toBe(true);
    expect(defaultIsDestructive('rm /data/db.sqlite', '/work')).toBe(true);
    expect(defaultIsDestructive('git clean -fdx', '/work')).toBe(true);
    expect(defaultIsDestructive('echo hello')).toBe(false);
    expect(defaultIsDestructive('ls -la')).toBe(false);
    // Plain in-workspace single-file rm is allowed (recoverable via the
    // journal) — documented scope limit, not a silent gap.
    expect(defaultIsDestructive('rm notes.txt', '/work')).toBe(false);
    // Multi-target rm is inspected token by token.
    expect(defaultIsDestructive('rm notes.txt /etc/passwd', '/work')).toBe(
      true,
    );
    expect(defaultIsDestructive('rm notes.txt /data/db.sqlite', '/work')).toBe(
      true,
    );
    expect(defaultIsDestructive('rm notes.txt ~/.ssh/id_rsa', '/work')).toBe(
      true,
    );
    expect(defaultIsDestructive('rm a.txt b.txt', '/work')).toBe(false);
    expect(isNetworkCommand('curl https://example.com')).toBe(true);
    expect(isNetworkCommand('ls -la')).toBe(false);
    expect(
      redactReason('destructive command blocked: rm --token abc123 /x'),
    ).toContain('token [REDACTED]');
    expect(
      redactReason('destructive command blocked: rm --token abc123 /x'),
    ).not.toContain('abc123');
    expect(redactReason('x'.repeat(500)).length).toBeLessThan(250);
    expect(confinePath('/work', '/etc/passwd')).toEqual({
      confined: '/work/etc/passwd',
      rewritten: true,
    });
    expect(confinePath('/work', 'notes.txt')).toEqual({
      confined: '/work/notes.txt',
      rewritten: false,
    });
    expect(confinePath('/work', '/work/sub/f.txt')).toEqual({
      confined: '/work/sub/f.txt',
      rewritten: false,
    });
  });

  it('keeps tilde/$VAR tokens workspace-relative for tool paths (issue #355)', () => {
    // The write/edit/read ops resolve a path with node `resolve(cwd, path)`
    // and never expand `~` or `$VAR`, so for a TOOL path these tokens are
    // literal workspace entries (`/work/~/.bashrc`) — confinePath is right to
    // leave them unrewritten. Shell targets are different: bash expands
    // them, so the bash outside-write detector (host approvals.ts) treats a
    // `~`/`$VAR` prefix as outside, fail-closed — pinned in
    // approvals-detectors.test.ts.
    expect(confinePath('/work', '~/.bashrc')).toEqual({
      confined: '/work/~/.bashrc',
      rewritten: false,
    });
    expect(confinePath('/work', '$HOME/.zshrc')).toEqual({
      confined: '/work/$HOME/.zshrc',
      rewritten: false,
    });
  });

  it('matches every destructive shape, not just rm and git clean', () => {
    // Each entry pins one DESTRUCTIVE_PATTERNS arm or rmBlocked branch:
    // surviving Regex mutants here mean a destructive shape slips through.
    for (const command of [
      'dd if=/dev/zero of=/dev/sda',
      'dd if=x of= /dev/null',
      'shred -u secret.txt',
      'mkfs.ext4 /dev/sda1',
      'chmod -R 777 /tmp/x',
      'chown -R root:root /tmp/x',
      ':(){ :|:& };:',
      'rm -rf ~/.gnupg',
      'rm -f key.pem',
      'rm -rf /tmp/work-notes',
      'rmdir /tmp/old',
    ]) {
      expect(defaultIsDestructive(command, '/work')).toBe(true);
    }
    expect(defaultIsDestructive('rm notes.txt', '/work')).toBe(false);
    expect(defaultIsDestructive('echo hi', '/work')).toBe(false);
  });

  // Issue #357: each new DESTRUCTIVE_PATTERNS arm pinned on its own, with a
  // near-miss beside it, so weakening one regex fails exactly one row.
  it.each([
    ['git push --force origin main', true],
    ['git push -f', true],
    ['git push -uf origin main', true],
    ['git push --force-with-lease', true],
    ['git push --force-if-includes origin main', true],
    ['git push origin +main', true],
    ['git -C . push --force', true],
    ['git push -u origin main', false],
    ['git push origin feat-fix', false],
    ['find / -delete', true],
    ['find . -type f -delete', true],
    ['find . -name delete', false],
    ['git reset --hard HEAD~5', true],
    ['git -C sub reset --hard', true],
    ['git reset --soft HEAD~1', false],
    ['git checkout -- .', true],
    ['git checkout main -- a.ts', true],
    ['git checkout .', true],
    ['git checkout -f main', true],
    ['git checkout --force main', true],
    ['git checkout -b feature', false],
    ['git checkout main', false],
    ['git restore .', true],
    ['git restore src/a.ts', true],
    ['git restore --staged --worktree .', true],
    ['git restore -W a.ts', true],
    ['git restore --staged a.ts', false],
    ['git restore -S a.ts', false],
    ['git status; git log', false],
  ])('classifies %s as destructive=%s (issue #357)', (command, expected) => {
    expect(defaultIsDestructive(command, '/work')).toBe(expected);
  });
});
