// The installed policy's answer seat (issue #96, acceptance criterion 1).
// RED: installSoloPolicy refuses a challenged call immediately with
// NO_ANSWER_SURFACE_REASON because no command could collect a verdict. The
// interactive TUI is a command that CAN, so the policy must consult a seat
// when one is attached — and keep the immediate refusal (no 60s stall) when
// one is not.
//
// Faux provider only: zero network, zero paid tokens. The lane is real.
import { describe, expect, it } from 'vitest';
import { FakeExecutionEnv } from '../../exec/src/env.js';
import { bootSoloLane, driveToSettled } from '../../worker/src/lane/solo.js';
import {
  BACKGROUND_CONTEXT,
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
  MemorySessionRepo,
  type Session,
} from '../../worker/src/pi-boundary.js';
import {
  type ApprovalVerdict,
  installSoloPolicy,
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
  const env = new FakeExecutionEnv({});
  const repo = new MemorySessionRepo();
  const session: Session = await repo.create({}, BACKGROUND_CONTEXT);
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  faux.setResponses([
    fauxAssistantMessage([fauxToolCall('bash', { command })]),
    fauxAssistantMessage('done'),
  ]);
  let asks = 0;
  const installed = installSoloPolicy({
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
  const solo = await bootSoloLane({
    session,
    models,
    model: faux.getModel(),
    env,
    sessionId: session.metadata.id,
    agentId: 'root',
    policy: {
      classes: installed.classes,
      interceptors: installed.interceptors,
      contributions: installed.contributions,
    },
  });
  const admission = await solo.lane.accept(
    { kind: 'prompt', prompt: 'clean up' },
    BACKGROUND_CONTEXT,
  );
  if (!admission.ok) throw new Error('admission refused');
  const driven = await driveToSettled(
    solo.lane,
    admission.value.operationId,
    BACKGROUND_CONTEXT,
    { sleep: async () => new Promise((r) => setTimeout(r, 5)) },
  );
  const entries = (await session.findEntries(
    undefined,
    BACKGROUND_CONTEXT,
  )) as Array<{ message?: { role?: string; content?: unknown } }>;
  const toolResults = entries
    .filter((entry) => entry.message?.role === 'toolResult')
    .map((entry) => JSON.stringify(entry.message?.content));
  const outcome = driven.kind === 'settled' ? driven.outcome : driven;
  const status =
    typeof outcome === 'object' && outcome !== null && 'status' in outcome
      ? String((outcome as { status: unknown }).status)
      : driven.kind;
  return { terminus: status, toolResults, asks };
}

describe('installed policy answer seat (issue #96, criterion 1)', () => {
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

  it('names the missing surface in the reason the refusal carries', () => {
    expect(NO_ANSWER_SURFACE_REASON).toContain('no approval surface');
  });
});
