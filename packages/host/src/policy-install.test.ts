// Installed solo policy (issue #86, acceptance criterion 1): the classes and
// interceptor options the PRODUCTION path installs, and the composition order
// they produce on a real lane — permission wrapper innermost (so a tool
// outside the allowlist is refused at execute time, not merely absent from
// the list), telemetry outermost (so a DENIED attempt is still recorded).
// Faux provider only: zero network, zero paid tokens. The lane boots through
// the shared faux harness factory (#401).

import { afterAll, describe, expect, it } from 'vitest';
import { SOLO_DEFAULTS, toolsForClasses } from '../../agents/src/policy.js';
import { FakeExecutionEnv } from '../../exec/src/env.js';
import {
  bootFauxLane,
  type FauxLane,
  invokeRegisteredTool,
} from '../../worker/src/lane/test-harness.js';
import {
  PolicyDeniedError,
  type TelemetryRecord,
} from '../../worker/src/lane/wrap.js';
import {
  type InstalledSoloPolicy,
  installedPolicyPosture,
  installSoloPolicy,
} from './approvals.js';

const lanes: FauxLane[] = [];

afterAll(async () => {
  for (const lane of lanes.splice(0)) await lane.cleanup();
});

async function bootWith(installed: InstalledSoloPolicy) {
  const env = new FakeExecutionEnv({});
  env.fs.writeFile('notes.txt', 'workspace notes\n');
  const lane = await bootFauxLane({
    env,
    policy: {
      classes: installed.classes,
      interceptors: installed.interceptors,
      contributions: installed.contributions,
    },
  });
  lanes.push(lane);
  return { lane, env };
}

describe('installed policy defaults (issue #86)', () => {
  it('installs the documented solo default classes when no config supplies any', () => {
    const installed = installSoloPolicy({ workspace: '/fake' });
    expect(installed.classes).toEqual({ ...SOLO_DEFAULTS });
    expect(installed.posture.source).toBe('default');
    // The allowlist is derived from the classes, never hand-kept.
    expect(installed.posture.allowlist).toEqual(
      toolsForClasses({ ...SOLO_DEFAULTS }),
    );
    // Deny-by-default tail: nothing network-capable, nothing credential-shaped.
    expect(installed.classes.network).toBe('none');
    expect(installed.classes.credentials).toBe('none');
  });

  it('takes config-sourced classes when the config layer supplies them', () => {
    const classes = {
      ...SOLO_DEFAULTS,
      filesystem: 'read' as const,
      shell: false as const,
    };
    const installed = installSoloPolicy({ workspace: '/fake', classes });
    expect(installed.classes).toEqual(classes);
    expect(installed.posture.source).toBe('config');
  });

  it('names the guards and the approval route it installs', () => {
    const installed = installSoloPolicy({ workspace: '/fake' });
    expect(installed.posture.interceptors).toContain('destructive-guard');
    expect(installed.posture.interceptors).toContain('approval');
    // Guards are only meaningful with the routes they block through.
    expect(installed.posture.route).toBe('ask-user');
  });

  it('the doctor posture and the lane policy come from one derivation', () => {
    const input = { workspace: '/fake', sessionDir: '/fake/sessions/s1' };
    const installed = installSoloPolicy(input);
    const posture = installedPolicyPosture(input);
    expect(installed.posture).toEqual(posture);
  });
});

describe('installed policy on a live lane (issue #86, criterion 1)', () => {
  it('narrows the active tools to the class-derived allowlist', async () => {
    const classes = {
      ...SOLO_DEFAULTS,
      filesystem: 'read' as const,
      shell: false as const,
      git: false as const,
    };
    const { lane } = await bootWith(
      installSoloPolicy({ workspace: '/fake', classes }),
    );
    const active = (await lane.activeTools()).sort();
    expect(active).toEqual([...toolsForClasses(classes)].sort());
    expect(active).not.toContain('bash');
    expect(active).not.toContain('write');
  });

  it('refuses a tool outside the allowlist at execute time with PolicyDeniedError', async () => {
    const classes = { ...SOLO_DEFAULTS, shell: false as const };
    const { lane } = await bootWith(
      installSoloPolicy({ workspace: '/fake', classes }),
    );
    // Registered (it is in the harness tool set) but not allowed: the
    // refusal must come from the execute-time wrapper, not from absence.
    expect(lane.registeredTool('bash')).toBeDefined();
    await expect(
      invokeRegisteredTool(lane, 'bash', { command: 'echo hi' }),
    ).rejects.toThrow(PolicyDeniedError);
    // The allowlisted tool passes the same wrapper and really executes.
    const readResult = (await invokeRegisteredTool(lane, 'read', {
      path: 'notes.txt',
    })) as { content: Array<{ text?: string }> };
    expect(readResult.content[0]?.text).toContain('workspace notes');
  });

  it('records the DENIED attempt in telemetry, proving telemetry wraps permission', async () => {
    const records: TelemetryRecord[] = [];
    const classes = { ...SOLO_DEFAULTS, shell: false as const };
    const { lane } = await bootWith(
      installSoloPolicy({
        workspace: '/fake',
        classes,
        telemetry: (record: TelemetryRecord) => records.push(record),
      }),
    );
    await expect(
      invokeRegisteredTool(lane, 'bash', { command: 'echo hi' }),
    ).rejects.toThrow(PolicyDeniedError);
    // If telemetry sat inside the permission wrapper it would never see a
    // denied call; the record is the observable proof of the order.
    expect(records.map((record) => record.toolName)).toContain('bash');
  });
});
