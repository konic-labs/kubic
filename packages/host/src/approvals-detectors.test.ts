// Detector gaps found in the post-#107 full-tree review (issue #131):
// shell-side outside-writes (`tee`, `cp`/`mv`/`install`), `sudo` privilege
// escalation, and destructive/network verbs behind command indirection.
// RED first per detector — each block below was written and watched fail
// before the detector it pins landed.
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
