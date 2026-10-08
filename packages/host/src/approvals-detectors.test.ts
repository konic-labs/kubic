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
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  confinePath,
  defaultIsDestructive,
  isNetworkCommand,
} from '../../agent/src/lane/interceptors.js';
import { DEFAULT_PERMISSIONS } from '../../agent/src/permissions.js';
import {
  ApprovalService,
  CAPABILITIES,
  detectTriggers,
  installPolicy,
  type TriggerContext,
  triggerContextFor,
  validatePolicy,
} from './approvals.js';
import { parseTomlConfig } from './config/config.js';

const made: string[] = [];

function mkTmp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  made.push(dir);
  return dir;
}

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

describe('outside-write detectors', () => {
  it('raises outside-write when tee writes outside the workspace', () => {
    const ctx = triggerContext();
    expect(
      detectTriggers('bash', { command: 'cat x | tee /etc/cron.d/y' }, ctx),
    ).toEqual(['outside-write']);
    // Quotes around the target must not dodge the outside check.
    expect(
      detectTriggers('bash', { command: 'cat x | tee "/etc/cron.d/y"' }, ctx),
    ).toEqual(['outside-write']);
    // Inside targets stay quiet.
    expect(detectTriggers('bash', { command: 'tee inner.txt' }, ctx)).toEqual(
      [],
    );
    expect(
      detectTriggers('bash', { command: 'echo hi | tee -a build.log' }, ctx),
    ).toEqual([]);
  });

  it('raises outside-write on a copy destination outside the workspace (last-argument heuristic)', () => {
    const ctx = triggerContext();
    expect(detectTriggers('bash', { command: 'cp a /etc/b' }, ctx)).toEqual([
      'outside-write',
    ]);
    expect(
      detectTriggers('bash', { command: 'install -m 644 a /usr/local/b' }, ctx),
    ).toEqual(['outside-write']);
    // Inside destinations stay quiet.
    expect(detectTriggers('bash', { command: 'mv a ./b' }, ctx)).toEqual([]);
    expect(detectTriggers('bash', { command: 'mv a b' }, ctx)).toEqual([]);
    // The segment is scanned wherever it sits in the pipeline: a chained
    // tail must not hide an outside copy just because it is not last.
    expect(
      detectTriggers('bash', { command: 'cp a /etc/b && echo done' }, ctx),
    ).toEqual(['outside-write']);
  });

  it('treats a path sharing the workspace prefix as outside (path-boundary aware)', () => {
    const ctx = triggerContext();
    // `/work-evil/b` merely shares the `/work` prefix — it is outside.
    expect(
      detectTriggers('bash', { command: 'cp a /work-evil/b' }, ctx),
    ).toEqual(['outside-write']);
    expect(detectTriggers('bash', { command: 'cp a /work/b' }, ctx)).toEqual(
      [],
    );
    expect(
      detectTriggers('bash', { command: 'tee /work-evil/log' }, ctx),
    ).toEqual(['outside-write']);
  });

  it('raises no new triggers for plain builds and inside-workspace writes', () => {
    const ctx = triggerContext();
    expect(detectTriggers('bash', { command: 'npm install' }, ctx)).toEqual([
      'install',
    ]);
    expect(detectTriggers('bash', { command: 'cargo build' }, ctx)).toEqual([]);
    expect(detectTriggers('bash', { command: 'npm run build' }, ctx)).toEqual(
      [],
    );
    expect(detectTriggers('bash', { command: 'tee log.txt' }, ctx)).toEqual([]);
    expect(detectTriggers('bash', { command: 'cp a b' }, ctx)).toEqual([]);
    expect(
      detectTriggers('bash', { command: 'mv notes.txt archive/' }, ctx),
    ).toEqual([]);
  });

  it('trims the substitution-lifted delimiter off a write target', () => {
    const ctx = triggerContext();
    // A target lifted out of `$(…)` arrives with the substitution's closing
    // `)` glued on: `$(cp a /etc/b)` → `/etc/b)`. The boundary check must
    // still fire on a genuinely outside destination…
    expect(
      detectTriggers('bash', { command: 'echo $(cp a /etc/b)' }, ctx),
    ).toEqual(['outside-write']);
    expect(
      detectTriggers('bash', { command: 'echo $(tee /etc/cron.d/y)' }, ctx),
    ).toEqual(['outside-write']);
    // …and must not false-positive on an inside one just because of the lifted
    // delimiter. Before the trim, `/work)` resolved outside and raised a
    // spurious outside-write ask.
    expect(
      detectTriggers('bash', { command: 'echo $(cp a /work)' }, ctx),
    ).toEqual([]);
    // `]` is NOT a span closer: `$(tee /work])` names the literal path
    // `/work]`, a real sibling of the workspace, so it must raise (the
    // scoping block below covers that class).
    expect(
      detectTriggers('bash', { command: 'echo $(tee /work])' }, ctx),
    ).toEqual(['outside-write']);
    // Trimming must not weaken the boundary check: `/work-evil` is still
    // outside `/work` (dist vs dist-x), and a plain inside path stays quiet.
    expect(
      detectTriggers('bash', { command: 'echo $(cp a /work-evil/b)' }, ctx),
    ).toEqual(['outside-write']);
    expect(
      detectTriggers('bash', { command: 'echo $(cp a /work/b)' }, ctx),
    ).toEqual([]);
  });

  it('scopes the delimiter trim to lifted tokens; plain targets are never trimmed', () => {
    const ctx = triggerContext();
    // Trimming EVERY target token would silently drop a literal `)`/`]` at
    // the end of a real path and flip it from outside to inside — an ask would
    // become a silent grant (and there is no bash confine backstop for tee/cp
    // to catch it downstream). A plain token keeps its trailing characters
    // verbatim; only a token lifted out of `$(…)` loses the span's closer.
    // Without that scoping, every plain-target case below raises nothing.
    expect(detectTriggers('bash', { command: 'tee /work)' }, ctx)).toEqual([
      'outside-write',
    ]);
    expect(detectTriggers('bash', { command: "tee '/work)'" }, ctx)).toEqual([
      'outside-write',
    ]);
    expect(detectTriggers('bash', { command: "cp a '/work)'" }, ctx)).toEqual([
      'outside-write',
    ]);
    expect(
      detectTriggers('bash', { command: "echo x > '/work)'" }, ctx),
    ).toEqual(['outside-write']);
    expect(detectTriggers('bash', { command: 'tee /work]' }, ctx)).toEqual([
      'outside-write',
    ]);
    expect(
      detectTriggers('bash', { command: 'cp a /work/../work)' }, ctx),
    ).toEqual(['outside-write']);
    // The rule is general — any literal trailing character is path text,
    // not only the `)`/`]` the first cut trimmed: `tee /work,` names
    // `/work,`, a sibling of the workspace.
    expect(detectTriggers('bash', { command: 'tee /work,' }, ctx)).toEqual([
      'outside-write',
    ]);
    // The item-4 intent stays: a span-lifted token still loses exactly the
    // span's closer, so an inside destination stays quiet…
    expect(
      detectTriggers('bash', { command: 'echo $(cp a /work)' }, ctx),
    ).toEqual([]);
    // …while a genuinely outside lifted one still raises.
    expect(
      detectTriggers('bash', { command: 'echo $(cp a /etc/b)' }, ctx),
    ).toEqual(['outside-write']);
  });
});

describe('privilege escalation + indirection', () => {
  it('raises privilege-escalation for sudo anywhere in the command', () => {
    const ctx = triggerContext();
    // The acceptance case: sudo alone, and nothing else fires.
    expect(
      detectTriggers('bash', { command: 'sudo systemctl restart foo' }, ctx),
    ).toEqual(['privilege-escalation']);
    // The motivating command: outside-write AND privilege-escalation.
    expect(
      detectTriggers(
        'bash',
        { command: 'cat x | sudo tee /etc/cron.d/y' },
        ctx,
      ),
    ).toEqual(['outside-write', 'privilege-escalation']);
    // Word-boundary, anywhere — inside a substitution too.
    expect(detectTriggers('bash', { command: 'echo $(sudo id)' }, ctx)).toEqual(
      ['privilege-escalation'],
    );
    // Quoted context included: over-trigger is the documented, safe
    // direction — a raised capability becomes an ask, never a silent grant.
    expect(
      detectTriggers('bash', { command: 'echo "run sudo first"' }, ctx),
    ).toEqual(['privilege-escalation']);
    // Deduped: repeated sudo raises one capability.
    expect(detectTriggers('bash', { command: 'sudo sudo id' }, ctx)).toEqual([
      'privilege-escalation',
    ]);
  });

  it('raises the underlying capability for verbs behind indirection', () => {
    const ctx = triggerContext();
    // The acceptance cases: the substitution raises the UNDERLYING
    // capability instead of staying silent, and a benign substitution is
    // quiet. The production classifiers run on the unwrapped inner command
    // (`$(rm -rf /)` classifies as `rm -rf /`), which is exactly why the
    // wrapper must come off before the classifiers see it.
    expect(
      detectTriggers('bash', { command: 'echo "$(rm -rf /)"' }, ctx),
    ).toEqual(['destructive-shell']);
    expect(
      detectTriggers('bash', { command: 'echo "hello $(date)"' }, ctx),
    ).toEqual([]);
    expect(detectTriggers('bash', { command: 'echo `rm -rf /`' }, ctx)).toEqual(
      ['destructive-shell'],
    );
    expect(detectTriggers('bash', { command: 'eval "rm -rf /"' }, ctx)).toEqual(
      ['destructive-shell'],
    );
    expect(
      detectTriggers('bash', { command: 'eval rm -rf /tmp/x' }, ctx),
    ).toEqual(['destructive-shell']);
    expect(
      detectTriggers(
        'bash',
        { command: 'echo "$(curl https://x.example)"' },
        ctx,
      ),
    ).toEqual(['network']);
  });

  it('unwraps indirection to a fixpoint: eval-of-substitution and nesting', () => {
    const ctx = triggerContext();
    // A single-level unwrap truncates at the first `)`, so all three of these
    // would read as [] (silent) and a destructive verb behind a compound
    // wrapper would run unasked.
    expect(
      detectTriggers('bash', { command: 'eval $(rm -rf /)' }, ctx),
    ).toEqual(['destructive-shell']);
    expect(
      detectTriggers('bash', { command: 'echo $(echo $(rm -rf /))' }, ctx),
    ).toEqual(['destructive-shell']);
    expect(
      detectTriggers('bash', { command: 'echo `$(rm -rf /)`' }, ctx),
    ).toEqual(['destructive-shell']);
    // Deeper compounding unwraps too (balanced-paren scan)…
    expect(
      detectTriggers(
        'bash',
        { command: 'echo $(echo $(echo $(rm -rf /)))' },
        ctx,
      ),
    ).toEqual(['destructive-shell']);
    // …and quote/mixed wrappers unwrap through every layer.
    expect(
      detectTriggers('bash', { command: 'eval "$(rm -rf /)"' }, ctx),
    ).toEqual(['destructive-shell']);
    expect(
      detectTriggers('bash', { command: 'echo "$(echo `rm -rf /`)"' }, ctx),
    ).toEqual(['destructive-shell']);
    // The underlying-capability rule holds through unwrapping: what the
    // unwrapped inner command raises is what fires, nothing more.
    expect(
      detectTriggers(
        'bash',
        { command: 'eval $(curl https://x.example)' },
        ctx,
      ),
    ).toEqual(['network']);
    // Benign nesting stays quiet.
    expect(
      detectTriggers('bash', { command: 'echo $(echo $(date))' }, ctx),
    ).toEqual([]);
  });

  it('pins the effective nesting threshold: 31 levels raise, 32 stay silent', () => {
    const ctx = triggerContext();
    // The scan tracks at most MAX_UNWRAP_DEPTH (16) real openers; the
    // unmatched markers it pushes past the cap still consume closers, so
    // pairing shifts and the deepest RECORDED span carries (levels - 15)
    // `$(` layers: 16 layers at 31 nesting levels (the 16-step fixpoint
    // unwraps it fully, raising destructive-shell) and 17 at 32 (one layer
    // survives the 16 steps, so nothing classifies). Measured on the
    // production classifiers — the effective threshold is ~2x the cap,
    // stated in the module header and docs/cli/configuration.md.
    const nested = (levels: number) =>
      `echo ${'$('.repeat(levels)}rm -rf /${')'.repeat(levels)}`;
    expect(detectTriggers('bash', { command: nested(31) }, ctx)).toEqual([
      'destructive-shell',
    ]);
    expect(detectTriggers('bash', { command: nested(32) }, ctx)).toEqual([]);
  });

  it('pins the stated gap: interpreter-based verbs stay unraised', () => {
    const ctx = triggerContext();
    // `bash -c` / `python3 -c` / `node -e` hand the verb over as DATA to
    // another interpreter — a literal pattern cannot see it. These are the
    // documented gaps (module header + docs/cli/configuration.md), pinned
    // here so a future unwrap that closes them flips this test loudly
    // instead of drifting silently.
    expect(
      detectTriggers('bash', { command: 'bash -c "rm -rf /"' }, ctx),
    ).toEqual([]);
    expect(
      detectTriggers(
        'bash',
        { command: 'python3 -c "import os; os.system(\'rm -rf /\')"' },
        ctx,
      ),
    ).toEqual([]);
    expect(
      detectTriggers(
        'bash',
        { command: "node -e \"require('fs').rmSync('/', {recursive:true})\"" },
        ctx,
      ),
    ).toEqual([]);
  });

  it('keeps Set-deduped aggregation: one entry per distinct capability', () => {
    const ctx = triggerContext();
    expect(
      detectTriggers(
        'bash',
        { command: 'cat x | sudo tee /etc/cron.d/y && sudo tee /etc/z' },
        ctx,
      ),
    ).toEqual(['outside-write', 'privilege-escalation']);
  });

  it('keeps plain git commands trigger-free (regression battery)', () => {
    const ctx = triggerContext();
    expect(detectTriggers('bash', { command: 'git status' }, ctx)).toEqual([]);
    expect(
      detectTriggers('bash', { command: 'git log --oneline' }, ctx),
    ).toEqual([]);
    expect(
      detectTriggers('bash', { command: 'git commit -m "install docs"' }, ctx),
    ).toEqual([]);
  });

  it('round-trips privilege-escalation through config autoApprove', async () => {
    const parsed = parseTomlConfig(
      '[approvals]\nautoApprove = ["privilege-escalation"]\n',
    );
    const policy = validatePolicy(parsed.approvals);
    expect(policy.autoApprove).toEqual(['privilege-escalation']);
    expect(CAPABILITIES).toContain('privilege-escalation');
    const service = new ApprovalService({
      policy,
      awaitAnswer: () => {
        throw new Error('must not ask');
      },
    });
    await expect(
      service.request({
        key: 'pe-1',
        capability: 'privilege-escalation',
        toolName: 'bash',
        summary: 'privilege-escalation: sudo systemctl restart foo',
      }),
    ).resolves.toEqual({
      approved: true,
      by: 'autoApprove',
      justified: false,
    });
  });

  it('requires every raised capability: autoApprove covers only what it names', async () => {
    const dir = mkTmp('approvals-detectors-');
    const installed = installPolicy({
      workspace: dir,
      sessionDir: dir,
      autoApprove: ['privilege-escalation'],
      maxPendingMs: 10,
      // A seat that never answers: the service's bound denies the call.
      answer: async () => undefined,
    });
    // Two capabilities raise and only one is auto-approved: outside-write
    // has no answer here, so the ask denies instead of slipping through on
    // the approved one.
    await expect(
      installed.ask({
        toolName: 'bash',
        args: { command: 'cat x | sudo tee /etc/x' },
        toolCallId: 'c1',
      }),
    ).resolves.toEqual({
      approved: false,
      reason: 'approval timed out after 10ms',
    });
  });
});

describe('capability vocabulary', () => {
  it('lists every capability once', () => {
    expect(new Set(CAPABILITIES).size).toBe(CAPABILITIES.length);
  });
});

describe('shell-expanded and cd-relative write targets', () => {
  it('treats ~, ~user, $HOME, braced HOME and $VAR prefixes as outside', () => {
    const ctx = triggerContext();
    for (const command of [
      'echo x >> ~/.bashrc',
      'echo x > $HOME/.zshrc',
      // biome-ignore lint/suspicious/noTemplateCurlyInString: literal shell syntax
      'echo x > ${HOME}/.profile',
      'echo x > "$HOME/.profile"',
      'echo x > ~root/.bashrc',
      'echo x > ~',
      'echo x > $OUT/file',
      'cp a ~/.ssh/authorized_keys',
      'tee ~/.config/x',
      'mv a $XDG_CONFIG_HOME/x',
    ]) {
      expect(detectTriggers('bash', { command }, ctx), command).toContain(
        'outside-write',
      );
    }
  });

  it('resolves relative targets against a preceding cd/pushd', () => {
    const ctx = triggerContext();
    for (const command of [
      'cd /etc && echo x > y',
      'pushd /tmp && cp a b',
      'cd /etc; tee y',
      'cd "/etc" && echo x > y',
      "cd '/etc' && cp a b",
      'cd -P /etc && echo x > y',
      'cd `pwd` && echo x > y',
      'cd /etc && cd sub && echo x > y',
      'cd .. && echo x > y',
      'cd sub && cd ../.. && echo x > y',
      // An unknown destination fails closed for relative targets.
      'cd && echo x > y',
      'cd ~ && echo x > y',
      'cd $HOME/x && echo x > y',
      'cd - && echo x > y',
      'pushd sub && popd && echo x > y',
    ]) {
      expect(detectTriggers('bash', { command }, ctx), command).toEqual([
        'outside-write',
      ]);
    }
  });

  it('keeps inside targets quiet, with or without a cd inside the workspace', () => {
    const ctx = triggerContext();
    for (const command of [
      'echo x > ./out.txt',
      'cd sub && echo x > y',
      'cd /work/sub && cp a b',
      'cd "sub dir" ; echo x > y',
      'cp a b/c',
      'cd /etc && echo x > /work/y',
      'cd -P sub && echo x > y',
      'cd -L -P sub && echo x > y',
      'cd -LP  sub && echo x > y',
      "cd '/work/sub' && echo x > y",
      // A redirect BEFORE the cd is resolved against the workspace.
      'echo x > y && cd /etc',
    ]) {
      expect(detectTriggers('bash', { command }, ctx), command).toEqual([]);
    }
  });

  it('always raises for a target under ~/.kubic, even when the workspace is home', () => {
    const home = '/home/u';
    const ctx = triggerContext({
      workspace: home,
      home,
      isOutsideWorkspace: (path: string) => confinePath(home, path).rewritten,
    });
    expect(
      detectTriggers(
        'bash',
        { command: 'echo {} > ~/.kubic/sessions/abc/posture.json' },
        ctx,
      ),
    ).toEqual(['outside-write', 'kubic-state-write']);
    expect(
      detectTriggers(
        'bash',
        { command: 'echo {} > /home/u/.kubic/sessions/abc/posture.json' },
        ctx,
      ),
    ).toEqual(['outside-write', 'kubic-state-write']);
    expect(
      detectTriggers(
        'bash',
        { command: 'echo {} > .kubic/sessions/abc/posture.json' },
        ctx,
      ),
    ).toEqual(['outside-write', 'kubic-state-write']);
    expect(
      detectTriggers(
        'write',
        { path: '/home/u/.kubic/sessions/abc/posture.json' },
        ctx,
      ),
    ).toEqual(['outside-write', 'kubic-state-write']);
    // A sibling that merely shares the prefix is an ordinary inside path.
    expect(
      detectTriggers('bash', { command: 'echo x > .kubicrc' }, ctx),
    ).toEqual([]);
    expect(detectTriggers('write', { path: 'notes.txt' }, ctx)).toEqual([]);
  });

  it('wires the home directory through triggerContextFor', () => {
    const home = mkTmp('kubic-detectors-home-');
    const ctx = triggerContextFor(DEFAULT_PERMISSIONS, home, home);
    expect(ctx.home).toBe(home);
    expect(
      detectTriggers(
        'bash',
        { command: `echo {} > ${home}/.kubic/sessions/x/posture.json` },
        ctx,
      ),
    ).toEqual(['outside-write', 'kubic-state-write']);
  });
});

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
