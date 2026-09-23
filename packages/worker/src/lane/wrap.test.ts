// Slice D: deterministic wrap composition (issue #15).
import { describe, expect, it } from 'vitest';
import { SOLO_DEFAULTS } from '../../../agents/src/policy.js';
import { FakeExecutionEnv } from '../../../exec/src/env.js';
import type { AgentHarnessTool } from '../pi-boundary.js';
import {
  BACKGROUND_CONTEXT,
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
  MemorySessionRepo,
  type Session,
} from '../pi-boundary.js';
import { bootSoloLane, driveToSettled } from './solo.js';
import {
  composeTools,
  compositionOrder,
  type ExecuteFn,
  PolicyDeniedError,
  type TelemetryRecord,
  type ToolContribution,
  withPermissionCheck,
  withTelemetry,
} from './wrap.js';

function stubTool(log: string[]): AgentHarnessTool<never> {
  return {
    name: 'read',
    label: 'read',
    description: 'stub',
    parameters: {},
    execute: (async () => {
      log.push('core');
      return { content: [] };
    }) as unknown as AgentHarnessTool<never>['execute'],
  };
}

function recorder(id: string, log: string[]): ToolContribution {
  return {
    id,
    wrap:
      (next) =>
      async (...args) => {
        log.push(`${id}-pre`);
        try {
          return await next(...args);
        } finally {
          log.push(`${id}-post`);
        }
      },
  };
}

describe('wrap composition (issue #15, slice D)', () => {
  it('composes in listed order: telemetry(permission(core))', async () => {
    const log: string[] = [];
    const contributions = [
      recorder('permission', log),
      recorder('telemetry', log),
    ];
    expect(compositionOrder(contributions)).toBe('permission>telemetry');
    const [tool] = composeTools([stubTool(log)], contributions);
    await (tool.execute as unknown as ExecuteFn)();
    expect(log).toEqual([
      'telemetry-pre',
      'permission-pre',
      'core',
      'permission-post',
      'telemetry-post',
    ]);
  });

  it('rebuilds without the removed contribution and no inverse runs', async () => {
    const log: string[] = [];
    const permission = recorder('permission', log);
    const telemetry = recorder('telemetry', log);
    const base = [stubTool(log)];
    const first = compositionOrder([permission, telemetry]);
    await (
      composeTools(base, [permission, telemetry])[0]
        .execute as unknown as ExecuteFn
    )();
    expect(log).toEqual([
      'telemetry-pre',
      'permission-pre',
      'core',
      'permission-post',
      'telemetry-post',
    ]);
    // Removal is recomposition without the contribution — nothing to undo.
    log.length = 0;
    await (
      composeTools(base, [permission])[0].execute as unknown as ExecuteFn
    )();
    expect(log).toEqual(['permission-pre', 'core', 'permission-post']);
    // Re-adding yields the identical order string.
    expect(compositionOrder([permission, telemetry])).toBe(first);
  });

  it('denies disallowed tools at execute time and times the stack', async () => {
    const log: string[] = [];
    const records: TelemetryRecord[] = [];
    const contributions = [
      withPermissionCheck((name) => name !== 'bash'),
      withTelemetry((record) => {
        records.push(record);
      }),
    ];
    expect(compositionOrder(contributions)).toBe('permission>telemetry');
    const [denied] = composeTools(
      [{ ...stubTool(log), name: 'bash' }],
      contributions,
    );
    await expect((denied.execute as unknown as ExecuteFn)()).rejects.toThrow(
      PolicyDeniedError,
    );
    expect(records).toHaveLength(1);
    expect(records[0]?.toolName).toBe('bash');
    const [allowed] = composeTools([stubTool(log)], contributions);
    await (allowed.execute as unknown as ExecuteFn)();
    expect(log).toContain('core');
  });

  it('boots the solo lane with classes, interceptors, and wraps applied', async () => {
    const env = new FakeExecutionEnv({});
    env.fs.writeFile('notes.txt', 'workspace notes\n');
    const repo = new MemorySessionRepo();
    const session = await repo.create({}, BACKGROUND_CONTEXT);
    const faux = fauxProvider();
    const models = createModels();
    models.setProvider(faux.provider);
    faux.setResponses([
      fauxAssistantMessage([fauxToolCall('read', { path: 'notes.txt' })]),
      fauxAssistantMessage('done'),
    ]);
    const records: TelemetryRecord[] = [];
    const booted = await bootSoloLane({
      session,
      models,
      model: faux.getModel(),
      env,
      sessionId: session.metadata.id,
      agentId: 'root',
      policy: {
        classes: { ...SOLO_DEFAULTS, filesystem: 'read', shell: false },
        interceptors: { workspace: env.cwd },
        contributions: [
          withTelemetry((record) => {
            records.push(record);
          }),
        ],
      },
    });
    try {
      const active = await booted.lane.getActiveTools(BACKGROUND_CONTEXT);
      expect(active).not.toContain('bash');
      expect(active).not.toContain('write');
      expect(active).toContain('read');
      const admission = await booted.lane.accept(
        { kind: 'prompt', prompt: 'read the file' },
        BACKGROUND_CONTEXT,
      );
      if (!admission.ok) throw new Error('accept failed');
      const outcome = await driveToSettled(
        booted.lane,
        admission.value.operationId,
        BACKGROUND_CONTEXT,
      );
      expect(outcome.kind).toBe('settled');
      expect(records.map((record) => record.toolName)).toContain('read');
    } finally {
      await session.close(BACKGROUND_CONTEXT);
    }
  });
});
