// Installed solo policy: the classes and
// interceptor options the PRODUCTION path installs, and the composition order
// they produce on a real lane — permission wrapper innermost (so a tool
// outside the allowlist is refused at execute time, not merely absent from
// the list), telemetry outermost (so a DENIED attempt is still recorded).
// Faux provider only: zero network, zero paid tokens. The lane boots through
// the shared faux harness factory.

import { afterAll, describe, expect, it } from 'vitest';
import {
  bootFauxLane,
  type FauxLane,
  invokeRegisteredTool,
} from '../../agent/src/lane/test-harness.js';
import {
  PolicyDeniedError,
  type TelemetryRecord,
} from '../../agent/src/lane/wrap.js';
import {
  DEFAULT_PERMISSIONS,
  toolsForClasses,
} from '../../agent/src/permissions.js';
import { FakeExecutionEnv } from '../../exec/src/env.js';
import {
  type InstalledPolicy,
  installedPolicyPosture,
  installPolicy,
} from './approvals.js';

const lanes: FauxLane[] = [];

afterAll(async () => {
  for (const lane of lanes.splice(0)) await lane.cleanup();
});

async function bootWith(installed: InstalledPolicy) {
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

describe('installed policy defaults', () => {
  it('installs the documented solo default classes when no config supplies any', () => {
    const installed = installPolicy({ workspace: '/fake' });
    expect(installed.classes).toEqual({ ...DEFAULT_PERMISSIONS });
    expect(installed.posture.source).toBe('default');
    // The allowlist is derived from the classes, never hand-kept.
    expect(installed.posture.allowlist).toEqual(
      toolsForClasses({ ...DEFAULT_PERMISSIONS }),
    );
    // Deny-by-default tail: nothing network-capable, nothing credential-shaped.
    expect(installed.classes.network).toBe('none');
    expect(installed.classes.credentials).toBe('none');
  });

  it('takes config-sourced classes when the config layer supplies them', () => {
    const classes = {
      ...DEFAULT_PERMISSIONS,
      filesystem: 'read' as const,
      shell: false as const,
    };
    const installed = installPolicy({ workspace: '/fake', classes });
    expect(installed.classes).toEqual(classes);
    expect(installed.posture.source).toBe('config');
  });

  it('names the guards and the approval route it installs', () => {
    const installed = installPolicy({ workspace: '/fake' });
    expect(installed.posture.interceptors).toContain('destructive-guard');
    expect(installed.posture.interceptors).toContain('approval');
    // Guards are only meaningful with the routes they block through.
    expect(installed.posture.route).toBe('ask-user');
  });

  it('the doctor posture and the lane policy come from one derivation', () => {
    const input = { workspace: '/fake', sessionDir: '/fake/sessions/s1' };
    const installed = installPolicy(input);
    const posture = installedPolicyPosture(input);
    expect(installed.posture).toEqual(posture);
  });
});

describe('installed policy on a live lane', () => {
  it('narrows the active tools to the class-derived allowlist', async () => {
    const classes = {
      ...DEFAULT_PERMISSIONS,
      filesystem: 'read' as const,
      shell: false as const,
      git: false as const,
    };
    const { lane } = await bootWith(
      installPolicy({ workspace: '/fake', classes }),
    );
    const active = (await lane.activeTools()).sort();
    expect(active).toEqual([...toolsForClasses(classes)].sort());
    expect(active).not.toContain('bash');
    expect(active).not.toContain('write');
  });

  it('refuses a tool outside the allowlist at execute time with PolicyDeniedError', async () => {
    const classes = { ...DEFAULT_PERMISSIONS, shell: false as const };
    const { lane } = await bootWith(
      installPolicy({ workspace: '/fake', classes }),
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
    const classes = { ...DEFAULT_PERMISSIONS, shell: false as const };
    const { lane } = await bootWith(
      installPolicy({
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
