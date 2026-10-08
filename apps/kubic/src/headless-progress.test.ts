// The headless runner feeds the `kubic run` progress sink:
// begin once the lane booted (with the solo-notice decision), then one
// toolStart/toolEnd pair per tool call — and the three-line stderr warning
// block is replaced by the sink's compact notice. Faux provider, no network.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fauxToolUse } from '../../../packages/agent/src/lane/test-harness.js';
import type { MutableModels } from '../../../packages/agent/src/pi-boundary.js';
import {
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from '../../../packages/agent/src/pi-boundary.js';
import { NodeExecutionEnv } from '../../../packages/exec/src/env.js';
import type { RunProgressSink } from '../../../packages/host/src/run-cli.js';
import { runHeadlessPrompt } from './headless-run.js';

describe('headless run progress', () => {
  const made: string[] = [];
  function tmp(prefix: string): string {
    const dir = mkdtempSync(join(tmpdir(), prefix));
    made.push(dir);
    return dir;
  }

  beforeEach(() => {
    vi.stubEnv('KUBIC_NO_NOTICE', '');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    for (const dir of made.splice(0))
      rmSync(dir, { recursive: true, force: true });
  });

  function models(): MutableModels {
    const faux = fauxProvider({
      provider: 'faux',
      models: [{ id: 'small', contextWindow: 120000 }],
    });
    faux.setResponses([
      fauxToolUse([fauxToolCall('ls', { path: '.' })]),
      fauxAssistantMessage('listed it'),
    ]);
    const registry = createModels();
    registry.setProvider(faux.provider);
    return registry;
  }

  it('feeds begin and the tool events, and drops the warning block', async () => {
    const events: string[] = [];
    let notice: boolean | undefined;
    const progress: RunProgressSink = {
      begin: (info) => {
        notice = info.notice;
        events.push(`begin:${info.model ?? '?'}`);
      },
      toolStart: (event) => events.push(`start:${event.toolName}`),
      toolEnd: (event) =>
        events.push(`end:${event.toolName}:${event.isError ? 'error' : 'ok'}`),
      settle: () => events.push('settle'),
      receipt: () => events.push('receipt'),
    };
    const stderr: string[] = [];
    const spy = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation((chunk: unknown) => {
        stderr.push(String(chunk));
        return true;
      });
    try {
      const result = await runHeadlessPrompt(
        'list the files',
        { progress },
        {
          sessionsRoot: tmp('progress-sessions-'),
          models: models(),
          env: new NodeExecutionEnv(tmp('progress-cwd-')),
        },
      );
      expect(result.terminus).toBe('completed');
    } finally {
      spy.mockRestore();
    }
    expect(events).toEqual(['begin:faux/small', 'start:ls', 'end:ls:ok']);
    expect(notice).toBe(true);
    expect(stderr.join('')).not.toContain(
      'warning: solo mode has no isolation',
    );
  });

  it('keeps the warning block when there is no sink', async () => {
    const stderr: string[] = [];
    const spy = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation((chunk: unknown) => {
        stderr.push(String(chunk));
        return true;
      });
    try {
      await runHeadlessPrompt(
        'list the files',
        {},
        {
          sessionsRoot: tmp('progress-sessions-'),
          models: models(),
          env: new NodeExecutionEnv(tmp('progress-cwd-')),
        },
      );
    } finally {
      spy.mockRestore();
    }
    expect(stderr.join('')).toContain('warning: solo mode has no isolation');
  });
});
