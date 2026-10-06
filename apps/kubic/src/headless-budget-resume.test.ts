// Budgets across a resume (issue #440; §71): a resumed session continues
// its tool-call count instead of starting a fresh `maxToolCalls` allowance,
// on the solo `--budget` gate and on a worker child's KUBIC_BUDGET meter
// alike; and a worker child that exhausts its KUBIC_BUDGET records the
// budget block and the breach in its trajectory, as a solo run does (#285).
// Faux provider only; temp dirs are removed and env unstubbed after each.
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NodeExecutionEnv } from '../../../packages/exec/src/env.js';
import { parseTrajectoryExportJSON } from '../../../packages/trajectory/src/schema.js';
import { fauxToolUse } from '../../../packages/worker/src/lane/test-harness.js';
import {
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from '../../../packages/worker/src/pi-boundary.js';
import { type HeadlessRunOptions, runHeadlessPrompt } from './headless-run.js';

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
  vi.stubEnv('KUBIC_BUDGET', '');
});

afterEach(() => {
  vi.unstubAllEnvs();
  for (const dir of made.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

// One run's script: a `write` per file, each its own tool round, then the
// closing answer.
function writes(files: readonly string[]): ReturnType<typeof createModels> {
  const models = createModels();
  const faux = fauxProvider({
    provider: 'faux',
    models: [{ id: 'echo', contextWindow: 100000 }],
  });
  faux.setResponses([
    ...files.map((file) =>
      fauxToolUse([
        fauxToolCall('write', { path: file, content: `${file}\n` }),
      ]),
    ),
    fauxAssistantMessage('done'),
  ]);
  models.setProvider(faux.provider);
  return models;
}

// Runs over one sessions root and one workspace, so a second run can
// resume the first one's session.
function workspace() {
  const sessionsRoot = tmp('budget-resume-sessions-');
  const ws = tmp('budget-resume-ws-');
  const run = (options: HeadlessRunOptions, files: readonly string[]) =>
    runHeadlessPrompt('write the files', options, {
      sessionsRoot,
      env: new NodeExecutionEnv(ws),
      modelsCwd: ws,
      models: writes(files),
      model: { provider: 'faux', id: 'echo' },
      warn: () => undefined,
    });
  return { ws, run };
}

describe('a resumed session continues its tool-call count (issue #440)', () => {
  it('solo --budget maxToolCalls=3: two calls, then the resume runs one more and trips on the next', async () => {
    const { ws, run } = workspace();
    const budget = { maxToolCalls: 3 };
    const first = await run({ budget }, ['a.txt', 'b.txt']);
    expect(first.terminus).toBe('completed');
    const resumed = await run({ budget, sessionId: first.sessionId }, [
      'c.txt',
      'd.txt',
    ]);
    expect(resumed.terminus).toBe('budget_exhausted');
    expect(resumed.summary).toContain('toolCalls');
    expect(existsSync(join(ws, 'c.txt'))).toBe(true);
    expect(existsSync(join(ws, 'd.txt'))).toBe(false);
  });

  it('a worker child KUBIC_BUDGET maxToolCalls=3: the same count survives the resume', async () => {
    vi.stubEnv('KUBIC_BUDGET', JSON.stringify({ maxToolCalls: 3 }));
    const { ws, run } = workspace();
    const first = await run({}, ['a.txt', 'b.txt']);
    expect(first.terminus).toBe('completed');
    const resumed = await run({ sessionId: first.sessionId }, [
      'c.txt',
      'd.txt',
    ]);
    expect(resumed.terminus).toBe('budget_exhausted');
    expect(resumed.error?.message).toContain('limit=toolCalls');
    expect(existsSync(join(ws, 'c.txt'))).toBe(true);
    expect(existsSync(join(ws, 'd.txt'))).toBe(false);
  });
});

describe('a worker child budget breach reaches its trajectory (issue #440)', () => {
  it('KUBIC_BUDGET maxToolCalls=1: the trajectory carries the limits, the spend and the breach', async () => {
    vi.stubEnv('KUBIC_BUDGET', JSON.stringify({ maxToolCalls: 1 }));
    const { run } = workspace();
    const result = await run({}, ['a.txt', 'b.txt']);
    expect(result.terminus).toBe('budget_exhausted');
    const exported = parseTrajectoryExportJSON(
      readFileSync(result.trajectoryRef, 'utf8'),
    );
    expect(exported.budget?.limits).toEqual({ maxToolCalls: 1 });
    expect(exported.budget?.exhausted?.limit).toBe('toolCalls');
    expect(exported.budget?.usage?.toolCalls).toBeGreaterThanOrEqual(1);
  });
});
