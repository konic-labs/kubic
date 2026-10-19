// The file tools write only inside the workspace: the exec seam refuses any
// other path, whatever an approval says. So an outside `write`/`edit` is
// refused by name before any ask — full access and autoApprove included —
// no card offers an allow the write could not honour, and nothing lands on
// disk or in the journal. A change outside the workspace goes through bash,
// which asks for outside-write.
// Faux provider only: zero network, zero paid tokens.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  attachSession,
  openSessionStore,
} from '@kubic/agent/lane/session-store';
import { readSessionEntries } from '@kubic/agent/lane/transcript';
import {
  BACKGROUND_CONTEXT,
  fauxAssistantMessage,
  fauxToolCall,
} from '@kubic/agent/pi-boundary';
import { fauxToolUse } from '@kubic/agent/test-support/lane-harness';
import { NodeExecutionEnv } from '@kubic/exec/env';
import { createNodeFileBridge } from '@kubic/exec/file-bridge';
import { installPolicy } from '@kubic/host/approvals';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { tempDir } from '../../../../test/temp-dir.js';
import { runHeadlessPrompt } from '../../src/run/command.js';
import { modelsWith } from '../fixtures/models.js';

beforeEach(() => {
  vi.stubEnv('KUBIC_NO_NOTICE', '1');
});

afterEach(() => {
  vi.unstubAllEnvs();
});

async function transcriptOf(root: string, sessionId: string): Promise<string> {
  const store = openSessionStore(root, createNodeFileBridge(root));
  const reopened = await attachSession(store, sessionId, BACKGROUND_CONTEXT);
  try {
    return JSON.stringify(
      await readSessionEntries(reopened.storage, BACKGROUND_CONTEXT),
    );
  } finally {
    await reopened.release(BACKGROUND_CONTEXT);
  }
}

describe('an outside write or edit', () => {
  it('is refused by name under full access, before anything runs', async () => {
    const workspace = tempDir('ws-outside-write-');
    const outside = tempDir('outside-write-target-');
    const target = join(outside, 'x.txt');
    const sessionsRoot = tempDir('sessions-outside-write-');
    const result = await runHeadlessPrompt(
      'write outside',
      { dangerouslySkipApprovals: true },
      {
        sessionsRoot,
        models: modelsWith([
          fauxToolUse([fauxToolCall('write', { path: target, content: 'x' })]),
          fauxAssistantMessage('done'),
        ]),
        env: new NodeExecutionEnv(workspace),
        warn: () => undefined,
      },
    );
    expect(existsSync(target)).toBe(false);
    const transcript = await transcriptOf(sessionsRoot, result.sessionId);
    expect(transcript.includes('outside the workspace')).toBe(true);
    expect(transcript.includes('path escapes cwd confinement')).toBe(false);
  });

  it('leaves an outside file untouched under an edit', async () => {
    const workspace = tempDir('ws-outside-edit-');
    const outside = tempDir('outside-edit-target-');
    const target = join(outside, 'x.txt');
    writeFileSync(target, 'before\n');
    const sessionsRoot = tempDir('sessions-outside-edit-');
    const result = await runHeadlessPrompt(
      'edit outside',
      { dangerouslySkipApprovals: true },
      {
        sessionsRoot,
        models: modelsWith([
          fauxToolUse([
            fauxToolCall('edit', {
              path: target,
              oldText: 'before',
              newText: 'after',
            }),
          ]),
          fauxAssistantMessage('done'),
        ]),
        env: new NodeExecutionEnv(workspace),
        warn: () => undefined,
      },
    );
    expect(readFileSync(target, 'utf8')).toBe('before\n');
    const transcript = await transcriptOf(sessionsRoot, result.sessionId);
    expect(transcript.includes('outside the workspace')).toBe(true);
  });

  it('never reaches the ask, so autoApprove cannot answer it', async () => {
    const workspace = tempDir('ws-outside-ask-');
    const answer = vi.fn(async () => ({
      approved: true as const,
      by: 'user',
    }));
    const policy = installPolicy({
      workspace,
      autoApprove: ['outside-write'],
      answer,
    });
    const verdict = await policy.ask({
      toolName: 'write',
      args: { path: join(tempDir('outside-ask-'), 'x.txt'), content: 'x' },
      toolCallId: 't1',
    });
    expect(verdict).toMatchObject({ approved: false });
    expect(JSON.stringify(verdict)).toContain('outside the workspace');
    expect(answer).not.toHaveBeenCalled();
    // An inside write is unaffected.
    expect(
      await policy.ask({
        toolName: 'write',
        args: { path: 'notes.txt', content: 'x' },
        toolCallId: 't2',
      }),
    ).toMatchObject({ approved: true });
  });
});
