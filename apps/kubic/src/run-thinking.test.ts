// The `--thinking` / config default reaches the lane the run boots
// (issue #225; §38.3): override > session > role > config, clamped to the
// effective model, never silently — and the trajectory records the applied
// level, not the request. Drives the real `runHeadlessPrompt` with faux
// models: zero network, zero paid tokens.
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { FakeExecutionEnv } from '../../../packages/exec/src/env.js';
import {
  createModels,
  fauxAssistantMessage,
  fauxProvider,
} from '../../../packages/worker/src/pi-boundary.js';
import { runHeadlessPrompt } from './headless-run.js';

const made: string[] = [];

function tmpRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), 'run-thinking-'));
  made.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of made.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

function reasoningModels(texts: string[]) {
  const faux = fauxProvider({
    models: [{ id: 'deep', reasoning: true }],
  });
  const models = createModels();
  models.setProvider(faux.provider);
  faux.setResponses(texts.map((text) => fauxAssistantMessage(text)));
  return models;
}

function plainModels(texts: string[]) {
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  faux.setResponses(texts.map((text) => fauxAssistantMessage(text)));
  return models;
}

function trajectoryThinking(root: string, id: string): unknown {
  const raw = readFileSync(join(root, id, 'trajectory.json'), 'utf8');
  const parsed = JSON.parse(raw) as {
    model?: { thinking?: unknown };
  };
  return parsed.model?.thinking ?? null;
}

function writeRole(root: string, name: string): void {
  const dir = join(root, '.kubic', 'roles');
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, `${name}.md`),
    `---\nrole: ${name}\n---\n\n# ${name}\n\n## Prompt\n\nReview.\n`,
  );
}

describe('run thinking level (issue #225)', () => {
  it('applies the per-run override and records it in the trajectory', async () => {
    const root = tmpRoot();
    const result = await runHeadlessPrompt(
      'do it',
      {},
      {
        sessionsRoot: root,
        models: reasoningModels(['all done']),
        env: new FakeExecutionEnv({}),
        thinking: { level: 'high', source: 'cli' },
      },
    );
    expect(result.terminus).toBe('completed');
    expect(trajectoryThinking(root, result.sessionId)).toBe('high');
  });

  it('clamps an unsupported request with a named notice and records the clamp', async () => {
    const root = tmpRoot();
    const notices: string[] = [];
    const result = await runHeadlessPrompt(
      'do it',
      {},
      {
        sessionsRoot: root,
        models: plainModels(['all done']),
        env: new FakeExecutionEnv({}),
        thinking: { level: 'high', source: 'cli' },
        notice: (line) => notices.push(line),
      },
    );
    expect(result.terminus).toBe('completed');
    expect(notices.join('\n')).toMatch(/thinking 'high'.*clamped to 'off'/);
    expect(trajectoryThinking(root, result.sessionId)).toBe('off');
  });

  it('keeps the session record over a file-layer default on resume', async () => {
    const root = tmpRoot();
    const env = new FakeExecutionEnv({});
    const first = await runHeadlessPrompt(
      'first',
      {},
      {
        sessionsRoot: root,
        models: reasoningModels(['first done']),
        env,
        thinking: { level: 'medium', source: 'cli' },
      },
    );
    expect(first.terminus).toBe('completed');
    const second = await runHeadlessPrompt(
      'second',
      { sessionId: first.sessionId },
      {
        sessionsRoot: root,
        models: reasoningModels(['second done']),
        env,
        thinking: { level: 'high', source: 'project' },
      },
    );
    expect(second.terminus).toBe('completed');
    expect(trajectoryThinking(root, first.sessionId)).toBe('medium');
  });

  it('resolves the role default under the session record but over config', async () => {
    const root = tmpRoot();
    const rolesCwd = tmpRoot();
    writeRole(rolesCwd, 'reviewer');
    const env = new FakeExecutionEnv({});
    const result = await runHeadlessPrompt(
      'review it',
      { role: 'reviewer' },
      {
        sessionsRoot: root,
        models: reasoningModels(['reviewed']),
        env,
        roles: {
          cwd: rolesCwd,
          layers: [
            { layer: 'project', roles: { reviewer: { thinking: 'low' } } },
          ],
        },
        thinking: { level: 'high', source: 'global' },
      },
    );
    expect(result.terminus).toBe('completed');
    // The config default is the lane's `config` input; the role default
    // beats it (override > session > role > config).
    expect(trajectoryThinking(root, result.sessionId)).toBe('low');
  });
});
