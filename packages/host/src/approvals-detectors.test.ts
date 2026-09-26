// Detector gaps found in the post-#107 full-tree review (issue #131):
// shell-side outside-writes (`tee`, `cp`/`mv`/`install`), `sudo` privilege
// escalation, and destructive/network verbs behind command indirection.
// RED first per detector — each block below was written and watched fail
// before the detector it pins landed.
// The fix cycle after that review widened the indirection unwrap to a
// bounded fixpoint (eval-of-substitution, nested substitutions, mixed
// backtick/`$()`) and trimmed lifted-token delimiters; those blocks carry
// their own RED note, and the review's remaining shapes are PINNED as the
// documented gaps they are, never silently assumed handled.
// The classifiers here are the PRODUCTION ones (defaultIsDestructive,
// isNetworkCommand, confinePath) wired exactly like triggerContextFor, so a
// green run proves the detectors work against what a real run classifies
// with — not against a stub that would hide an unwrap bug.
// Stated heuristics (not sandbox parsing): the last-argument target
// heuristic for tee/cp/mv/install, and word-boundary `sudo` matching that
// deliberately over-triggers — a raised capability becomes an ask, never a
// silent grant.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  confinePath,
  defaultIsDestructive,
  isNetworkCommand,
} from '../../worker/src/lane/interceptors.js';
import {
  ApprovalService,
  CAPABILITIES,
  createApprovalAsk,
  detectTriggers,
  FileApprovalStore,
  type TriggerContext,
  validatePolicy,
} from './approvals.js';
import { parseTomlConfig } from './config/config.js';
import { ORCHESTRATOR_TRIGGERS } from './orchestrator/approvals/request.js';

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

describe('outside-write detectors (issue #131, slice 1)', () => {
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

  it('trims the substitution-lifted delimiter off a write target (fix cycle)', () => {
    const ctx = triggerContext();
    // A target lifted out of `$(…)` arrives with the substitution's closing
    // `)` (or `]`) glued on: `$(cp a /etc/b)` → `/etc/b)`. The boundary
    // check must still fire on a genuinely outside destination…
    expect(
      detectTriggers('bash', { command: 'echo $(cp a /etc/b)' }, ctx),
    ).toEqual(['outside-write']);
    expect(
      detectTriggers('bash', { command: 'echo $(tee /etc/cron.d/y)' }, ctx),
    ).toEqual(['outside-write']);
    // …and must not false-positive on an inside one just because of the
    // lifted delimiter. RED before the trim: `/work)` / `/work])` resolved
    // outside and raised a spurious outside-write ask.
    expect(
      detectTriggers('bash', { command: 'echo $(cp a /work)' }, ctx),
    ).toEqual([]);
    expect(
      detectTriggers('bash', { command: 'echo $(tee /work])' }, ctx),
    ).toEqual([]);
    // Trimming must not weaken the boundary check: `/work-evil` is still
    // outside `/work` (dist vs dist-x), and a plain inside path stays quiet.
    expect(
      detectTriggers('bash', { command: 'echo $(cp a /work-evil/b)' }, ctx),
    ).toEqual(['outside-write']);
    expect(
      detectTriggers('bash', { command: 'echo $(cp a /work/b)' }, ctx),
    ).toEqual([]);
  });
});

describe('privilege escalation + indirection (issue #131, slice 2)', () => {
  it('raises privilege-escalation for sudo anywhere in the command', () => {
    const ctx = triggerContext();
    // The acceptance case: sudo alone, and nothing else fires.
    expect(
      detectTriggers('bash', { command: 'sudo systemctl restart foo' }, ctx),
    ).toEqual(['privilege-escalation']);
    // The issue's motivating command: outside-write AND privilege-escalation.
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
    // RED before the iterative unwrap — all three of these were [] (silent),
    // the reviewed gap: the single-level regex truncated at the first `)`,
    // so a destructive verb behind a compound wrapper ran unasked.
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
    const dir = mkdtempSync(join(tmpdir(), 'approvals-131-'));
    const store = new FileApprovalStore(dir);
    const service = new ApprovalService({
      policy: validatePolicy({
        autoApprove: ['privilege-escalation'],
        maxPendingMs: 10,
      }),
      store,
    });
    const ask = createApprovalAsk(service, triggerContext(), store);
    // Two capabilities raise and only one is auto-approved: outside-write
    // has no answer here, so the ask denies instead of slipping through on
    // the approved one.
    await expect(
      ask({
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

describe('capability/trigger vocabulary parity (issue #131)', () => {
  it('keeps CAPABILITIES and ORCHESTRATOR_TRIGGERS in sorted parity', () => {
    // The two lists are one vocabulary: a capability detectTriggers can
    // raise must be an orchestrator trigger the envelope accepts, or a
    // worker ask dies as 'unknown approval trigger' before any surface can
    // render it. A single-list addition must fail HERE (loudly, in the
    // suite) instead of being refused only at runtime by the envelope.
    expect([...CAPABILITIES].sort()).toEqual([...ORCHESTRATOR_TRIGGERS].sort());
  });
});
