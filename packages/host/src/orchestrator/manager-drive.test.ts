// The manager drive loop's safety gear (issue #431): the tool-call bound
// wrapper ends runaway lanes with one named reason, and the envelope
// carries the manager's own final words. RED first: the wrapper and the
// reader exist only here so far.
import { describe, expect, it, vi } from 'vitest';
import {
  defineTool,
  type ToolRegistration,
  Type,
} from '../../../worker/src/pi-boundary.js';
import {
  assertGitRef,
  describeLaneTransportError,
  isLaneTransportError,
  LaneDriveTimeoutError,
  MANAGER_DRIVE_DEADLINE_MS,
  MANAGER_MAX_SUBMISSIONS,
  MANAGER_MAX_TOOL_CALLS,
  MANAGER_TURN_BOUND_CODE,
  managerFinalMessage,
  waitLaneSubmissionWithDeadline,
  withAskTimeout,
  withManagerToolCallBound,
} from './manager-drive.js';
import type { ManagerToolset } from './manager-tools.js';

const callTool = (
  tool: ToolRegistration,
  args: Record<string, unknown> = {},
): Promise<unknown> =>
  (tool.execute as (...callArgs: never[]) => Promise<unknown>)(
    args as never,
    { callId: 'call-1' } as never,
    { signal: undefined } as never,
  );

function fakeToolset(calls: string[]): ManagerToolset {
  const fake = (name: string): ToolRegistration =>
    defineTool({
      name,
      description: `${name} fake`,
      parameters: Type.Object({}),
      execute: async () => {
        calls.push(name);
        return { content: [{ type: 'text' as const, text: name }] };
      },
    });
  const tools = {
    spawnAgent: fake('spawn_agent'),
    waitForAgent: fake('wait_for_agent'),
    collectResult: fake('collect_result'),
    inspectAgent: fake('inspect_agent'),
    cancelAgent: fake('cancel_agent'),
    sendToAgent: fake('send_to_agent'),
    workspaceDiff: fake('workspace_diff'),
    workspaceApply: fake('workspace_apply'),
    workspaceMerge: fake('workspace_merge'),
    askUser: fake('ask_user'),
    gitStatus: fake('git_status'),
    gitDiff: fake('git_diff'),
    gitLog: fake('git_log'),
  };
  return {
    ...tools,
    settle: {
      resultOf: () => undefined,
      noteSettled: () => undefined,
      seedSettled: () => undefined,
    },
  };
}

describe('withManagerToolCallBound (issue #431)', () => {
  it('passes calls through under the bound', async () => {
    const calls: string[] = [];
    const onTrip = vi.fn();
    const abortCurrent = vi.fn();
    const wrapped = withManagerToolCallBound(fakeToolset(calls), {
      maxToolCalls: 3,
      onTrip,
      abortCurrent,
    });
    await callTool(wrapped.spawnAgent);
    await callTool(wrapped.collectResult);
    expect(calls).toEqual(['spawn_agent', 'collect_result']);
    expect(onTrip).not.toHaveBeenCalled();
    expect(abortCurrent).not.toHaveBeenCalled();
  });

  it('past the bound every call trips, aborts and throws the named reason', async () => {
    const calls: string[] = [];
    const onTrip = vi.fn();
    const abortCurrent = vi.fn();
    const wrapped = withManagerToolCallBound(fakeToolset(calls), {
      maxToolCalls: 2,
      onTrip,
      abortCurrent,
    });
    await callTool(wrapped.spawnAgent);
    await callTool(wrapped.spawnAgent);
    // Refused adapters still count: a refusal loop is still a loop.
    await expect(callTool(wrapped.askUser)).rejects.toThrow(
      /manager_turn_bound/,
    );
    await expect(callTool(wrapped.askUser)).rejects.toThrow(
      /manager_turn_bound/,
    );
    // The two over-bound calls never reached an adapter.
    expect(calls).toEqual(['spawn_agent', 'spawn_agent']);
    expect(onTrip).toHaveBeenCalledTimes(2);
    expect(abortCurrent).toHaveBeenCalledTimes(2);
    expect(MANAGER_TURN_BOUND_CODE).toBe('manager_turn_bound');
  });

  it('the shipped backstops are exported and sane', () => {
    expect(MANAGER_MAX_TOOL_CALLS).toBe(200);
    expect(MANAGER_MAX_SUBMISSIONS).toBe(10);
  });
});

describe('withAskTimeout (issue #431)', () => {
  it('passes a prompt answer through and clears the bound', async () => {
    const out = await withAskTimeout(
      Promise.resolve({ answered: true as const, text: 'blue' }),
      20,
    );
    expect(out).toEqual({ answered: true, text: 'blue' });
  });

  it('a hanging seat resolves unanswered on the bound, never hangs', async () => {
    const hanging = new Promise<never>(() => undefined);
    const out = await withAskTimeout(hanging, 20);
    expect(out.answered).toBe(false);
    if (out.answered) return;
    expect(out.code).toBe('question_unanswered');
    expect(out.reason).toMatch(/20ms/);
  });
});

describe('assertGitRef (issue #431)', () => {
  it('accepts ordinary refs', () => {
    for (const ref of ['HEAD', 'main', 'kubic/s/run/a', 'v1.2.3', 'HEAD~1']) {
      expect(() => assertGitRef(ref)).not.toThrow();
    }
  });

  it('refuses flags, traversals and non-refs', () => {
    for (const ref of [
      '',
      '-evil',
      '--output=x',
      'a..b',
      'a@{1}',
      '.hidden',
      'trail.',
      'trail/',
      'x.lock',
      'a b',
      'wild*',
      'what?',
      'br[acket',
    ]) {
      expect(() => assertGitRef(ref), ref).toThrow(/invalid_args/);
    }
  });
});

describe('managerFinalMessage (issue #431)', () => {
  const entry = (messages: unknown[]): unknown => ({ model: messages });
  const text = (value: string) => ({
    role: 'assistant',
    content: [{ type: 'text', text: value }],
  });

  it('returns the last assistant text, collapsed to one line', () => {
    expect(
      managerFinalMessage([
        entry([text('first\nsecond')]) as never,
        entry([
          { role: 'toolResult', toolName: 'x', content: [] },
          text('merged  two   workers ✓'),
        ]) as never,
      ]),
    ).toBe('merged two workers ✓');
  });

  it('is undefined when the lane never spoke text', () => {
    expect(managerFinalMessage([])).toBeUndefined();
    expect(
      managerFinalMessage([
        entry([{ role: 'assistant', content: [] }]) as never,
      ]),
    ).toBeUndefined();
  });

  it('strips control characters and caps the length', () => {
    const long = `ok\x07${'w'.repeat(600)}`;
    const out = managerFinalMessage([entry([text(long)]) as never]);
    expect(out?.length).toBeLessThanOrEqual(501);
    expect(out?.includes(String.fromCharCode(7))).toBe(false);
    expect(out?.endsWith('…')).toBe(true);
  });
});

describe('lane fail-fast (issue #431, L-D34)', () => {
  it('classifies transport failures, never model or usage errors', () => {
    // Refused/shadowed/unresolved endpoints are transports.
    for (const error of [
      Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:9'), {
        code: 'ECONNREFUSED',
      }),
      Object.assign(new Error('request to https://x failed'), {
        code: 'ENOTFOUND',
      }),
      new Error('fetch failed'),
      new Error('socket hang up'),
      // Undici wraps the syscall in `cause`.
      new Error('fetch failed', {
        cause: Object.assign(new Error('connect ECONNREFUSED'), {
          code: 'ECONNREFUSED',
        }),
      }),
    ]) {
      expect(isLaneTransportError(error), String(error)).toBe(true);
      expect(describeLaneTransportError(error)).toMatch(/unreachable|refused/i);
    }
    // Model answers, usage errors and aborts are not transports.
    for (const error of [
      new Error('question_unanswered: the seat timed out'),
      new Error('spawn_denied: the scheduler is full'),
      new TypeError('cannot read properties of undefined'),
    ]) {
      expect(isLaneTransportError(error), String(error)).toBe(false);
      expect(describeLaneTransportError(error)).toBeUndefined();
    }
  });

  it('times out a hung wait, aborting the submission', async () => {
    let aborted = false;
    const hung = new Promise<never>(() => {});
    await expect(
      waitLaneSubmissionWithDeadline(hung, {
        remainingMs: 20,
        onTimeout: async () => {
          aborted = true;
        },
      }),
    ).rejects.toBeInstanceOf(LaneDriveTimeoutError);
    expect(aborted).toBe(true);
  });

  it('passes a fast wait through untouched', async () => {
    const settled = { marker: 'settled' };
    await expect(
      waitLaneSubmissionWithDeadline(Promise.resolve(settled), {
        remainingMs: 1000,
        onTimeout: async () => {
          throw new Error('must not time out');
        },
      }),
    ).resolves.toBe(settled);
  });

  it('the default drive deadline is bounded and sane', () => {
    expect(MANAGER_DRIVE_DEADLINE_MS).toBeGreaterThan(0);
    expect(MANAGER_DRIVE_DEADLINE_MS).toBeLessThanOrEqual(30 * 60 * 1000);
  });
});
