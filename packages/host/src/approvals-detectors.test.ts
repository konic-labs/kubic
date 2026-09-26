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
import { describe, expect, it } from 'vitest';
import {
  confinePath,
  defaultIsDestructive,
  isNetworkCommand,
} from '../../worker/src/lane/interceptors.js';
import { detectTriggers, type TriggerContext } from './approvals.js';

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
