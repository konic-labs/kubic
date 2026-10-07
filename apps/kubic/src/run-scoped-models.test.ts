// A role's allowed set binds selection on `kubic run`: the request resolves
// against the role's `models` and a model outside the set refuses by name
// before any provider call. Drives the real `runHeadlessPrompt` with faux
// providers: zero network, zero paid tokens.
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
  const dir = mkdtempSync(join(tmpdir(), 'run-scoped-models-'));
  made.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of made.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

function writeRole(root: string, name: string): void {
  const dir = join(root, '.kubic', 'roles');
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, `${name}.md`),
    `---\nrole: ${name}\n---\n\n# ${name}\n\n## Prompt\n\nReview.\n`,
  );
}

function twoProviders(texts: string[]) {
  const models = createModels();
  for (const provider of ['local', 'anthropic']) {
    const faux = fauxProvider({
      provider,
      models: [{ id: provider === 'local' ? 'a' : 'x' }],
    });
    faux.setResponses(texts.map((text) => fauxAssistantMessage(text)));
    models.setProvider(faux.provider);
  }
  return models;
}

function trajectoryThinking(root: string, id: string): unknown {
  const raw = readFileSync(join(root, id, 'trajectory.json'), 'utf8');
  const parsed = JSON.parse(raw) as {
    model?: { thinking?: unknown };
  };
  return parsed.model?.thinking ?? null;
}

describe('run scoped models', () => {
  it("refuses --model outside the role's set by name", async () => {
    const root = tmpRoot();
    const rolesCwd = tmpRoot();
    writeRole(rolesCwd, 'reviewer');
    const result = await runHeadlessPrompt(
      'review it',
      { role: 'reviewer' },
      {
        sessionsRoot: root,
        models: twoProviders(['done']),
        model: { provider: 'anthropic', id: 'x' },
        env: new FakeExecutionEnv({}),
        roles: {
          cwd: rolesCwd,
          layers: [
            {
              layer: 'project',
              roles: { reviewer: { models: [{ id: 'local/*' }] } },
            },
          ],
        },
      },
    );
    expect(result.terminus).toBe('provider_probe_failed');
    expect(result.error?.message).toMatch(
      /model 'anthropic\/x' refused: role 'reviewer' allows local\/\* only/,
    );
  });

  it('an empty set allows any registered model (control)', async () => {
    const root = tmpRoot();
    const rolesCwd = tmpRoot();
    writeRole(rolesCwd, 'reviewer');
    const result = await runHeadlessPrompt(
      'review it',
      { role: 'reviewer' },
      {
        sessionsRoot: root,
        models: twoProviders(['done']),
        model: { provider: 'anthropic', id: 'x' },
        env: new FakeExecutionEnv({}),
        roles: {
          cwd: rolesCwd,
          layers: [{ layer: 'project', roles: { reviewer: { models: [] } } }],
        },
      },
    );
    expect(result.terminus).toBe('completed');
  });

  it('a matching entry thinking beats the flat role default in the lane', async () => {
    const root = tmpRoot();
    const rolesCwd = tmpRoot();
    writeRole(rolesCwd, 'reviewer');
    const faux = fauxProvider({
      models: [{ id: 'deep', reasoning: true }],
    });
    const models = createModels();
    models.setProvider(faux.provider);
    faux.setResponses([fauxAssistantMessage('done')]);
    const result = await runHeadlessPrompt(
      'review it',
      { role: 'reviewer' },
      {
        sessionsRoot: root,
        models,
        env: new FakeExecutionEnv({}),
        roles: {
          cwd: rolesCwd,
          layers: [
            {
              layer: 'project',
              roles: {
                reviewer: {
                  thinking: 'medium',
                  models: [{ id: 'faux/*', thinking: 'low' }],
                },
              },
            },
          ],
        },
      },
    );
    expect(result.terminus).toBe('completed');
    // Specific beats general: the entry's `low` wins over flat `medium`.
    expect(trajectoryThinking(root, result.sessionId)).toBe('low');
  });
});
