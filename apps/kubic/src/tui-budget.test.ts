// The TUI lane under an opt-in solo budget (issue #283; §71): the boot
// composes the extension budget gate, so a second tool call past
// maxToolCalls=1 is refused as a tool error naming toolCalls — while the
// lane itself keeps running. Faux provider only; temp dirs cleaned after.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NodeExecutionEnv } from '../../../packages/exec/src/env.js';
import { fauxToolUse } from '../../../packages/worker/src/lane/test-harness.js';
import {
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from '../../../packages/worker/src/pi-boundary.js';
import {
  loadExtensionStartup,
  prodExtensionStartupOptions,
} from './extension-startup.js';
import { bootTuiLane } from './tui-run.js';

const made: string[] = [];

function tmpRoot(prefix = 'kubic-tui-budget-'): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  made.push(dir);
  return dir;
}

beforeEach(() => {
  vi.stubEnv('KUBIC_NO_NOTICE', '1');
  vi.stubEnv('KUBIC_PROVIDER', 'faux');
});

afterEach(() => {
  vi.unstubAllEnvs();
  for (const dir of made.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

describe('tui --budget gate (issue #283)', () => {
  it('admits both calls without a budget (no gate, historical)', async () => {
    const workspace = tmpRoot('kubic-tui-nobudget-ws-');
    const target = join(workspace, 'note.txt');
    writeFileSync(target, 'hello\n');
    const faux = fauxProvider({ provider: 'fx', models: [{ id: 'a' }] });
    faux.setResponses([
      fauxToolUse([
        fauxToolCall('read', { path: target }),
        fauxToolCall('read', { path: target }),
      ]),
      fauxAssistantMessage('done'),
    ]);
    const models = createModels();
    models.setProvider(faux.provider);
    const boot = await bootTuiLane(undefined, {
      sessionsRoot: tmpRoot(),
      models,
      env: new NodeExecutionEnv(workspace),
    });
    const loop = boot.loop;
    if (loop === undefined) throw new Error('the prod boot returned no loop');
    try {
      const turn = await loop.runTurn('read it twice', {
        requestId: 'nobudget-read',
        context: loop.context,
        whenBusy: 'reject',
      });
      expect(turn.kind).toBe('completed');
      const entries = await loop.entries(loop.context);
      const results = entries.filter(
        (entry) => entry.kind === 'pi.tool-result',
      );
      expect(results).toHaveLength(2);
      expect(
        results.every((entry) => {
          const message = entry.model?.[0] as { isError?: boolean } | undefined;
          return message?.isError !== true;
        }),
      ).toBe(true);
    } finally {
      await boot.close?.();
    }
  });

  it('refuses the second tool call past maxToolCalls=1 as a tool error', async () => {
    const workspace = tmpRoot('kubic-tui-budget-ws-');
    const target = join(workspace, 'note.txt');
    writeFileSync(target, 'hello\n');
    const cwd = tmpRoot('kubic-tui-budget-cwd-');
    const extensions = await loadExtensionStartup('tui', cwd, {
      options: prodExtensionStartupOptions(cwd, { maxToolCalls: 1 }),
    });
    const faux = fauxProvider({ provider: 'fx', models: [{ id: 'a' }] });
    faux.setResponses([
      fauxToolUse([
        fauxToolCall('read', { path: target }),
        fauxToolCall('read', { path: target }),
      ]),
      fauxAssistantMessage('done'),
    ]);
    const models = createModels();
    models.setProvider(faux.provider);
    const boot = await bootTuiLane(undefined, {
      sessionsRoot: tmpRoot(),
      models,
      env: new NodeExecutionEnv(workspace),
      extensions,
    });
    const loop = boot.loop;
    if (loop === undefined) throw new Error('the prod boot returned no loop');
    try {
      const turn = await loop.runTurn('read it twice', {
        requestId: 'budget-read',
        context: loop.context,
        whenBusy: 'reject',
      });
      expect(turn.kind).toBe('completed');
      const entries = await loop.entries(loop.context);
      const results = entries
        .filter((entry) => entry.kind === 'pi.tool-result')
        .map((entry) => {
          const message = entry.model?.[0] as
            | { isError?: boolean; content?: unknown }
            | undefined;
          return {
            isError: message?.isError,
            text: JSON.stringify(message?.content ?? []),
          };
        });
      expect(results).toHaveLength(2);
      expect(results[0]?.isError).toBe(false);
      expect(results[1]?.isError, JSON.stringify(results)).toBe(true);
      expect(results[1]?.text).toContain('toolCalls');
    } finally {
      await boot.close?.();
    }
  });
});
