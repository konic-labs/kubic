// Bash approval-detector bypasses and autoApprove semantics. Each block pins
// a bypass the detectors once missed. The classifiers are the PRODUCTION ones
// (defaultIsDestructive, isNetworkCommand, confinePath) wired like
// triggerContextFor, and the lane tests drive the real installPolicy —
// faux/no provider, zero network. Detection stays lexical: a variable-built
// path (`$D/roles/r.md` with D set elsewhere), a symlink, `sed -i`, a script
// file or an interpreter still reach `.kubic/` without raising — those
// documented limits are pinned in the "still-documented misses" block so a
// future fix is a conscious change.
// biome-ignore-all lint/suspicious/noTemplateCurlyInString: `${HOME}` here is bash syntax under test, not a template literal
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  confinePath,
  defaultIsDestructive,
  isNetworkCommand,
} from '@kubic/agent/lane/interceptors';
import { fauxAssistantMessage, fauxToolCall } from '@kubic/agent/pi-boundary';
import { fauxToolUse } from '@kubic/agent/test-support/lane-harness';
import { NodeExecutionEnv } from '@kubic/exec/env';
import {
  ApprovalService,
  detectTriggers,
  installPolicy,
  KUBIC_STATE_WRITE,
  type TriggerContext,
  validatePolicy,
} from '@kubic/host/approvals';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { tempDir } from '../../../../test/temp-dir.js';
import { runHeadlessPrompt } from '../../src/run/command.js';
import { modelsWith } from '../fixtures/models.js';

const WS = '/work';

const HOME = '/home/tester';

afterEach(() => {
  vi.unstubAllEnvs();
});

function ctx(overrides: Partial<TriggerContext> = {}): TriggerContext {
  return {
    workspace: WS,
    network: 'none',
    isDestructive: defaultIsDestructive,
    isNetworkCommand,
    isOutsideWorkspace: (path: string) => confinePath(WS, path).rewritten,
    home: HOME,
    controlPlane: { home: HOME },
    ...overrides,
  };
}

function triggers(command: string, overrides: Partial<TriggerContext> = {}) {
  return detectTriggers('bash', { command }, ctx(overrides));
}

async function runBash(command: string, workspace: string) {
  return runHeadlessPrompt(
    'run it',
    {},
    {
      sessionsRoot: tempDir('kubic-bypass-sessions-'),
      models: modelsWith([
        fauxToolUse([fauxToolCall('bash', { command })]),
        fauxAssistantMessage('done'),
      ]),
      env: new NodeExecutionEnv(workspace),
    },
  );
}

describe('route=deny beats autoApprove on the lane', () => {
  it('denies an autoApprove capability the doctor says can never apply', async () => {
    const workspace = tempDir('kubic-approvals-bypass-deny-');
    const policy = installPolicy({
      workspace,
      route: 'deny',
      autoApprove: ['install'],
    });
    const verdict = await policy.ask({
      toolName: 'bash',
      args: { command: 'npm install left-pad' },
      toolCallId: 't1',
    });
    expect(verdict).toEqual({
      approved: false,
      reason: 'denied by policy route (capability: install)',
    });
    expect(policy.denials()).toEqual([
      {
        capability: 'install',
        toolName: 'bash',
        reason: 'denied by policy route (capability: install)',
      },
    ]);
  });

  it('denies a capability that no autoApprove entry names, without consulting a seat', async () => {
    const workspace = tempDir('kubic-approvals-bypass-deny-seat-');
    let asked = 0;
    const policy = installPolicy({
      workspace,
      route: 'deny',
      autoApprove: ['network'],
      answer: async () => {
        asked += 1;
        return { approved: true, by: 'user' };
      },
    });
    const verdict = await policy.ask({
      toolName: 'bash',
      args: { command: 'npm install left-pad' },
      toolCallId: 't1',
    });
    expect(verdict).toEqual({
      approved: false,
      reason: 'denied by policy route (capability: install)',
    });
    expect(asked).toBe(0);
  });

  it('headless with no autoApprove entry at all: the route is named, not the missing surface', async () => {
    const workspace = tempDir('kubic-approvals-bypass-deny-headless-');
    const policy = installPolicy({ workspace, route: 'deny' });
    const verdict = await policy.ask({
      toolName: 'bash',
      args: { command: 'npm install left-pad' },
      toolCallId: 't1',
    });
    expect(verdict).toEqual({
      approved: false,
      reason: 'denied by policy route (capability: install)',
    });
  });

  it('with route=ask-user the same autoApprove entry is approved (the control)', async () => {
    const workspace = tempDir('kubic-approvals-bypass-ask-');
    const policy = installPolicy({
      workspace,
      route: 'ask-user',
      autoApprove: ['install'],
    });
    const verdict = await policy.ask({
      toolName: 'bash',
      args: { command: 'npm install left-pad' },
      toolCallId: 't1',
    });
    expect(verdict).toEqual({ approved: true, challenged: true });
  });

  it('the service agrees: route=deny wins over autoApprove', async () => {
    const service = new ApprovalService({
      policy: validatePolicy({ route: 'deny', autoApprove: ['network'] }),
    });
    const verdict = await service.request({
      key: 'k',
      capability: 'network',
      toolName: 'bash',
      summary: 's',
    });
    expect(verdict).toEqual({
      approved: false,
      reason: 'denied by policy route (capability: network)',
    });
  });
});

describe('git-push detector is linear-time', () => {
  const PUSH_TIMEOUT_MS = 250;

  // The destructive matcher is stubbed out: it belongs to the agent and is
  // not what this block times — the git scan is.
  function timed(command: string): { found: string[]; ms: number } {
    const started = performance.now();
    const found = triggers(command, { isDestructive: () => false });
    return { found, ms: performance.now() - started };
  }

  it('200 repeated long global options classify as git-push in well under a second', () => {
    const chain = '--namespace '.repeat(200);
    const { found, ms } = timed(`git ${chain}push origin main`);
    expect(found).toContain('git-push');
    expect(ms).toBeLessThan(PUSH_TIMEOUT_MS);
  });

  it('a long chain that never reaches push fails fast too (no backtracking)', () => {
    const chain = '--namespace '.repeat(200);
    const { found, ms } = timed(`git ${chain}pull origin main`);
    expect(found).not.toContain('git-push');
    expect(ms).toBeLessThan(PUSH_TIMEOUT_MS);
  });

  it('the other alternation members and mixed chains stay linear', () => {
    for (const option of [
      '--git-dir',
      '--work-tree',
      '--exec-path',
      '--config-env',
      '-c',
      '-C',
      '--git-dir x',
      '-c a=b',
      '--no-pager',
    ]) {
      const { found, ms } = timed(`git ${`${option} `.repeat(200)}status`);
      expect(found, option).not.toContain('git-push');
      expect(ms, option).toBeLessThan(PUSH_TIMEOUT_MS);
    }
    const mixed = timed(
      `git ${'--namespace -c a=b --git-dir=x '.repeat(80)}remote add o u`,
    );
    expect(mixed.found).toContain('git-push');
    expect(mixed.ms).toBeLessThan(PUSH_TIMEOUT_MS);
  });

  it('many git words each opening a chain stay linear overall', () => {
    const command = 'git --namespace '.repeat(2000);
    const { found, ms } = timed(`${command}x`);
    expect(found).not.toContain('git-push');
    expect(ms).toBeLessThan(PUSH_TIMEOUT_MS);
    const end = timed(`${command}push`);
    expect(end.found).toContain('git-push');
    expect(end.ms).toBeLessThan(PUSH_TIMEOUT_MS);
  });

  it('an unterminated quote run cannot make the tokenizer quadratic', () => {
    // An odd quote count leaves one quote with no closer (an ordinary
    // character); `-C` takes the first quoted word, the second is neither an
    // option nor the verb, so the run ends without a push.
    const { found, ms } = timed(`git -C ${'" '.repeat(2001)}push`);
    expect(found).not.toContain('git-push');
    expect(ms).toBeLessThan(PUSH_TIMEOUT_MS);
  });

  // Reference oracle: the regex the detector shipped with. It is exponential
  // only on long chains, so a seeded sweep of short token sequences pins that
  // the linear rewrite recognises EXACTLY the same commands.
  const REFERENCE_GLOBALS = String.raw`(?:\s+(?:-[cC]\s+\S+|--(?:git-dir|work-tree|namespace|exec-path|config-env)(?:=\S+|\s+\S+)|--[a-z][a-z-]*|-[pP]))*`;
  const REFERENCE_PUSH = new RegExp(
    String.raw`(^|[|;&\s(])git${REFERENCE_GLOBALS}\s+push\b`,
    'i',
  );
  const REFERENCE_REMOTE = new RegExp(
    String.raw`(^|[|;&\s(])git${REFERENCE_GLOBALS}\s+remote\s+(add|set-url|remove|rename)\b`,
    'i',
  );

  it('recognises exactly what the reference regex recognised (seeded differential)', () => {
    const vocabulary = [
      'push',
      'push-x',
      'pushd',
      'remote',
      'add',
      'set-url',
      'show',
      'remove',
      'rename',
      '-c',
      '-C',
      '-p',
      '-P',
      '-x',
      '--namespace',
      '--namespace=a',
      '--namespace=',
      '--git-dir',
      '--git-dir=a',
      '--work-tree',
      '--exec-path',
      '--config-env',
      '--config-env=k=v',
      '--no-pager',
      '--Bare',
      '--foo=bar',
      'a',
      'k=v',
      'GIT',
    ];
    let seed = 0x2f6e2b1;
    const next = (bound: number): number => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return seed % bound;
    };
    let recognised = 0;
    for (let run = 0; run < 4000; run += 1) {
      const length = 1 + next(7);
      const words = ['git'];
      for (let index = 0; index < length; index += 1) {
        words.push(vocabulary[next(vocabulary.length)] ?? 'a');
      }
      const command = words.join(' ');
      const expected =
        REFERENCE_PUSH.test(command) || REFERENCE_REMOTE.test(command);
      if (expected) recognised += 1;
      expect(triggers(command).includes('git-push'), command).toBe(expected);
    }
    // The sweep must exercise both outcomes, or it proves nothing.
    expect(recognised).toBeGreaterThan(100);
    expect(recognised).toBeLessThan(3900);
  });
});

describe('git-push trigger boundary', () => {
  it.each([
    ['an absolute path to git', '/usr/bin/git push origin main'],
    ['a relative path to git', './node_modules/.bin/git push'],
    ['a backslash-escaped git', '\\git push origin main'],
    ['a quoted option argument', 'git -C "my dir" push'],
    ['a single-quoted option argument', "git -C 'my dir' push origin main"],
    ['a quoted -c value', 'git -c "user.name=A B" push'],
    ['a quoted long-option value', 'git --work-tree "a b" push'],
    ['bash -c', "bash -c 'git push'"],
    ['sh -c', 'sh -c "git push origin main"'],
    ['a backtick substitution', 'echo `git push`'],
    ['a $() substitution', 'echo $(git push)'],
    ['a subshell', '(git push)'],
    ['env wrapper with an absolute git', 'env -i /usr/bin/git push'],
    ['a plain push (regression)', 'git push'],
    ['a chained push (regression)', 'ls; git push'],
    ['a global option (regression)', 'git -C . push'],
    ['uppercase (regression)', 'GIT PUSH'],
    [
      'a quoted string naming the push (documented over-trigger)',
      'echo "git push later"',
    ],
  ])('%s raises git-push', (_name, command) => {
    expect(triggers(command)).toContain('git-push');
  });

  it.each([
    ['a command merely ending in git', 'mygit push'],
    ['digit', 'digit push'],
    ['a longer word', 'gitk push'],
    ['a hyphenated tool', 'git-lfs push'],
    ['a path ending in mygit', '/usr/bin/mygit push'],
    ['a quoted mygit', "bash -c 'mygit push'"],
    ['a quoted digit', 'echo "digit push"'],
    ['another verb', 'git pull origin main'],
    ['another verb after a quoted option', 'git -C "my dir" pull'],
    ['a verb that only starts with push', 'git pushd'],
    ['a global option that eats the verb', 'git -c push'],
    ['a word-glued suffix', 'git pushed origin'],
    ['the verb glued to git', 'gitpush origin'],
  ])('%s does not raise git-push', (_name, command) => {
    expect(triggers(command)).not.toContain('git-push');
  });

  it.each([
    ['/usr/bin/git remote add o u'],
    ['git -C "my dir" remote set-url o u'],
    ["bash -c 'git remote remove o'"],
    ['\\git remote rename a b'],
  ])('%s raises git-push (remote mutation)', (command) => {
    expect(triggers(command)).toContain('git-push');
  });

  it.each([
    ['git remote -v'],
    ['git remote show origin'],
    ['git -C "my dir" remote'],
    ['mygit remote add o u'],
    ['git remotes add o u'],
  ])('%s does not raise git-push', (command) => {
    expect(triggers(command)).not.toContain('git-push');
  });
});

describe('outside-write targets are read as the shell reads them', () => {
  it.each([
    ['a double-quoted dot-dot segment', 'echo x > ".."/x'],
    ['a single-quoted dot-dot segment', "echo x > '..'/x"],
    ['a quote inside the segment', 'echo x > .."/x"'],
    ['a backslash-escaped first dot', 'echo x > \\../x'],
    ['a backslash before the slash', 'echo x > ..\\/x'],
    ['a quote-split tee target', 'echo x | tee ".."/x'],
    ['a quote-split cp destination', 'cp a ".."/x'],
    ['a quote-split mv destination', "mv a '..'/x"],
    ['a trailing-quoted target (regression)', 'echo x > ../"x"'],
    ['a fully quoted target (regression)', 'echo x > "../x"'],
    ['a quote-split absolute path', 'echo x > "/e"tc/x'],
    [
      'a sibling that only shares the workspace prefix',
      'echo x > "/wo"rk-evil/x',
    ],
    ['a quoted expansion', 'echo x > "$HOME"/x'],
  ])('%s raises outside-write', (_name, command) => {
    expect(triggers(command)).toContain('outside-write');
  });

  it.each([
    ['a quoted inside segment', 'echo x > "sub"/x'],
    ['an escaped letter', 'echo x > "s\\ub"/x'],
    ['a quote-split path into the workspace', 'echo x > "/wo"rk/x'],
    ['a quoted dot segment', 'echo x > "."/x'],
    ['a quoted inside tee target', 'echo x | tee "sub"/x'],
    ['a quoted dot-dot that stays inside', 'echo x > "sub"/".."/x'],
  ])('%s stays inside', (_name, command) => {
    expect(triggers(command)).not.toContain('outside-write');
  });
});

describe('cd tracking recognises shell compound forms', () => {
  it.each([
    ['a brace group', '{ cd /tmp; echo x > kubic-bypass-brace-z; }'],
    ['then', 'if true; then cd /tmp; echo x > z; fi'],
    ['then on its own line', 'if true\nthen\n cd /tmp\n echo x > z\nfi'],
    ['do', 'for d in a; do cd /tmp; echo x > z; done'],
    ['else', 'if false; then :; else cd /tmp; echo x > z; fi'],
    ['elif', 'if false; then :; elif true; then cd /tmp; echo x > z; fi'],
    [
      'an elif condition',
      'if false; then :; elif cd /tmp; then echo x > z; fi',
    ],
    ['a negation', '! cd /tmp && echo x > z'],
    ['command', 'command cd /tmp && echo x > z'],
    ['builtin', 'builtin cd /tmp && echo x > z'],
    ['an if condition', 'if cd /tmp; then echo x > z; fi'],
    ['a negated if condition', 'if ! cd /tmp; then :; fi; echo x > z'],
    ['a while condition', 'while cd /tmp; do echo x > z; break; done'],
    ['an until condition', 'until cd /tmp; do :; done; echo x > z'],
    ['pushd in a brace group', '{ pushd /tmp; echo x > z; }'],
    ['a subshell (regression)', '(cd /tmp; echo x > z)'],
    ['a plain chain (regression)', 'cd /tmp && echo x > z'],
  ])('%s moves the cwd for later relative targets', (_name, command) => {
    expect(triggers(command)).toContain('outside-write');
  });

  it.each([
    ['an inside cd in a brace group', '{ cd sub; echo x > z; }'],
    ['an inside cd after then', 'if true; then cd sub; echo x > z; fi'],
    ['a word ending in cd', 'mycd /tmp; echo x > z'],
    ['a word ending in then', 'thencd /tmp; echo x > z'],
    ['a word ending in do', 'todo cd /tmp; echo x > z'],
    ['a longer command word', 'cdx /tmp; echo x > z'],
    ['a parameter named cd', 'echo ${cd}; echo x > z'],
    [
      'a cd argument named like a flag word',
      'cd sub && command ls && echo x > z',
    ],
  ])('%s leaves relative targets inside', (_name, command) => {
    expect(triggers(command)).not.toContain('outside-write');
  });

  it('the cwd change is ordered: a redirect before the cd is still inside', () => {
    expect(triggers('{ echo x > z; cd /tmp; }')).not.toContain('outside-write');
  });
});

describe('prod run path: the bypasses are challenged', () => {
  it('cd into .kubic/roles then a plain redirect is denied, named, and writes nothing', async () => {
    const workspace = tempDir('kubic-bypass-ws-');
    mkdirSync(join(workspace, '.kubic', 'roles'), { recursive: true });
    const result = await runBash(
      'cd .kubic/roles && echo pwned > r.md',
      workspace,
    );
    expect(result.terminus).toBe('approval_denied');
    expect(result.summary).toContain(KUBIC_STATE_WRITE);
    expect(existsSync(join(workspace, '.kubic', 'roles', 'r.md'))).toBe(false);
  });

  it('a brace-group cd to an outside directory is an outside-write ask, not a silent write', async () => {
    const workspace = tempDir('kubic-bypass-ws-');
    const outside = tempDir('kubic-bypass-out-');
    const result = await runBash(
      `{ cd ${outside}; echo x > kubic-bypass-brace-z; }`,
      workspace,
    );
    expect(result.terminus).toBe('approval_denied');
    expect(result.summary).toContain('outside-write');
    expect(existsSync(join(outside, 'kubic-bypass-brace-z'))).toBe(false);
  });

  it('an absolute-path git push is challenged before it runs', async () => {
    const workspace = tempDir('kubic-bypass-ws-');
    const result = await runBash('/usr/bin/git push origin main', workspace);
    expect(result.terminus).toBe('approval_denied');
    expect(result.summary).toContain('git-push');
  });

  it('a 200-repeat option chain does not stall the run', async () => {
    const workspace = tempDir('kubic-bypass-ws-');
    const started = Date.now();
    const result = await runBash(
      `echo git ${'--namespace '.repeat(200)}`,
      workspace,
    );
    expect(result.terminus).toBe('completed');
    expect(Date.now() - started).toBeLessThan(10_000);
  });
});
