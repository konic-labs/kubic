// Policy interceptors as pi-durable ToolTask hooks.
// Every behaviour here runs through a REAL Harness over MemoryStorage with
// the faux provider: first-block-wins, throw-to-block and argument chaining
// are the harness's own hook semantics, not a hand-rolled stand-in.
import { win32 } from 'node:path';
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
  type JsonValue,
  MemoryStorage,
  Type,
} from '../../pi-boundary.js';
import { confinePath, isInsideRoot } from './confine.js';
import { defaultIsDestructive } from './detectors.js';
import { policyInterceptorHooks } from './hooks.js';
import { isNetworkCommand } from './network.js';
import { readOnlyViolation } from './read-only.js';
import { redactReason } from './redact.js';
import type { PolicyInterceptorOptions } from './types.js';

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

// The probe tools record what the tool layer received, so an interceptor's
// rewrite is observable at the seam the tool executes against.
function probeTools(world: World) {
  const record = (
    name: string,
    args: Record<string, unknown>,
  ): { output: Array<{ type: 'text'; text: string }> } => {
    world.calls.push({ name, args });
    return { output: [{ type: 'text', text: `${name} ran` }] };
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
  // A scripted multi-turn sequence (each inner array is one
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

describe('read-only shell allowlist', () => {
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
    // Review of: a single `&` is a separator too, or everything after
    // it escapes the allowlist.
    ['ls & git commit -m x', 'commit'],
    ['ls & sed -i s/a/b/ f', 'sed -i'],
    ['ls & tee y', 'tee'],
    ['ls & cp a b', 'cp'],
    // Shell expansion is never interpreted, so an allowed head verb must not
    // launder another command through it (fail closed on `$`).
    ['cat $(git commit -m x)', 'command substitution'],
    ['cat `npm test`', 'command substitution'],
    // Process substitution runs a command too.
    ['cat <(git commit -m x)', 'process substitution'],
    ['cat <(sed -i s/a/b/ f)', 'process substitution'],
    ["R='> out'; cat a $R", 'shell-expanded'],
    ['cat a $R', 'shell-expanded'],
    ['cat "$R"', 'shell-expanded'],
    // Write/exec flags under an allowed verb.
    ['git diff --output=out.patch', '--output'],
    ['rg --pre "cat" pattern', '--pre'],
    // Git global options that execute code.
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

  it('runs the read-only presets’ checks and blocks writes, destructive and network calls', async () => {
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

  it('confines Windows paths: drive letters, backslashes, a letter case aside', () => {
    expect(confinePath('C:\\work', 'notes.txt', win32)).toEqual({
      confined: 'C:\\work\\notes.txt',
      rewritten: false,
    });
    expect(confinePath('C:\\work', 'c:\\WORK\\sub\\f.txt', win32)).toEqual({
      confined: 'c:\\WORK\\sub\\f.txt',
      rewritten: false,
    });
    expect(confinePath('C:\\work', 'D:\\etc\\passwd', win32)).toEqual({
      confined: 'C:\\work\\etc\\passwd',
      rewritten: true,
    });
    expect(confinePath('C:\\work', '..\\work-evil\\x', win32)).toEqual({
      confined: 'C:\\work\\work-evil\\x',
      rewritten: true,
    });
    expect(confinePath('C:\\work', '\\\\server\\share\\x', win32)).toEqual({
      confined: 'C:\\work\\x',
      rewritten: true,
    });
  });

  it('holds a root and what is below it, nothing beside it', () => {
    expect(isInsideRoot('/work', '/work')).toBe(true);
    expect(isInsideRoot('/work', '/work/..hidden/x')).toBe(true);
    expect(isInsideRoot('/work', '/work-evil/x')).toBe(false);
    expect(isInsideRoot('/work', '/')).toBe(false);
    expect(isInsideRoot('C:\\work', 'C:\\work\\x', win32)).toBe(true);
    expect(isInsideRoot('C:\\work', 'D:\\work\\x', win32)).toBe(false);
  });

  it('keeps tilde/$VAR tokens workspace-relative for tool paths', () => {
    // The write/edit/read ops resolve a path with node `resolve(cwd, path)`
    // and never expand `~` or `$VAR`, so for a TOOL path these tokens are
    // literal workspace entries (`/work/~/.bashrc`) — confinePath is right to
    // leave them unrewritten. Shell targets are different: bash expands
    // them, so the host's bash outside-write detector (approvals/triggers.ts)
    // treats a `~`/`$VAR` prefix as outside, fail-closed — pinned in
    // approvals/detectors.test.ts.
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
    // Each entry pins one DESTRUCTIVE_PATTERNS arm or rmBlocked branch, so a
    // weakened pattern lets a destructive shape slip through and fails here.
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

  // A newline separates commands the way `;` does, so every shape is
  // recognised on any line of a script, CRLF line endings included.
  const SHAPES = [
    'rm -rf /',
    'rm -r -f build',
    'rm /etc/passwd',
    'mkfs.ext4 /dev/sda1',
    'shred -u secret.txt',
    'dd if=/dev/zero of=/dev/sda',
    'git clean -fdx',
    'chmod -R 777 .',
    'chown -R root .',
    'find . -name x -delete',
    'git push --force origin main',
    'git reset --hard HEAD~1',
    'git checkout -- .',
    'git restore .',
  ];
  const BEFORE = [
    'echo hi\n',
    'set -e\necho hi\n',
    'echo hi\r\n',
    'a\r\nb\r\n',
  ];
  it.each(
    SHAPES.flatMap((shape) =>
      BEFORE.map((before) => [`${before}${shape}`] as const),
    ),
  )('recognises %j on a later line', (command) => {
    expect(defaultIsDestructive(command, '/work')).toBe(true);
    expect(defaultIsDestructive(`${command}\r\n`, '/work')).toBe(true);
  });

  it.each([
    ['echo hi\nrm notes.txt', false],
    ['echo hi\r\nrm notes.txt\r\n', false],
    ['rm notes.txt\nrm /etc/passwd', true],
    ['git push origin main\necho -f', false],
    ['git log\necho reset --hard', false],
    ['find . -name x\necho -delete', false],
    ['chmod 644 a\necho -R', false],
  ])('reads a newline as a separator in %j', (command, expected) => {
    expect(defaultIsDestructive(command, '/work')).toBe(expected);
  });

  // `rm` is classified wherever it is the command that runs: after the
  // reserved words a command may follow, behind the wrappers that run their
  // arguments in place, as a path or an escaped word, and — a bulk delete,
  // whatever its flags — as the command of find's -exec family or of xargs.
  it.each([
    ['find . -exec rm -rf {} +', true],
    ['find . -name "*.ts" -exec rm {} +', true],
    ['find . -execdir rm {} \\;', true],
    ['find . -ok rmdir {} \\;', true],
    ['find . -exec /bin/rm {} +', true],
    ['find . -exec sudo rm {} +', true],
    ['xargs rm -rf < list', true],
    ['ls | xargs rm', true],
    ['xargs -0 -n1 rm', true],
    ['xargs -I {} rm {}', true],
    ['xargs -L 1 -P 4 rmdir', true],
    ['sudo rm -rf /var/www', true],
    ['sudo -u www rm /etc/passwd', true],
    ['env FOO=1 rm -rf build', true],
    ['env -u HOME rm -rf build', true],
    ['FOO=1 rm -rf build', true],
    ['nice -n 10 rm -rf build', true],
    ['timeout -s KILL 10 rm -rf build', true],
    ['time rm -rf build', true],
    ['nohup rm -rf build', true],
    ['command rm -rf build', true],
    ['exec rm -rf build', true],
    ['if true; then rm -rf build; fi', true],
    ['for f in a b; do rm -rf "$f"; done', true],
    ['{ rm -rf build; }', true],
    ['! rm -rf build', true],
    ['(rm -rf build)', true],
    ['\\rm -rf build', true],
    ['/bin/rm -rf build', true],
    ['RM -rf build', true],
    ['find . -delete', true],
    ['find . -name x -print', false],
    ['find . -name rm -print', false],
    ['xargs echo', false],
    ['xargs grep -l rm', false],
    ['sudo rm notes.txt', false],
    ['env FOO=1 rm notes.txt', false],
    ['echo rm -rf build', false],
    ['git rm -r --cached build', false],
    ['grep -rn rm .', false],
  ])('classifies the executed command in %j', (command, expected) => {
    expect(defaultIsDestructive(command, '/work')).toBe(expected);
  });

  it('fails closed when a run of wrappers is too long to read', () => {
    expect(defaultIsDestructive(`${'env '.repeat(200)}rm notes.txt`)).toBe(
      true,
    );
    expect(defaultIsDestructive(`${'nice -n 1 '.repeat(5000)}echo`)).toBe(true);
  });

  // Each new DESTRUCTIVE_PATTERNS arm pinned on its own, with a
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
    // A reset to another commit moves the branch: its commits leave history.
    ['git reset --soft HEAD~1', true],
    ['git reset --mixed HEAD~3', true],
    ['git reset HEAD~3', true],
    ['git reset 1a2b3c4d', true],
    ['git reset', false],
    ['git reset -- a.ts', false],
    ['git reset HEAD a.ts', false],
    // History and refs the journal never sees (its sweep skips .git/).
    ['git branch -D feature', true],
    ['git branch --delete --force feature', true],
    ['git branch -f main origin/main', true],
    ['git branch -d feature', false],
    ['git branch -m old new', false],
    ['git stash drop', true],
    ['git stash clear', true],
    ['git stash pop', false],
    ['git stash list', false],
    ['git reflog expire --expire=now --all', true],
    ['git gc --prune=now', true],
    ['git gc', false],
    ['git prune', true],
    ['git fetch --prune', false],
    ['git update-ref -d refs/heads/f', true],
    ['git tag -d v1.0', true],
    ['git tag v1.0', false],
    ['git filter-branch --tree-filter "rm x" HEAD', true],
    ['git filter-repo --path secrets --invert-paths', true],
    ['git rebase -i HEAD~3', true],
    ['git rebase main', true],
    ['git rebase --abort', false],
    ['git rebase --continue', false],
    ['git checkout -B main origin/main', true],
    ['git switch -C main', true],
    ['git switch --discard-changes main', true],
    ['git switch -c feature', false],
    ['git switch main', false],
    ['git worktree remove --force ../wt', true],
    ['git worktree list', false],
    // Infrastructure, cloud and data the journal cannot restore.
    ['terraform destroy -auto-approve', true],
    ['terraform apply -destroy', true],
    ['terraform state rm aws_instance.x', true],
    ['terraform plan', false],
    ['tofu destroy', true],
    ['pulumi destroy --yes', true],
    ['helm uninstall prod', true],
    ['helm list', false],
    ['aws s3 rm s3://bucket --recursive', true],
    ['aws s3 rb s3://bucket --force', true],
    ['aws ec2 terminate-instances --instance-ids i-1', true],
    ['aws rds delete-db-instance --db-instance-identifier x', true],
    ['aws s3 ls', false],
    ['gsutil rm -r gs://bucket', true],
    ['gcloud projects delete p', true],
    ['gcloud compute instances list', false],
    ['az group delete -n rg --yes', true],
    ['gh repo delete org/repo --yes', true],
    ['psql -c "DROP TABLE users"', true],
    ['psql -h db -c "truncate events"', true],
    ['mysql -e "DELETE FROM users"', true],
    ['psql <<SQL\ndrop database prod;\nSQL', true],
    ['redis-cli FLUSHALL', true],
    ['sqlite3 app.db "DROP TABLE t"', true],
    ['psql -c "select 1"', false],
    ['echo "drop table users"', false],
    ['dropdb prod', true],
    ['crontab -r', true],
    ['crontab -l', false],
    ['docker system prune -af', true],
    ['docker volume rm data', true],
    ['docker ps', false],
    ['npm unpublish pkg --force', true],
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
  ])('classifies %s as destructive=%s', (command, expected) => {
    expect(defaultIsDestructive(command, '/work')).toBe(expected);
  });
});

// `network: none` covers the clients a coding agent reaches the network
// with: the transfer tools wherever their name appears, and the tools whose
// subcommand decides, read at command position — so a commit message that
// says "fetch" asks nothing.
describe('network command matcher', () => {
  it.each([
    'curl https://example.com',
    'wget https://example.com',
    'socat - TCP:example.com:80',
    'ncat example.com 80',
    'git clone https://example.com/r.git',
    'git fetch origin',
    'git pull',
    'git ls-remote origin',
    'git -C sub fetch',
    'git -c http.proxy=x pull',
    'git remote update',
    'git submodule update --init',
    'git lfs pull',
    'gh api /user',
    'gh pr list',
    'docker pull alpine',
    'docker --context c push img',
    'docker image pull alpine',
    'podman login quay.io',
    'cargo fetch',
    'go get example.com/x',
    'go mod download',
    'npm view left-pad',
    'npm audit',
    'pnpm audit',
    'yarn npm info x',
    'pip download x',
    'pip3 download x',
    'rsync -a src/ host:/srv/',
    'rsync -a rsync://host/m/ dst/',
    'openssl s_client -connect example.com:443',
    'cd x && git fetch',
    'sudo docker pull alpine',
    'set -e\ngit pull',
  ])('%j reaches the network', (command) => {
    expect(isNetworkCommand(command)).toBe(true);
  });

  it.each([
    'git status',
    'git log --oneline',
    'git diff HEAD',
    'git push origin main',
    'git commit -m "fetch data and pull it"',
    'git log --grep clone',
    'docker ps',
    'docker images',
    'cargo build',
    'go build ./...',
    'npm test',
    'npm run build',
    'pip list',
    'rsync -a a/ b/',
    'gh help',
    'gh --version',
    'openssl rand -hex 8',
    'echo gh pr list later',
    'ls -la',
  ])('%j stays quiet', (command) => {
    expect(isNetworkCommand(command)).toBe(false);
  });
});
