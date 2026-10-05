// Solo opt-in budgets end to end (issue #283; §71): faux runs with a
// `--budget` whose limits the loaded first-party bundle enforces — a
// tool-call overrun trips the gate mid-turn, a billed cost overrun trips
// the after-turn usage check. Both end budget_exhausted (exit 3) naming
// the limit. Temp dirs cleaned in afterEach; zero network, zero tokens.
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NodeExecutionEnv } from '../../../packages/exec/src/env.js';
import { mapTerminusToExitCode } from '../../../packages/host/src/run-cli.js';
import { parseTrajectoryExportJSON } from '../../../packages/trajectory/src/schema.js';
import {
  bootFauxLane,
  runPrompt,
} from '../../../packages/worker/src/lane/test-harness.js';
import {
  BACKGROUND_CONTEXT,
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
  type Usage,
  UsageDoc,
} from '../../../packages/worker/src/pi-boundary.js';
import { runHeadlessPrompt } from './headless-run.js';

const made: string[] = [];

function tmp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  made.push(dir);
  return dir;
}

beforeEach(() => {
  vi.stubEnv('KUBIC_NO_NOTICE', '1');
  vi.stubEnv('KUBIC_PROVIDER', 'faux');
  vi.stubEnv('KUBIC_WORKER_ID', '');
});

afterEach(() => {
  vi.unstubAllEnvs();
  for (const dir of made.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

function usageOf(input: number, output: number, total: number): Usage {
  return {
    input,
    output,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: input + output,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total },
  };
}

function billed(text: string, input: number, output: number, total: number) {
  const message = fauxAssistantMessage(text);
  message.usage = usageOf(input, output, total);
  return message;
}

function modelsWith(
  responses: Parameters<ReturnType<typeof fauxProvider>['setResponses']>[0],
): ReturnType<typeof createModels> {
  const models = createModels();
  const faux = fauxProvider({
    provider: 'faux',
    models: [{ id: 'echo', contextWindow: 100000 }],
  });
  faux.setResponses(responses);
  models.setProvider(faux.provider);
  return models;
}

async function budgetedRun(
  responses: Parameters<ReturnType<typeof fauxProvider>['setResponses']>[0],
  budget: { maxToolCalls?: number; maxCostUsd?: number; maxRuntimeMs?: number },
) {
  const sessionsRoot = tmp('hbudget-sessions-');
  const ws = tmp('hbudget-ws-');
  const result = await runHeadlessPrompt(
    'do the thing',
    { budget },
    {
      sessionsRoot,
      env: new NodeExecutionEnv(ws),
      modelsCwd: ws,
      models: modelsWith(responses),
      model: { provider: 'faux', id: 'echo' },
      warn: () => undefined,
    },
  );
  return result;
}

describe('solo --budget end to end (issue #283)', () => {
  it('a second tool call past maxToolCalls=1 ends budget_exhausted naming toolCalls', async () => {
    const result = await budgetedRun(
      [
        fauxAssistantMessage(
          [fauxToolCall('write', { path: 'a.txt', content: 'a\n' })],
          { stopReason: 'toolUse' },
        ),
        fauxAssistantMessage(
          [fauxToolCall('write', { path: 'b.txt', content: 'b\n' })],
          { stopReason: 'toolUse' },
        ),
        fauxAssistantMessage('done'),
      ],
      { maxToolCalls: 1 },
    );
    expect(result.terminus).toBe('budget_exhausted');
    expect(mapTerminusToExitCode(result.terminus, undefined)).toBe(3);
    expect(result.summary).toContain('toolCalls');
    // Issue #285 (§71 observability): the trajectory names the budget
    // the run started with and the tripped limit (a mid-turn gate trip
    // names the limit; the spend/bound come from the post-turn ledger).
    const exported = parseTrajectoryExportJSON(
      readFileSync(result.trajectoryRef, 'utf8'),
    );
    expect(exported.budget?.limits).toEqual({ maxToolCalls: 1 });
    expect(exported.budget?.exhausted?.limit).toBe('toolCalls');
    expect(exported.budget?.usage?.tokens).toBeGreaterThan(0);
  });

  it('a billed cost past maxCostUsd ends budget_exhausted naming cost', async () => {
    // The faux provider estimates cost 0 itself, so the spend is billed
    // the way tui-usage-resume does it: a prior turn whose committed
    // usage carries a real cost, attached here as the budgeted run.
    const root = tmp('hbudget-cost-');
    const lane = await bootFauxLane({
      storage: 'jsonl',
      root,
      cwd: root,
      responses: [billed('spent it', 1000, 200, 0.6)],
    });
    try {
      await runPrompt(lane.solo, 'spend something', { requestId: 'u1' });
      // The faux provider estimates cost 0 itself: the spend is written
      // into the session's usage ledger directly (tui-usage-resume pattern).
      const conversation = await lane.solo.harness.root(BACKGROUND_CONTEXT);
      await lane.solo.harness.commit(async (tx) => {
        const usage = await tx.doc(UsageDoc, conversation.id);
        usage.models = { 'faux/echo': usageOf(1000, 200, 0.6) };
      }, BACKGROUND_CONTEXT);
      const sessionId = lane.sessionId;
      // Release the session lock before the budgeted run attaches it.
      await lane.cleanup();
      const result = await runHeadlessPrompt(
        'follow up',
        { budget: { maxCostUsd: 0.5 }, sessionId },
        {
          sessionsRoot: root,
          env: new NodeExecutionEnv(root),
          modelsCwd: root,
          models: modelsWith([fauxAssistantMessage('done')]),
          model: { provider: 'faux', id: 'echo' },
          warn: () => undefined,
        },
      );
      expect(result.terminus).toBe('budget_exhausted');
      expect(mapTerminusToExitCode(result.terminus, undefined)).toBe(3);
      expect(result.summary).toContain('cost');
      // Issue #285: the post-turn ledger breach records spend + bound.
      const exported = parseTrajectoryExportJSON(
        readFileSync(result.trajectoryRef, 'utf8'),
      );
      expect(exported.budget?.limits).toEqual({ maxCostUsd: 0.5 });
      expect(exported.budget?.exhausted?.limit).toBe('cost');
      expect(exported.budget?.exhausted?.max).toBe(0.5);
      expect(exported.budget?.exhausted?.used ?? 0).toBeGreaterThan(0.5);
    } finally {
      await lane.cleanup().catch(() => undefined);
    }
  });

  // Review #283 (med): `maxRuntimeMs` was accepted but dead — no live
  // path ever fed `runtimeMs`, so a wall-clock-only budget never tripped.
  // The guard arms at min(timeout, maxRuntimeMs) with the budget error.
  it('a tiny maxRuntimeMs ends budget_exhausted naming wallClock', async () => {
    const result = await budgetedRun(
      [
        fauxAssistantMessage(
          [fauxToolCall('write', { path: 'a.txt', content: 'a\n' })],
          { stopReason: 'toolUse' },
        ),
        fauxAssistantMessage('done'),
      ],
      { maxRuntimeMs: 1 },
    );
    expect(result.terminus).toBe('budget_exhausted');
    expect(mapTerminusToExitCode(result.terminus, undefined)).toBe(3);
    expect(result.summary).toContain('wallClock');
  });

  it('a run inside budget completes (no false trip)', async () => {
    const result = await budgetedRun(
      [
        fauxAssistantMessage(
          [fauxToolCall('write', { path: 'a.txt', content: 'a\n' })],
          { stopReason: 'toolUse' },
        ),
        fauxAssistantMessage('done'),
      ],
      { maxToolCalls: 1, maxCostUsd: 0.5 },
    );
    expect(result.terminus).toBe('completed');
    // Issue #285: limits ride the trajectory; no breach, no exhausted.
    const exported = parseTrajectoryExportJSON(
      readFileSync(result.trajectoryRef, 'utf8'),
    );
    expect(exported.budget?.limits).toEqual({
      maxToolCalls: 1,
      maxCostUsd: 0.5,
    });
    expect(exported.budget?.exhausted).toBeUndefined();
  });
});
