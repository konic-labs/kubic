// Running the admin hooks: a before-tool refusal names the hook and its
// reason, a timeout fails closed, every run lands in the audit ledger, and a
// hook only sees the tools it names.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { tempDir } from '../../../../test/temp-dir.js';
import type { AdminHook } from '../config/index.js';
import {
  runAfterToolHooks,
  runBeforeToolHooks,
  runRunEndHooks,
} from './run-hooks.js';

function hook(
  event: AdminHook['event'],
  command: string,
  extra: Partial<AdminHook> = {},
): AdminHook {
  return { event, command, timeoutMs: 5_000, layer: 'enterprise', ...extra };
}

function ledger(workspace: string): Array<Record<string, unknown>> {
  return readFileSync(join(workspace, '.kubic', 'audit', 'audit.jsonl'), 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

const CALL = { tool: 'bash', arguments: { command: 'rm -rf build' } };

describe('runBeforeToolHooks', () => {
  it('refuses the call with the reason the hook printed, and audits it', async () => {
    const workspace = tempDir('hooks-run-');
    const refusal = await runBeforeToolHooks(
      [hook('beforeTool', 'echo "no deletes on this host"; exit 1')],
      CALL,
      { sessionId: 's-1', workspace },
    );
    expect(refusal).toBe(
      'refused by the hook "echo \\"no deletes on this host\\"; exit 1": no deletes on this host',
    );
    const [row] = ledger(workspace);
    expect(row).toMatchObject({
      who: 'config:hooks',
      what: 'hook:beforeTool',
      result: 'deny',
      reason: 'no deletes on this host',
    });
  });

  it('allows the call when every hook exits zero', async () => {
    const workspace = tempDir('hooks-run-');
    const refusal = await runBeforeToolHooks(
      [hook('beforeTool', 'cat > seen.json')],
      CALL,
      { sessionId: 's-1', workspace },
    );
    expect(refusal).toBeUndefined();
    const seen = JSON.parse(readFileSync(join(workspace, 'seen.json'), 'utf8'));
    expect(seen).toMatchObject({
      event: 'beforeTool',
      sessionId: 's-1',
      tool: { name: 'bash', arguments: { command: 'rm -rf build' } },
    });
    expect(ledger(workspace)[0]).toMatchObject({ result: 'ok' });
  });

  it('fails closed on a hook that times out, and audits it', async () => {
    const workspace = tempDir('hooks-run-');
    const refusal = await runBeforeToolHooks(
      [hook('beforeTool', 'sleep 10; true', { timeoutMs: 150 })],
      CALL,
      { sessionId: 's-1', workspace },
    );
    expect(refusal).toContain('the hook did not answer within 150 ms');
    expect(ledger(workspace)[0]).toMatchObject({
      what: 'hook:beforeTool',
      result: 'deny',
      reason: 'the hook did not answer within 150 ms',
    });
  });

  it('names a bare exit when the hook printed nothing', async () => {
    const refusal = await runBeforeToolHooks(
      [hook('beforeTool', 'exit 7')],
      CALL,
      { sessionId: 's-1', workspace: tempDir('hooks-run-') },
    );
    expect(refusal).toContain('the hook exited 7');
  });

  it('skips a hook whose tools leave this one out', async () => {
    const workspace = tempDir('hooks-run-');
    const refusal = await runBeforeToolHooks(
      [hook('beforeTool', 'exit 1', { tools: ['write'] })],
      CALL,
      { sessionId: 's-1', workspace },
    );
    expect(refusal).toBeUndefined();
  });

  it('stops at the first refusal', async () => {
    const workspace = tempDir('hooks-run-');
    await runBeforeToolHooks(
      [
        hook('beforeTool', 'echo first; exit 1'),
        hook('beforeTool', 'touch second'),
      ],
      CALL,
      { sessionId: 's-1', workspace },
    );
    expect(ledger(workspace)).toHaveLength(1);
  });
});

describe('runAfterToolHooks and runRunEndHooks', () => {
  it('hands the after-tool hook the result, and audits a failure as an error', async () => {
    const workspace = tempDir('hooks-run-');
    await runAfterToolHooks(
      [hook('afterTool', 'cat > after.json; exit 2')],
      { ...CALL, isError: false, output: 'removed' },
      { sessionId: 's-1', workspace },
    );
    const seen = JSON.parse(
      readFileSync(join(workspace, 'after.json'), 'utf8'),
    );
    expect(seen.tool).toMatchObject({
      name: 'bash',
      isError: false,
      output: 'removed',
    });
    expect(ledger(workspace)[0]).toMatchObject({
      what: 'hook:afterTool',
      result: 'error',
    });
  });

  it('hands the run-end hook how the run ended', async () => {
    const workspace = tempDir('hooks-run-');
    await runRunEndHooks(
      [hook('runEnd', 'cat > end.json')],
      { status: 'completed', summary: 'all done' },
      { sessionId: 's-1', workspace, model: 'faux/m' },
    );
    const seen = JSON.parse(readFileSync(join(workspace, 'end.json'), 'utf8'));
    expect(seen).toEqual({
      event: 'runEnd',
      sessionId: 's-1',
      workspace,
      model: 'faux/m',
      status: 'completed',
      summary: 'all done',
    });
    expect(ledger(workspace)[0]).toMatchObject({
      what: 'hook:runEnd',
      result: 'ok',
    });
  });
});
