// Run spans on the live headless path (issue #98, criterion 1): drives the
// composition-root adapter (`apps/kubic/src/headless-run.ts`) against a real
// lane with faux models — the same black-box standard as
// run-prod-path.test.ts — and asserts a live run actually EMITS the
// lane/tool spans at the documented destination:
//   - durable: <sessions-root>/<id>/spans.jsonl (one JSON record per span),
//   - stderr debug: the §50 `[tool]` in/out and `[agent]` lane lines behind
//     `--debug` (injected sink here, console.error in prod).
// Faux provider only: zero network, zero paid tokens.
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runHeadlessPrompt } from '../../../../../apps/kubic/src/headless-run.js';
import { FakeExecutionEnv } from '../../../../exec/src/env.js';
import {
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
  type MutableModels,
} from '../../../../worker/src/pi-boundary.js';

function tmpRoot(): string {
  return mkdtempSync(join(tmpdir(), 'run-spans-prod-'));
}

// A faux model that makes exactly one real tool call, then answers — so the
// run's tool span comes from a real harness tool execution, not a fixture.
function fauxModelsWithTool(): MutableModels {
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  faux.setResponses([
    fauxAssistantMessage([fauxToolCall('read', { path: 'a.txt' })]),
    fauxAssistantMessage('read it'),
  ]);
  return models;
}

function fauxModelsText(): MutableModels {
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  faux.setResponses([fauxAssistantMessage('no tools needed')]);
  return models;
}

interface SpanLine {
  run: string;
  sessionId: string;
  id: string;
  name: string;
  parentId: string | null;
  startMs: number;
  endMs: number | null;
  toolName?: string;
  error?: string;
}

function readSpans(root: string, id: string): SpanLine[] {
  return readFileSync(join(root, id, 'spans.jsonl'), 'utf8')
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as SpanLine);
}

describe('live run emits lane/tool spans (issue #98, criterion 1)', () => {
  it('writes run → lane accept/drive → tool spans to <sessions>/<id>/spans.jsonl', async () => {
    const root = tmpRoot();
    const env = new FakeExecutionEnv({});
    env.fs.writeFile('a.txt', 'spans read this\n');
    const result = await runHeadlessPrompt(
      'read the file',
      {},
      { sessionsRoot: root, models: fauxModelsWithTool(), env },
    );
    expect(result.terminus).toBe('completed');

    const spans = readSpans(root, result.sessionId);
    const names = spans.map((span) => span.name);
    expect(names).toContain('kubic.agent.run');
    expect(names).toContain('kubic.lane.accept');
    expect(names).toContain('kubic.lane.drive');
    expect(names).toContain('pi.tool.execute');

    const runSpan = spans.find((span) => span.name === 'kubic.agent.run');
    const toolSpan = spans.find((span) => span.name === 'pi.tool.execute');
    if (runSpan === undefined || toolSpan === undefined) {
      throw new Error('missing run or tool span');
    }
    expect(toolSpan.toolName).toBe('read');
    expect(toolSpan.endMs).not.toBeNull();
    expect((toolSpan.endMs ?? 0) - toolSpan.startMs).toBeGreaterThanOrEqual(0);
    // Every record is tagged with the run and session it belongs to.
    for (const span of spans) {
      expect(span.run).toBe(runSpan.run);
      expect(span.sessionId).toBe(result.sessionId);
      expect(span.name).toMatch(/^kubic\.|^pi\./);
    }
    // The run span closes last and nothing else is left dangling.
    expect(runSpan.endMs).not.toBeNull();
    expect(spans.filter((span) => span.endMs === null)).toEqual([]);
    // The lane spans nest under the run span; the tool span nests under a lane.
    expect(toolSpan.parentId).not.toBeNull();
    expect(spans.find((span) => span.id === toolSpan.parentId)?.name).toBe(
      'kubic.lane.drive',
    );
  });

  it('emits the §50 tool/agent debug lines on the injected sink', async () => {
    const root = tmpRoot();
    const env = new FakeExecutionEnv({});
    env.fs.writeFile('a.txt', 'spans read this\n');
    const lines: string[] = [];
    const result = await runHeadlessPrompt(
      'read the file',
      { debug: true },
      {
        sessionsRoot: root,
        models: fauxModelsWithTool(),
        env,
        debugSink: (line) => lines.push(line),
      },
    );
    expect(result.terminus).toBe('completed');
    const joined = lines.join('\n');
    expect(joined).toMatch(/\[tool\] in read call=/);
    expect(joined).toMatch(/\[tool\] out read call=.*status=ok/);
    expect(joined).toMatch(/\[agent\] lane accept start/);
    expect(joined).toMatch(/\[agent\] lane drive start/);
    expect(joined).toMatch(/\[agent\] run start/);
    // §50 vocabulary is closed: no invented debug class on the run path.
    for (const line of lines) {
      expect(line).toMatch(
        /^\[(policy|worker|session|tool|model|agent|exit|handles)\]/,
      );
    }
  });

  it('stays silent on the sink when --debug is not set', async () => {
    const root = tmpRoot();
    const lines: string[] = [];
    const result = await runHeadlessPrompt(
      'no tools needed',
      {},
      {
        sessionsRoot: root,
        models: fauxModelsText(),
        env: new FakeExecutionEnv({}),
        debugSink: (line) => lines.push(line),
      },
    );
    expect(result.terminus).toBe('completed');
    expect(lines).toEqual([]);
    // The artifact is written either way: spans are the durable half.
    const spans = readSpans(root, result.sessionId);
    expect(spans.map((span) => span.name)).toContain('kubic.lane.drive');
  });

  it('keeps the recorded spans on a failed run', async () => {
    const root = tmpRoot();
    const faux = fauxProvider();
    const models = createModels();
    models.setProvider(faux.provider);
    faux.setResponses([]);
    const result = await runHeadlessPrompt(
      'break it',
      {},
      { sessionsRoot: root, models, env: new FakeExecutionEnv({}) },
    );
    expect(result.terminus).toBe('failed');
    const spans = readSpans(root, result.sessionId);
    expect(spans.map((span) => span.name)).toContain('kubic.lane.drive');
    expect(spans.every((span) => span.endMs !== null)).toBe(true);
  });

  it('defaults to the stderr sink in prod when --debug is set without an injected sink', async () => {
    const root = tmpRoot();
    const env = new FakeExecutionEnv({});
    env.fs.writeFile('a.txt', 'spans read this\n');
    const written: string[] = [];
    const original = console.error;
    console.error = (line: string) => {
      written.push(line);
    };
    try {
      const result = await runHeadlessPrompt(
        'read the file',
        { debug: true },
        { sessionsRoot: root, models: fauxModelsWithTool(), env },
      );
      expect(result.terminus).toBe('completed');
    } finally {
      console.error = original;
    }
    // The prod default is stderr: a live `kubic run --debug` must not need
    // the composition root to pass a sink (main.ts is owned by another issue).
    expect(written.join('\n')).toMatch(/\[tool\] in read call=/);
    expect(written.join('\n')).toMatch(/\[agent\] lane drive start/);
  });
});
