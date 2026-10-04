// Slice D: deterministic wrap composition (issue #15; EPIC K #393).
// Composition stays pre-registration: `composeTools` returns the tool
// registrations the Kubic extension is installed with, and the wrappers ride
// the pi-durable `execute(args, api, context)` signature unchanged.
import { afterEach, describe, expect, it } from 'vitest';
import { FakeExecutionEnv } from '../../../exec/src/env.js';
import {
  BACKGROUND_CONTEXT,
  createModels,
  createRegistry,
  defineExtension,
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
  Harness,
  MemoryStorage,
  type ToolRegistration,
  ToolResultEntry,
} from '../pi-boundary.js';
import { OperationKillRegistry } from './abort.js';
import { type KubicToolContext, kubicToolsToPiTools } from './tools-adapter.js';
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

function stubTool(log: string[]): ToolRegistration {
  return {
    name: 'read',
    description: 'stub',
    parameters: {},
    execute: (async () => {
      log.push('core');
      return { content: [] };
    }) as unknown as ToolRegistration['execute'],
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

function toolContext(env: FakeExecutionEnv): KubicToolContext {
  return {
    env,
    sessionId: 's1',
    agentId: 'root',
    kills: new OperationKillRegistry(),
  };
}

const open: Harness[] = [];
afterEach(async () => {
  for (const harness of open.splice(0)) {
    await harness.close(BACKGROUND_CONTEXT);
  }
});

/** The single composed tool, or a failure that names the setup mistake. */
function only(tools: ToolRegistration[]): ToolRegistration {
  const [tool] = tools;
  if (tool === undefined) throw new Error('no composed tool');
  return tool;
}

describe('wrap composition (issue #15, slice D)', () => {
  it('composes in listed order: telemetry(permission(core))', async () => {
    const log: string[] = [];
    const contributions = [
      recorder('permission', log),
      recorder('telemetry', log),
    ];
    expect(compositionOrder(contributions)).toBe('permission>telemetry');
    const tool = only(composeTools([stubTool(log)], contributions));
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
      only(composeTools(base, [permission, telemetry]))
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
      only(composeTools(base, [permission])).execute as unknown as ExecuteFn
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
    const denied = only(
      composeTools([{ ...stubTool(log), name: 'bash' }], contributions),
    );
    await expect((denied.execute as unknown as ExecuteFn)()).rejects.toThrow(
      PolicyDeniedError,
    );
    // Denied before the core ran, but the attempt is still timed/recorded.
    expect(log).toEqual([]);
    expect(records).toHaveLength(1);
    expect(records[0]?.toolName).toBe('bash');
    const allowed = only(composeTools([stubTool(log)], contributions));
    await (allowed.execute as unknown as ExecuteFn)();
    expect(log).toEqual(['core']);
    expect(records.map((record) => record.toolName)).toEqual(['bash', 'read']);
  });

  it('applies the wraps through the pi-durable harness: a denial is an error result', async () => {
    const env = new FakeExecutionEnv({});
    env.fs.writeFile('notes.txt', 'workspace notes\n');
    const records: TelemetryRecord[] = [];
    // Defense in depth behind the tool allowlist: read is registered but
    // denied at execute time, and telemetry still times the attempt.
    const tools = composeTools(kubicToolsToPiTools(toolContext(env)), [
      withPermissionCheck((name) => name !== 'read'),
      withTelemetry((record) => {
        records.push(record);
      }),
    ]);
    const faux = fauxProvider();
    const models = createModels();
    models.setProvider(faux.provider);
    faux.setResponses([
      fauxAssistantMessage(
        [
          fauxToolCall('read', { path: 'notes.txt' }, { id: 'call-read-1' }),
          fauxToolCall('ls', {}, { id: 'call-ls-1' }),
        ],
        { stopReason: 'toolUse' },
      ),
      fauxAssistantMessage('done'),
    ]);
    const registry = createRegistry();
    registry.install(defineExtension({ name: 'kubic', tools }));
    const harness = await Harness.open(
      new MemoryStorage(),
      { models, registry },
      BACKGROUND_CONTEXT,
    );
    open.push(harness);
    const model = faux.getModel();
    const root = await harness.root(BACKGROUND_CONTEXT, {
      agent: { model: { provider: model.provider, modelId: model.id } },
    });

    await (
      await root.submit(
        { type: 'input', content: 'read it' },
        BACKGROUND_CONTEXT,
      )
    ).wait(BACKGROUND_CONTEXT);

    const page = await root.entries({}, 100, undefined, BACKGROUND_CONTEXT);
    const results = [...page.items]
      .reverse()
      .filter((entry) => ToolResultEntry.is(entry))
      .map((entry) => {
        const message = entry.model?.[0];
        if (message?.role !== 'toolResult') return undefined;
        return {
          toolName: message.toolName,
          isError: message.isError,
          text: message.content
            .map((part) => (part.type === 'text' ? part.text : ''))
            .join(''),
        };
      })
      .filter((result) => result !== undefined);
    const denied = results.find((result) => result?.toolName === 'read');
    expect(denied?.isError).toBe(true);
    expect(denied?.text).toContain('denied by policy wrapper');
    const allowed = results.find((result) => result?.toolName === 'ls');
    expect(allowed?.isError).toBe(false);
    // Outermost by convention: every attempt is recorded, denied included.
    expect(records.map((record) => record.toolName).sort()).toEqual([
      'ls',
      'read',
    ]);
    expect(records.every((record) => record.durationMs >= 0)).toBe(true);
  });
});
