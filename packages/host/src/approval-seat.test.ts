// The installed policy's answer seat. The interactive TUI is a command that
// CAN, so the policy must consult a seat when one is attached — and keep the
// immediate refusal (no 60s stall) when one is not.
//
// Faux provider only: zero network, zero paid tokens. The lane is real and
// boots through the shared faux harness factory.
import { describe, expect, it } from 'vitest';
import {
  bootFauxLane,
  fauxToolUse,
} from '../../agent/src/lane/test-harness.js';
import {
  fauxAssistantMessage,
  fauxToolCall,
} from '../../agent/src/pi-boundary.js';
import {
  type ApprovalVerdict,
  installPolicy,
  NO_ANSWER_SURFACE_REASON,
} from './approvals.js';

// The seat as the TUI supplies it: an ask that resolves with the user's
// decision. `undefined` models "nobody answered" (the seat was not attached).
type Seat = (request: {
  key: string;
  capability: string;
  toolName: string;
}) => Promise<ApprovalVerdict | undefined>;

async function runDestructive(
  seat: Seat | undefined,
  command = 'rm -rf /tmp/x',
): Promise<{ terminus: string; toolResults: string[]; asks: number }> {
  let asks = 0;
  const installed = installPolicy({
    workspace: '/fake',
    ...(seat === undefined
      ? {}
      : {
          answer: (request) => {
            asks += 1;
            return seat({
              key: request.key,
              capability: String(request.capability),
              toolName: request.toolName,
            });
          },
        }),
  });
  const lane = await bootFauxLane({
    policy: {
      classes: installed.classes,
      interceptors: installed.interceptors,
      contributions: installed.contributions,
    },
    responses: [
      fauxToolUse([fauxToolCall('bash', { command })]),
      fauxAssistantMessage('done'),
    ],
  });
  try {
    const outcome = await lane.run('clean up');
    const results = await lane.toolResults();
    return {
      terminus: outcome.status,
      toolResults: results.map((result) => result.text),
      asks,
    };
  } finally {
    await lane.cleanup();
  }
}

describe('installed policy answer seat', () => {
  it('lets an approving seat resolve the challenged call', async () => {
    const result = await runDestructive(async () => ({
      approved: true,
      by: 'allow-once',
    }));
    expect(result.asks).toBe(1);
    // The call really ran: the refusal is nowhere and the command executed.
    expect(result.toolResults.join('\n')).not.toContain(
      'no approval surface is installed',
    );
    expect(result.toolResults.join('\n')).not.toContain('not approved');
    expect(result.terminus).toBe('completed');
  });

  it('refuses the call when the seat denies it', async () => {
    const result = await runDestructive(async () => ({
      approved: false,
      reason: 'denied by the user',
    }));
    expect(result.asks).toBe(1);
    expect(result.toolResults.join('\n')).toContain('not approved');
    expect(result.toolResults.join('\n')).toContain('denied by the user');
  });

  it('keeps the immediate no-surface refusal when no seat is attached', async () => {
    // The headless path is unchanged: no seat means no wait, no stall.
    const result = await runDestructive(undefined);
    expect(result.asks).toBe(0);
    expect(result.toolResults.join('\n')).toContain(
      'no approval surface is installed',
    );
    expect(result.toolResults.join('\n')).toContain(
      'answer approvals in kubic tui',
    );
  });

  it('a seat that answers nothing times out to deny (never hangs)', async () => {
    const result = await runDestructive(async () => undefined);
    expect(result.asks).toBe(1);
    expect(result.toolResults.join('\n')).toContain('not approved');
  });

  it('an ordinary command never reaches the seat', async () => {
    const result = await runDestructive(
      async () => ({ approved: true, by: 'allow-once' }),
      'echo hi',
    );
    expect(result.asks).toBe(0);
    expect(result.terminus).toBe('completed');
  });

  it('says why a headless run cannot ask, and how to get an answer', () => {
    expect(NO_ANSWER_SURFACE_REASON).toBe(
      'approval required, but no approval surface is installed on this command: kubic run has no ask prompt, so the call is refused; answer approvals in kubic tui, or change the approval route or policy',
    );
  });
});
