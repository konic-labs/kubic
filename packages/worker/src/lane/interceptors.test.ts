// Policy interceptors as pi-durable ToolTask hooks (issues #15, #208, #397).
// Every behaviour here runs through a REAL Harness over MemoryStorage with
// the faux provider: first-block-wins, throw-to-block and argument chaining
// are the harness's own hook semantics, not a hand-rolled stand-in.
import { afterEach, describe, expect, it } from 'vitest';
import {
  BACKGROUND_CONTEXT,
  type Conversation,
  createModels,
  createRegistry,
  defineExtension,
  defineTool,
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
  Harness,
  type HookRegistration,
  hook,
  type JsonValue,
  MemoryStorage,
  ToolResultEntry,
  ToolTask,
  Type,
} from '../pi-boundary.js';
import {
  confinePath,
  defaultIsDestructive,
  isNetworkCommand,
  type PolicyInterceptorOptions,
  policyInterceptorHooks,
  readOnlyViolation,
  redactReason,
  redactSecrets,
} from './interceptors.js';

const openHarnesses: Harness[] = [];

afterEach(async () => {
  for (const harness of openHarnesses.splice(0)) {
    await harness.close(BACKGROUND_CONTEXT);
  }
});

interface World {
  calls: Array<{ name: string; args: Record<string, unknown> }>;
}

interface SeenToolResult {
  toolName: string;
  isError: boolean;
  text: string;
  code?: string;
}

function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((part: unknown) => {
      if (typeof part !== 'object' || part === null) return '';
      const block = part as { type?: unknown; text?: unknown };
      return block.type === 'text' && typeof block.text === 'string'
        ? block.text
        : '';
    })
    .join('');
}

// What the model actually sees: the harness's own model context, in order.
async function toolResults(root: Conversation): Promise<SeenToolResult[]> {
  const view = await root.context(BACKGROUND_CONTEXT);
  return view.messages
    .filter((message) => message.role === 'toolResult')
    .map((message) => {
      const result = message as unknown as {
        toolName?: string;
        isError?: boolean;
        content?: unknown;
      };
      return {
        toolName: result.toolName ?? '',
        isError: result.isError === true,
        text: textOf(result.content),
      };
    });
}

async function errorCodes(
  root: Conversation,
): Promise<Array<string | undefined>> {
  const page = await root.entries({}, 100, undefined, BACKGROUND_CONTEXT);
  return page.items
    .filter((entry) => ToolResultEntry.is(entry))
    .reverse()
    .map((entry) => {
      const data = entry.data as unknown as
        | { diagnostics?: Array<{ code?: string }> }
        | undefined;
      return data?.diagnostics?.[0]?.code;
    });
}

// The probe tools record what the tool layer received, so an interceptor's
// rewrite is observable at the seam the tool executes against.
function probeTools(world: World) {
  const record = (
    name: string,
    args: Record<string, unknown>,
  ): { content: Array<{ type: 'text'; text: string }> } => {
    world.calls.push({ name, args });
    return { content: [{ type: 'text', text: `${name} ran` }] };
  };
  return [
    defineTool({
      name: 'bash',
      description: 'run a shell command',
      parameters: Type.Object({ command: Type.String() }),
      execute: async (args) => record('bash', args),
    }),
    defineTool({
      name: 'read',
      description: 'read a file',
      parameters: Type.Object({ path: Type.String() }),
      execute: async (args) => record('read', args),
    }),
    defineTool({
      name: 'write',
      description: 'write a file',
      parameters: Type.Object({
        path: Type.String(),
        content: Type.Optional(Type.String()),
      }),
      execute: async (args) => record('write', args),
    }),
    defineTool({
      name: 'edit',
      description: 'edit a file',
      parameters: Type.Object({
        path: Type.String(),
        oldText: Type.String(),
        newText: Type.String(),
      }),
      execute: async (args) => record('edit', args),
    }),
    defineTool({
      name: 'ls',
      description: 'list a directory',
      parameters: Type.Object({ path: Type.Optional(Type.String()) }),
      execute: async (args) => record('ls', args),
    }),
  ];
}

interface BootOptions {
  calls?: Array<{ name: string; args: Record<string, JsonValue> }>;
  // Issue #194: a scripted multi-turn sequence (each inner array is one
  // assistant tool-use message) whose entries may pin a provider call id,
  // for the duplicate-id and empty-id stand-down cases.
  turns?: Array<
    Array<{ name: string; args: Record<string, JsonValue>; id?: string }>
  >;
  policy?: PolicyInterceptorOptions;
  // Hooks appended after the policy hooks, inside kubic.policy.
  extraHooks?: HookRegistration[];
}

interface Booted {
  harness: Harness;
  root: Conversation;
  world: World;
}

async function boot(options: BootOptions): Promise<Booted> {
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  const turns = options.turns ?? [
    (options.calls ?? []).map((call) => ({ ...call, id: undefined })),
  ];
  faux.setResponses([
    ...turns.map((calls) =>
      fauxAssistantMessage(
        calls.map((call) =>
          fauxToolCall(
            call.name,
            call.args,
            call.id === undefined ? {} : { id: call.id },
          ),
        ),
        { stopReason: 'toolUse' },
      ),
    ),
    fauxAssistantMessage('done'),
  ]);
  const world: World = { calls: [] };
  const registry = createRegistry();
  registry.install(
    defineExtension({
      name: 'kubic.policy',
      hooks: [
        ...policyInterceptorHooks(options.policy ?? { workspace: '/work' }),
        ...(options.extraHooks ?? []),
      ],
    }),
  );
  registry.install(
    defineExtension({ name: 'kubic', tools: probeTools(world) }),
  );
  const harness = await Harness.open(
    new MemoryStorage(),
    { models, registry },
    BACKGROUND_CONTEXT,
  );
  openHarnesses.push(harness);
  const model = faux.getModel();
  const root = await harness.root(BACKGROUND_CONTEXT, {
    agent: { model: { provider: model.provider, modelId: model.id } },
  });
  return { harness, root, world };
}

async function drive(booted: Booted, prompt = 'go'): Promise<void> {
  const submission = await booted.root.submit(
    { type: 'input', content: prompt },
    BACKGROUND_CONTEXT,
  );
  const settled = await submission.wait(BACKGROUND_CONTEXT);
  expect(settled.status).toBe('done');
}

describe('policyInterceptorHooks on a real harness (issue #397)', () => {
  it('blocks a destructive bash call with a redacted reason the model sees as an error', async () => {
    const booted = await boot({
      calls: [
        { name: 'bash', args: { command: 'rm -rf /tmp/x token=abc123' } },
      ],
    });
    await drive(booted);
    const results = await toolResults(booted.root);
    expect(results).toHaveLength(1);
    expect(results[0]?.isError).toBe(true);
    expect(results[0]?.text).toContain('destructive command blocked');
    expect(results[0]?.text).toContain('token=[REDACTED]');
    expect(results[0]?.text).not.toContain('abc123');
    expect(await errorCodes(booted.root)).toEqual(['blocked']);
    expect(booted.world.calls).toHaveLength(0);
  });

  it('fails closed when a policy option throws, redacting the reason', async () => {
    const booted = await boot({
      calls: [{ name: 'bash', args: { command: 'ls -la' } }],
      policy: {
        workspace: '/work',
        isDestructive: () => {
          throw new Error('policy exploded token=SECRET');
        },
      },
    });
    await drive(booted);
    const results = await toolResults(booted.root);
    expect(results[0]?.isError).toBe(true);
    expect(results[0]?.text).toContain('policy exploded');
    expect(results[0]?.text).toContain('token=[REDACTED]');
    expect(results[0]?.text).not.toContain('SECRET');
    expect(booted.world.calls).toHaveLength(0);
  });

  it('blocks when any hook throws (fail closed)', async () => {
    const booted = await boot({
      calls: [{ name: 'ls', args: { path: '.' } }],
      extraHooks: [
        hook(ToolTask, {
          beforeTool: () => {
            throw new Error('guard exploded');
          },
        }),
      ],
    });
    await drive(booted);
    const results = await toolResults(booted.root);
    expect(results[0]?.isError).toBe(true);
    expect(results[0]?.text).toContain('guard exploded');
    expect(booted.world.calls).toHaveLength(0);
  });

  it('rewrites confined paths, and a later hook sees the rewritten arguments', async () => {
    const seen: Array<Record<string, unknown>> = [];
    const booted = await boot({
      calls: [
        { name: 'read', args: { path: '/etc/passwd' } },
        { name: 'write', args: { path: '/etc/cron.d/x', content: 'nope' } },
      ],
      extraHooks: [
        hook(ToolTask, {
          beforeTool: (call) => {
            seen.push({ ...call.arguments });
            return undefined;
          },
        }),
      ],
    });
    await drive(booted);
    expect(booted.world.calls.map((call) => call.args.path)).toEqual([
      '/work/etc/passwd',
      '/work/etc/cron.d/x',
    ]);
    expect(seen.map((args) => args.path)).toEqual([
      '/work/etc/passwd',
      '/work/etc/cron.d/x',
    ]);
  });

  it('lets read open an advertised skill root and confines everything else (issue #173)', async () => {
    const skill = '/home/u/.agents/skills/a/SKILL.md';
    const booted = await boot({
      calls: [
        { name: 'read', args: { path: skill } },
        { name: 'write', args: { path: skill, content: 'pwned' } },
        { name: 'edit', args: { path: skill, oldText: 'a', newText: 'b' } },
        { name: 'read', args: { path: '/etc/passwd' } },
        { name: 'ls', args: { path: '/home/u/.agents/skills/a' } },
      ],
      policy: {
        workspace: '/work',
        readRoots: ['/home/u/.agents/skills/a'],
      },
    });
    await drive(booted);
    expect(booted.world.calls.map((call) => call.args.path)).toEqual([
      skill,
      '/work/home/u/.agents/skills/a/SKILL.md',
      '/work/home/u/.agents/skills/a/SKILL.md',
      '/work/etc/passwd',
      '/work/home/u/.agents/skills/a',
    ]);
  });

  it('blocks network commands when network is none and admits them otherwise', async () => {
    const blocked = await boot({
      calls: [{ name: 'bash', args: { command: 'curl https://evil.example' } }],
      policy: { workspace: '/work', network: 'none' },
    });
    await drive(blocked);
    const blockedResults = await toolResults(blocked.root);
    expect(blockedResults[0]?.isError).toBe(true);
    expect(blockedResults[0]?.text).toContain('network command blocked');
    expect(blocked.world.calls).toHaveLength(0);

    const allowed = await boot({
      calls: [{ name: 'bash', args: { command: 'curl https://example.com' } }],
      policy: { workspace: '/work' },
    });
    await drive(allowed);
    const allowedResults = await toolResults(allowed.root);
    expect(allowedResults[0]?.isError).toBe(false);
    expect(allowed.world.calls).toHaveLength(1);
  });

  it('lets an approved call through and blocks a denied one (issue #16)', async () => {
    const denied = await boot({
      calls: [{ name: 'bash', args: { command: 'rm -rf /tmp/x' } }],
      policy: {
        workspace: '/work',
        approve: async () => ({ approved: false, reason: 'user said no' }),
      },
    });
    await drive(denied);
    const deniedResults = await toolResults(denied.root);
    expect(deniedResults[0]?.isError).toBe(true);
    expect(deniedResults[0]?.text).toContain('not approved: user said no');
    expect(denied.world.calls).toHaveLength(0);

    const allowed = await boot({
      calls: [{ name: 'bash', args: { command: 'rm -rf /tmp/x' } }],
      policy: {
        workspace: '/work',
        approve: async () => ({ approved: true, challenged: true }),
      },
    });
    await drive(allowed);
    const allowedResults = await toolResults(allowed.root);
    expect(allowedResults[0]?.isError).toBe(false);
    expect(allowed.world.calls).toHaveLength(1);
  });

  it('stands down the guards only for a challenged approval', async () => {
    const fast = await boot({
      calls: [{ name: 'read', args: { path: '/etc/passwd' } }],
      policy: {
        workspace: '/work',
        approve: async () => ({ approved: true, challenged: false }),
      },
    });
    await drive(fast);
    expect(fast.world.calls[0]?.args.path).toBe('/work/etc/passwd');
  });

  it('stands down per call id, never by tool name (issue #194)', async () => {
    let asks = 0;
    const booted = await boot({
      calls: [
        { name: 'bash', args: { command: 'rm -rf /tmp/x' } },
        { name: 'bash', args: { command: 'rm -rf /tmp/x' } },
      ],
      policy: {
        workspace: '/work',
        approve: async () => {
          asks += 1;
          // Only the first call is challenged and granted; the identical
          // second call is approved on the fast path and gets no stand-down.
          return asks === 1
            ? { approved: true, challenged: true }
            : { approved: true, challenged: false };
        },
      },
    });
    await drive(booted);
    expect(asks).toBe(2);
    expect(booted.world.calls).toHaveLength(1);
    const results = await toolResults(booted.root);
    expect(results[0]?.isError).toBe(false);
    expect(results[1]?.text).toContain('destructive command blocked');
  });

  it('keys the stand-down on the exact call, not the provider id (issue #194)', async () => {
    let asks = 0;
    const booted = await boot({
      turns: [
        [{ name: 'bash', args: { command: 'rm -rf /tmp/x' }, id: 'call_0' }],
        [{ name: 'read', args: { path: '/etc/passwd' }, id: 'call_0' }],
      ],
      policy: {
        workspace: '/work',
        approve: async () => {
          asks += 1;
          return asks === 1
            ? { approved: true, challenged: true }
            : { approved: true, challenged: false };
        },
      },
    });
    await drive(booted);
    expect(asks).toBe(2);
    // The approved bash call ran; the later read reused `call_0` and is
    // still confined — the stand-down was for the bash call's arguments.
    expect(booted.world.calls.map((call) => call.name)).toEqual([
      'bash',
      'read',
    ]);
    expect(booted.world.calls[1]?.args.path).toBe('/work/etc/passwd');
  });

  it('spends the stand-down after the approved call (issue #194)', async () => {
    let asks = 0;
    const booted = await boot({
      turns: [
        [{ name: 'bash', args: { command: 'rm -rf /tmp/x' }, id: 'call_0' }],
        [{ name: 'bash', args: { command: 'rm -rf /tmp/x' }, id: 'call_0' }],
      ],
      policy: {
        workspace: '/work',
        approve: async () => {
          asks += 1;
          // Only the first call is challenged and granted; the identical
          // repeat is approved on the fast path, so only a stale stand-down
          // could let it skip the guard.
          return asks === 1
            ? { approved: true, challenged: true }
            : { approved: true, challenged: false };
        },
      },
    });
    await drive(booted);
    expect(asks).toBe(2);
    expect(booted.world.calls).toHaveLength(1);
    const results = await toolResults(booted.root);
    expect(results[0]?.isError).toBe(false);
    expect(results[1]?.text).toContain('destructive command blocked');
  });

  it('never honours a stand-down for an empty call id (issue #194)', async () => {
    const booted = await boot({
      turns: [[{ name: 'bash', args: { command: 'rm -rf /tmp/x' }, id: '' }]],
      policy: {
        workspace: '/work',
        approve: async () => ({ approved: true, challenged: true }),
      },
    });
    await drive(booted);
    // The approval granted, but an empty id is not an identity: the guard
    // stays up rather than standing down for whatever comes next.
    expect(booted.world.calls).toHaveLength(0);
    const results = await toolResults(booted.root);
    expect(results[0]?.text).toContain('destructive command blocked');
  });
});

describe('policy interceptor state lifetime (issue #397)', () => {
  it('gives every factory call its own stand-down set', () => {
    // The same options object is reusable: the state lives in the factory
    // invocation, never in the options or in module scope. One invocation =
    // one boot's chain (solo.ts builds its kubic.policy extension per boot).
    const policy: PolicyInterceptorOptions = { workspace: '/work' };
    expect(policyInterceptorHooks(policy)[0]).not.toBe(
      policyInterceptorHooks(policy)[0],
    );
  });
});

describe('secret redaction (issue #192)', () => {
  // §36.1 rule 2: these strings reach the trajectory, the audit ledger and
  // the TUI, so every probe must come back with no secret material. Probes are faux material only.
  const PROBES: ReadonlyArray<readonly [string, readonly string[]]> = [
    ['Authorization: Bearer sk-live-123', ['sk-live-123']],
    ['Authorization hunter2', ['hunter2']],
    ['--authorization hunter2', ['hunter2']],
    ['authorization: basic dXNlcjpwYXNzd29yZA==', ['dXNlcjpwYXNzd29yZA==']],
    ['curl -H "Authorization: Bearer sk-live-123" https://x', ['sk-live-123']],
    ['curl -u admin:hunter2 https://x', ['admin:hunter2', 'hunter2']],
    ['curl -uadmin:hunter2 https://x', ['admin:hunter2', 'hunter2']],
    ['curl -U admin:hunter2 https://x', ['admin:hunter2']],
    ['curl --user admin:hunter2 https://x', ['admin:hunter2']],
    ['curl --user=admin:hunter2 https://x', ['admin:hunter2']],
    ['curl --proxy-user admin:hunter2 https://x', ['admin:hunter2']],
    [
      'git clone https://user:pw123456@github.com/x',
      ['user:pw123456', 'pw123456'],
    ],
    ['echo ghp_abcdef123456', ['ghp_abcdef123456']],
    ['echo AKIAFAUXTESTKEY00012', ['AKIAFAUXTESTKEY00012']],
    ['rm --token abc123 /x', ['abc123']],
  ];

  it.each(PROBES)('redacts every secret in %s', (probe, secrets) => {
    const out = redactSecrets(probe);
    for (const secret of secrets) expect(out).not.toContain(secret);
  });

  it('keeps ordinary flags, prose and user-only URLs readable', () => {
    for (const text of [
      'cp -u a b',
      'sort -u names.txt',
      'ssh://git@github.com/x',
      'echo user@example.com',
    ]) {
      expect(redactSecrets(text), text).toBe(text);
    }
  });

  it('redacts block reasons and approval summaries through the same path', () => {
    const reason = redactReason(
      'network command blocked: curl -H "Authorization: Bearer sk-live-123" https://x',
    );
    expect(reason).not.toContain('sk-live-123');
    expect(reason).toContain('[REDACTED]');
  });
});

describe('read-only shell allowlist (issue #161)', () => {
  it.each([
    'ls',
    'ls -la',
    'ls && cat a',
    'cat a | grep x',
    'head -n 5 f; tail -n 5 f',
    'wc -l f',
    'rg TODO src',
    'find . -name "*.ts"',
    'git status',
    'git -C /work diff HEAD',
    'git --no-pager log -1',
    'git show HEAD',
    'cat < f',
    // Single-quoted text is literal to the shell: no expansion, no redirect.
    "cat '$F'",
    "R='> out'; cat a",
  ])('allows %s', (command) => {
    expect(readOnlyViolation(command), command).toBeUndefined();
  });

  it.each([
    ['echo x > a', 'redirection'],
    ['echo x >> a', 'redirection'],
    ['ls > out.txt', 'redirection'],
    ['cat x | tee y', 'tee'],
    ['sed -i s/a/b/ f', 'sed -i'],
    ['sed --in-place s/a/b/ f', 'sed -i'],
    ['perl -pi -e s/a/b/ f', 'perl -i'],
    ['find . -exec rm {} ;', '-exec'],
    ['find . -delete', '-delete'],
    ['git commit -m x', 'commit'],
    ['git push', 'push'],
    ['npm test', 'npm'],
    ['node -e "fs.writeFileSync(1,2)"', 'node'],
    ['rm -rf x', 'rm'],
    ['ls | xargs rm', 'xargs'],
    // Review of #161: a single `&` is a separator too, or everything after
    // it escapes the allowlist.
    ['ls & git commit -m x', 'commit'],
    ['ls & sed -i s/a/b/ f', 'sed -i'],
    ['ls & tee y', 'tee'],
    ['ls & cp a b', 'cp'],
    // Shell expansion is never interpreted, so an allowed head verb must not
    // launder another command through it (fail closed on `$`).
    ['cat $(git commit -m x)', 'command substitution'],
    ['cat `npm test`', 'command substitution'],
    // Review round 2: process substitution runs a command too.
    ['cat <(git commit -m x)', 'process substitution'],
    ['cat <(sed -i s/a/b/ f)', 'process substitution'],
    ["R='> out'; cat a $R", 'shell-expanded'],
    ['cat a $R', 'shell-expanded'],
    ['cat "$R"', 'shell-expanded'],
    // Write/exec flags under an allowed verb.
    ['git diff --output=out.patch', '--output'],
    ['rg --pre "cat" pattern', '--pre'],
    // Review round 2: git global options that execute code.
    ['git -c diff.external=x diff', '-c'],
    ['git -c core.pager=x log', '-c'],
    ['git --exec-path=/tmp log', '--exec-path'],
    ['git --upload-pack=/tmp/x log', '--upload-pack'],
  ])('blocks %s naming %s', (command, needle) => {
    const reason = readOnlyViolation(command);
    expect(reason, command).toBeDefined();
    expect(reason, command).toContain(needle);
  });

  it('blocks a write anywhere in a pipeline, not only the head', () => {
    expect(readOnlyViolation('cat a; echo x > b')).toContain('redirection');
    expect(readOnlyViolation('ls && git commit -m x')).toContain('commit');
  });

  it('blocks non-allowlisted commands in the lane and lets the allowlist run', async () => {
    const booted = await boot({
      calls: [
        { name: 'bash', args: { command: 'ls && cat a' } },
        { name: 'bash', args: { command: 'echo x > a' } },
        { name: 'bash', args: { command: 'npm test' } },
      ],
      policy: { workspace: '/work', shell: 'read-only-allowlist' },
    });
    await drive(booted);
    const results = await toolResults(booted.root);
    expect(results[0]?.isError).toBe(false);
    expect(results[1]?.text).toContain('read-only');
    expect(results[2]?.text).toContain('read-only');
    expect(booted.world.calls.map((call) => call.args.command)).toEqual([
      'ls && cat a',
    ]);
  });

  it('runs the read-only presets’ checks and blocks writes, destructive and network calls (issue #157)', async () => {
    // The reviewer/planner presets run their targeted checks through this
    // level (`.kubic/roles/{reviewer,planner}.md`: `shell:
    // read-only-allowlist`, `git: false`), so a lane on it must let a
    // read-only command through — including read-only git, which is how the
    // reviewer inspects a diff without a git tool — and block everything that
    // writes, destroys or dials out.
    const booted = await boot({
      calls: [
        { name: 'bash', args: { command: 'git diff --stat' } },
        { name: 'bash', args: { command: 'ls && cat a' } },
        { name: 'bash', args: { command: 'echo x > a' } },
        { name: 'bash', args: { command: 'rm -rf build' } },
        { name: 'bash', args: { command: 'curl https://example.com' } },
      ],
      policy: { workspace: '/work', shell: 'read-only-allowlist' },
    });
    await drive(booted);
    const results = await toolResults(booted.root);
    expect(results[0]?.isError).toBe(false);
    expect(results[1]?.isError).toBe(false);
    // Each refusal names its own guard: the redirect is the read-only
    // allowlist, the `rm` the destructive guard, the `curl` the network
    // guard — all three blocked before the shell sees them.
    expect(results[2]?.isError).toBe(true);
    expect(results[2]?.text).toContain('read-only');
    expect(results[3]?.isError).toBe(true);
    expect(results[3]?.text).toMatch(/destructive/);
    expect(results[4]?.isError).toBe(true);
    expect(results[4]?.text).toMatch(/network/);
    // Only the two read-only commands reached the shell.
    expect(booted.world.calls.map((call) => call.args.command)).toEqual([
      'git diff --stat',
      'ls && cat a',
    ]);
  });

  it('leaves shell:true unchanged', async () => {
    const booted = await boot({
      calls: [
        { name: 'bash', args: { command: 'echo x > a' } },
        { name: 'bash', args: { command: 'npm test' } },
        { name: 'bash', args: { command: 'node -e "1"' } },
      ],
      policy: { workspace: '/work', shell: true },
    });
    await drive(booted);
    expect(
      (await toolResults(booted.root)).every((result) => !result.isError),
    ).toBe(true);
    expect(booted.world.calls).toHaveLength(3);
  });
});

describe('destructive/confine matchers (unit)', () => {
  it('matches destructive commands and confines paths', () => {
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
