// Detector coverage: shell-side outside-writes (`tee`, `cp`/`mv`/`install`),
// `sudo` privilege escalation, and destructive/network verbs behind command
// indirection. The indirection unwrap runs to a bounded fixpoint
// (eval-of-substitution, nested substitutions, mixed backtick/`$()`), and the
// substitution closer is trimmed off LIFTED tokens only: trimming every target
// token would turn a literal trailing `)`/`]` on a plain path into a silent
// grant (a real sibling of the workspace read as inside). The remaining shapes
// are PINNED as the documented gaps they are, never silently assumed handled.
// The classifiers here are the PRODUCTION ones (defaultIsDestructive,
// isNetworkCommand, confinePath) wired exactly like triggerContextFor, so a
// green run proves the detectors work against what a real run classifies with —
// not against a stub that would hide an unwrap bug. Stated heuristics (not
// sandbox parsing): the last-argument target heuristic for tee/cp/mv/install,
// and word-boundary `sudo` matching that deliberately over-triggers — a raised
// capability becomes an ask, never a silent grant.
import { mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  confinePath,
  defaultIsDestructive,
  isNetworkCommand,
} from '@kubic/agent/lane/interceptors';
import { DEFAULT_PERMISSIONS } from '@kubic/agent/permissions';
import { afterEach, describe, expect, it } from 'vitest';
import { tempDir } from '../../../../test/temp-dir.js';
import type { TriggerContext } from './triggers.js';
import { detectTriggers, triggerContextFor } from './triggers.js';

const made: string[] = [];

afterEach(() => {
  for (const dir of made.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

function triggerContext(
  overrides: Partial<TriggerContext> = {},
): TriggerContext {
  return {
    workspace: '/work',
    network: 'none',
    isDestructive: defaultIsDestructive,
    isNetworkCommand,
    // Production wiring (triggerContextFor): confinePath decides, and it is
    // path-boundary aware — `/work-evil/b` is outside a `/work` workspace.
    isOutsideWorkspace: (path: string) => confinePath('/work', path).rewritten,
    ...overrides,
  };
}

describe('every redirect is scanned', () => {
  it('raises outside-write for an outside redirect after an inside one', () => {
    const ctx = triggerContext();
    for (const command of [
      'echo a > notes.txt && echo b > /etc/cron.d/x',
      'echo a > notes.txt; cat y >> /etc/profile',
      'true | echo x > /etc/x',
      'echo a > a.txt || echo b >> /etc/x',
      'echo a > a.txt\necho b > /etc/x',
      // Several redirects inside ONE segment: each target is checked.
      'echo a > a.txt > /etc/x',
      'cmd >out.txt 2>/etc/err.log',
      // fd-prefixed, &> and clobber forms name a file the same way.
      'cmd 2> /etc/err.log',
      'cmd &> /etc/all.log',
      'cmd &>> /etc/all.log',
      'echo x >| /etc/x',
      'echo x 1>>/etc/x',
      'cmd >& /etc/all.log',
      'cd /etc && cmd >&out.log',
      "echo ok > a.txt; echo x > '/etc/q'",
      'echo x >/etc/x;ls',
    ]) {
      expect(detectTriggers('bash', { command }, ctx), command).toEqual([
        'outside-write',
      ]);
    }
  });

  it('raises nothing when every redirect stays inside', () => {
    const ctx = triggerContext();
    for (const command of [
      'echo a > a.txt; echo b > b.txt',
      'echo a > a.txt && echo b >> logs/b.txt',
      'cmd > out.txt 2>&1',
      'cmd 2>&1 | tee build.log',
      'cmd >& out.txt',
      'echo x >| a.txt',
      'cmd &> all.log',
      // Stream pseudo-devices are not persistent writes: a second-segment
      // `2>/dev/null` must not turn every quiet command into an ask.
      'cmd > out.txt 2>/dev/null',
      // fd duplication names no file, even where a relative token would
      // resolve outside.
      'cd /etc && ls 2>&1',
      'cd /etc && ls >&2 2>&-',
      'ls missing 2> /dev/null || echo none > /dev/stderr',
      'echo hi > /dev/stdout; echo x >/dev/tty',
      'echo x > /dev/fd/2',
    ]) {
      expect(detectTriggers('bash', { command }, ctx), command).toEqual([]);
    }
    // …but only those exact paths: other /dev targets are real devices.
    for (const command of [
      'echo x > /dev/sda',
      'echo x > /dev/null/../sda',
      'echo x > /dev/nullx',
    ]) {
      expect(detectTriggers('bash', { command }, ctx), command).toEqual([
        'outside-write',
      ]);
    }
  });

  it('keeps the span-closer trim for a lifted redirect target', () => {
    const ctx = triggerContext();
    expect(
      detectTriggers('bash', { command: 'echo $(echo x > /work)' }, ctx),
    ).toEqual([]);
    expect(
      detectTriggers(
        'bash',
        { command: 'echo $(echo x > a.txt; echo y > /etc/z)' },
        ctx,
      ),
    ).toEqual(['outside-write']);
  });
});

// `credentials` had no detector at all — its installed `none`
// default was informational, so `cat ~/.aws/credentials` or a read of a
// committed `.env` ran with no approval. The detector is lexical and
// documented as detection, not enforcement: over-triggering becomes
// an ask, never a silent grant.
describe('credential-access detector', () => {
  it('raises credentials for home credential paths in a bash command', () => {
    const ctx = triggerContext();
    for (const command of [
      'cat ~/.aws/credentials',
      'cat ${HOME}/.netrc',
      'cat /Users/x/.netrc',
      'cp ~/.netrc .',
      'base64 ~/.docker/config.json',
      'cat /home/x/.config/gh/hosts.yml',
      'cat ~/.config/gcloud/credentials.db',
      'cat ~/.kube/config',
      'cat ~/.npmrc',
      'cat ~/.pypirc',
      'cat ~/.git-credentials',
      'cat ~/.azure/accessTokens.json',
      'cat ~/.aws',
    ]) {
      expect(detectTriggers('bash', { command }, ctx), command).toEqual([
        'credentials',
      ]);
    }
    // The `.ssh` directory name also matches the network verb matcher
    // (`\bssh\b`), so those commands raise both — over-triggering by design.
    for (const command of [
      'cat $HOME/.ssh/id_rsa',
      'cat ~/.ssh/id_ed25519',
      'cat ~/.ssh/deploy.pem',
      'cat /Users/x/.ssh/id_ed25519',
    ]) {
      const found = detectTriggers('bash', { command }, ctx);
      expect(found, command).toContain('credentials');
    }
  });

  it('raises credentials for workspace credential files in a bash command', () => {
    const ctx = triggerContext();
    for (const command of [
      'cat .env',
      'cat src/.env.local',
      'cat "$PWD/.env.production"',
      'base64 deploy.pem',
      'cat id_rsa',
    ]) {
      expect(detectTriggers('bash', { command }, ctx), command).toEqual([
        'credentials',
      ]);
    }
    // The public half is not a credential.
    expect(
      detectTriggers('bash', { command: 'cat secrets/id_ed25519.pub' }, ctx),
    ).toEqual([]);
  });

  it('keeps ordinary commands and credential templates quiet', () => {
    const ctx = triggerContext();
    for (const command of [
      'cat src/index.ts',
      'cat .env.example',
      'cat .env.sample',
      'cat .env.template',
      'ls -la',
      'echo $PATH',
      'cat known_hosts',
      'node -e "console.log(process.env.HOME)"',
      'grep -r TODO src',
    ]) {
      expect(detectTriggers('bash', { command }, ctx), command).toEqual([]);
    }
    // `~/.ssh/known_hosts` is not credential material — but the path spells
    // the `ssh` verb, so the PRE-EXISTING network detector raises anyway.
    expect(
      detectTriggers('bash', { command: 'cat ~/.ssh/known_hosts' }, ctx),
    ).toEqual(['network']);
  });

  it('raises credentials for a read-family tool path onto a credential file', () => {
    const ctx = triggerContext();
    for (const [tool, args] of [
      ['read', { path: '/work/.env' }],
      ['read', { path: '.env.local' }],
      ['read', { path: 'config/deploy.pem' }],
      ['ls', { path: 'id_ed25519' }],
      ['grep', { root: '.env' }],
      ['find', { root: '/work/sub/.env.production' }],
      ['read', { path: '/Users/x/.ssh/id_rsa' }],
    ] as Array<[string, Record<string, unknown>]>) {
      expect(detectTriggers(tool, args, ctx), `${tool} ${args.path}`).toEqual([
        'credentials',
      ]);
    }
    for (const [tool, args] of [
      ['read', { path: '/work/src/index.ts' }],
      ['read', { path: '.env.example' }],
      ['read', { path: '/etc/passwd' }],
      ['ls', { path: '.' }],
      ['grep', { root: 'src' }],
      ['find', { root: '.' }],
    ] as Array<[string, Record<string, unknown>]>) {
      expect(detectTriggers(tool, args, ctx), `${tool} ${args.path}`).toEqual(
        [],
      );
    }
  });

  it('flags ~/.ssh children except the known-public files', () => {
    const ctx = triggerContext();
    // A widened arm: `~/.ssh/github` is a common key
    // name and `~/.ssh/*` a common glob — both are matched.
    for (const command of [
      'cat ~/.ssh/github',
      'cat ~/.ssh/*',
      'cat ~/.ssh/config',
      'cat ~/.ssh/id_rsa',
    ]) {
      expect(detectTriggers('bash', { command }, ctx), command).toContain(
        'credentials',
      );
    }
    // Public material is not a credential: the network scan still fires on
    // the `ssh` word, but the credential class must not.
    for (const command of [
      'cat ~/.ssh/known_hosts',
      'cat ~/.ssh/authorized_keys',
      'cat ~/.ssh/id_rsa.pub',
    ]) {
      expect(detectTriggers('bash', { command }, ctx), command).not.toContain(
        'credentials',
      );
    }
  });

  it('matches credential names case-insensitively (case-folding filesystems)', () => {
    const ctx = triggerContext();
    // macOS's default volume opens `.ENV` and `~/.AWS/credentials` exactly
    // like their lower-case spellings, so the detector folds case too.
    for (const command of [
      'cat ~/.AWS/credentials',
      'cat .ENV.local',
      'cat ID_RSA',
    ]) {
      expect(detectTriggers('bash', { command }, ctx), command).toEqual([
        'credentials',
      ]);
    }
    for (const [tool, args] of [
      ['read', { path: '.ENV' }],
      ['read', { path: 'deploy.PEM' }],
      ['read', { path: 'ID_RSA' }],
    ] as Array<[string, Record<string, unknown>]>) {
      expect(detectTriggers(tool, args, ctx), `${tool} ${args.path}`).toEqual([
        'credentials',
      ]);
    }
  });

  it('raises credentials for a grep/find name filter that selects credential files', () => {
    const ctx = triggerContext();
    // `include`/`nameContains` select files by SUBSTRING, so a short filter
    // reaches a committed `.env` without naming a path at all.
    for (const [tool, args] of [
      ['grep', { pattern: '.*', root: '.', include: '.env' }],
      ['grep', { pattern: 'KEY', root: 'src', include: 'env' }],
      ['grep', { pattern: '.*', root: '.', include: 'src/.env.local' }],
      ['grep', { pattern: '.*', root: '.', include: 'id_rsa' }],
      ['find', { root: '.', nameContains: '.pem' }],
      ['find', { root: '.', nameContains: 'key' }],
      ['find', { root: '.', nameContains: 'ID_RSA' }],
    ] as Array<[string, Record<string, unknown>]>) {
      expect(detectTriggers(tool, args, ctx), JSON.stringify(args)).toEqual([
        'credentials',
      ]);
    }
    // Ordinary filters and too-short needles stay quiet.
    for (const [tool, args] of [
      ['grep', { pattern: 'x', root: '.', include: '.ts' }],
      ['grep', { pattern: 'x', root: 'src', include: 'en' }],
      ['grep', { pattern: 'x', root: 'src' }],
      ['find', { root: '.', nameContains: 'test' }],
    ] as Array<[string, Record<string, unknown>]>) {
      expect(detectTriggers(tool, args, ctx), JSON.stringify(args)).toEqual([]);
    }
  });

  it('gates on the effective credentials level', () => {
    // The installed safe default (and an absent level) asks.
    expect(
      detectTriggers(
        'bash',
        { command: 'cat ~/.aws/credentials' },
        triggerContext({ credentials: 'none' }),
      ),
    ).toEqual(['credentials']);
    // `allowlist` carries no credential list and no credential tool
    // exists, so the lane enforces it as `none` — it asks too, exactly like
    // the domain-less network allowlist, never a silent grant.
    expect(
      detectTriggers(
        'bash',
        { command: 'cat ~/.aws/credentials' },
        triggerContext({ credentials: 'allowlist' }),
      ),
    ).toEqual(['credentials']);
  });
});

describe('git-dir writes raise kubic-state-write', () => {
  // Each case below relies on the isGitDirTarget check in detectTriggers;
  // without it, each one returns [].
  const ctx = triggerContext();
  it('raises for write/edit paths under .git/', () => {
    expect(
      detectTriggers('write', { path: '.git/hooks/pre-commit' }, ctx),
    ).toEqual(['kubic-state-write']);
    expect(detectTriggers('edit', { path: '.git/config' }, ctx)).toEqual([
      'kubic-state-write',
    ]);
  });

  it('raises for bash redirects, tee and cp targets under .git/', () => {
    expect(
      detectTriggers(
        'bash',
        { command: 'echo evil > .git/hooks/pre-commit' },
        ctx,
      ),
    ).toEqual(['kubic-state-write']);
    expect(
      detectTriggers(
        'bash',
        { command: 'cat payload | tee .git/hooks/post-checkout' },
        ctx,
      ),
    ).toEqual(['kubic-state-write']);
    expect(
      detectTriggers('bash', { command: 'cp hook.sh .git/hooks/x' }, ctx),
    ).toEqual(['kubic-state-write']);
  });

  it('raises for removing or moving hooks away (tampering by deletion)', () => {
    expect(
      detectTriggers('bash', { command: 'rm .git/hooks/pre-commit' }, ctx),
    ).toEqual(['kubic-state-write']);
  });

  it('stays quiet for normal files and .gitignore-adjacent names', () => {
    expect(detectTriggers('write', { path: 'src/index.ts' }, ctx)).toEqual([]);
    expect(detectTriggers('write', { path: '.gitignore' }, ctx)).toEqual([]);
    expect(
      detectTriggers('bash', { command: 'echo x > src/out.txt' }, ctx),
    ).toEqual([]);
  });
});

describe('git config mutation raises kubic-state-write', () => {
  // `git config core.hooksPath …` mutates .git/config with no
  // file-write target, so no approval fired at all.
  const ctx = triggerContext();
  it('raises for git config sets, unsets and adds', () => {
    expect(
      detectTriggers(
        'bash',
        { command: 'git config core.hooksPath /tmp/hooks' },
        ctx,
      ),
    ).toEqual(['kubic-state-write']);
    expect(
      detectTriggers(
        'bash',
        { command: 'git -C repo config --global user.name worker' },
        ctx,
      ),
    ).toEqual(['kubic-state-write']);
    expect(
      detectTriggers(
        'bash',
        { command: 'git config --unset core.fsmonitor' },
        ctx,
      ),
    ).toEqual(['kubic-state-write']);
    expect(
      detectTriggers('bash', { command: 'git config --add a.b c' }, ctx),
    ).toEqual(['kubic-state-write']);
  });

  it('stays quiet for git config reads', () => {
    expect(
      detectTriggers('bash', { command: 'git config --get user.name' }, ctx),
    ).toEqual([]);
    expect(
      detectTriggers('bash', { command: 'git config --list' }, ctx),
    ).toEqual([]);
    expect(
      detectTriggers('bash', { command: 'git config user.name' }, ctx),
    ).toEqual([]);
    expect(
      detectTriggers(
        'bash',
        { command: 'git config --global --get user.email' },
        ctx,
      ),
    ).toEqual([]);
  });
});

describe('git argv bypass spellings', () => {
  // Attached short options, display-modifier writes and the
  // push detector's twin miss all slipped past the guards.
  const ctx = triggerContext();
  it.each([
    'git -C/tmp/repo config core.hooksPath /dev/null',
    'git -cuser.name=x config a.b c',
    'git -C/tmp/repo config --add a.b c',
    'git config --show-origin a.b c',
    'git config --show-scope a.b c',
    'git config --show-origin --add a.b c',
  ])('raises for config write %s', (command) => {
    expect(detectTriggers('bash', { command }, ctx)).toEqual([
      'kubic-state-write',
    ]);
  });

  it.each([
    'git -C/tmp/repo config core.hooksPath',
    'git -cuser.name=x --get a.b',
    'git config --show-origin --get a.b',
    'git config --show-origin a.b',
  ])('stays quiet for config read %s', (command) => {
    expect(detectTriggers('bash', { command }, ctx)).toEqual([]);
  });

  it.each([
    'git -C/tmp/repo push origin main',
    'git -cuser.name=x push',
    'git --git-dir=/tmp/repo/.git push',
  ])('raises git-push for %s', (command) => {
    expect(detectTriggers('bash', { command }, ctx)).toEqual(['git-push']);
  });
});

// A read through a link opens the link's target, so a credential file
// reached through an innocently named link asks like the file itself. A
// target outside the workspace is the tool's to refuse (symlink_escape).
describe('credentials through a symlink', () => {
  it('asks for a link inside the workspace to a credential file', () => {
    const workspace = tempDir('creds-link-ws-');
    writeFileSync(join(workspace, '.env'), 'TOKEN=x\n');
    mkdirSync(join(workspace, 'docs'));
    symlinkSync(join(workspace, '.env'), join(workspace, 'docs', 'notes'));
    writeFileSync(join(workspace, 'plain.txt'), 'x\n');
    symlinkSync(join(workspace, 'plain.txt'), join(workspace, 'alias'));
    const linked = triggerContextFor(DEFAULT_PERMISSIONS, workspace, '/home/u');
    expect(detectTriggers('read', { path: 'docs/notes' }, linked)).toEqual([
      'credentials',
    ]);
    expect(detectTriggers('read', { path: 'alias' }, linked)).toEqual([]);
  });
});
