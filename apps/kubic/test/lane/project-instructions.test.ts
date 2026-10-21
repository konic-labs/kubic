// Project instructions on the live path: a trusted project's AGENTS.md
// reaches the committed system prompt of a real `kubic run`, after the
// systemPromptFile section and ahead of the skills block; an untrusted one
// never does and is named. Faux provider only.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { NodeExecutionEnv } from '@kubic/exec/env';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { tempDir } from '../../../../test/temp-dir.js';
import { runHeadlessPrompt } from '../../src/run/command.js';
import { committedPrompt } from '../fixtures/committed-prompt.js';
import { fauxModels } from '../fixtures/faux-models.js';

beforeEach(() => {
  vi.stubEnv('KUBIC_NO_NOTICE', '1');
});

afterEach(() => {
  vi.unstubAllEnvs();
});

function project(): string {
  const root = tempDir('instructions-project-');
  mkdirSync(join(root, '.git'));
  writeFileSync(join(root, 'AGENTS.md'), 'Always run the linter.\n');
  return root;
}

describe('AGENTS.md reaches the live prompt', () => {
  it('appends a trusted project file between the systemPromptFile and the skills', async () => {
    const root = project();
    const home = tempDir('instructions-home-');
    const skillDir = join(home, '.agents', 'skills', 'ship-it');
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(
      join(skillDir, 'SKILL.md'),
      '---\nname: ship-it\ndescription: Ship it\n---\n\nBody.\n',
    );
    const sessions = tempDir('instructions-sessions-');
    const notices: string[] = [];
    const result = await runHeadlessPrompt(
      'hello',
      {},
      {
        sessionsRoot: sessions,
        models: fauxModels(['done']),
        env: new NodeExecutionEnv(root),
        systemPromptSection: 'USER-PROMPT-FILE',
        trustProject: () => true,
        skills: { homeDir: home, cwd: root, trusted: true },
        notice: (line) => notices.push(line),
      },
    );
    expect(result.terminus).toBe('completed');
    const prompt = await committedPrompt(sessions, result.sessionId);
    expect(prompt).toContain(
      `<file path="${join(root, 'AGENTS.md')}">\nAlways run the linter.\n</file>`,
    );
    const file = prompt.indexOf('USER-PROMPT-FILE');
    const instructions = prompt.indexOf('<project_instructions>');
    const skills = prompt.indexOf('<skills>');
    expect(file).toBeGreaterThan(-1);
    expect(instructions).toBeGreaterThan(file);
    expect(skills).toBeGreaterThan(instructions);
    expect(notices.filter((line) => line.includes('AGENTS.md'))).toEqual([]);
  });

  it('leaves an untrusted project file out and names it', async () => {
    const root = project();
    const sessions = tempDir('instructions-sessions-');
    const notices: string[] = [];
    const result = await runHeadlessPrompt(
      'hello',
      {},
      {
        sessionsRoot: sessions,
        models: fauxModels(['done']),
        env: new NodeExecutionEnv(root),
        trustProject: () => false,
        notice: (line) => notices.push(line),
      },
    );
    expect(result.terminus).toBe('completed');
    const prompt = await committedPrompt(sessions, result.sessionId);
    expect(prompt).not.toContain('Always run the linter');
    expect(notices).toContain(
      `project instructions: ${join(root, 'AGENTS.md')} not loaded: the project directory ${root} is not trusted — run 'kubic trust ${root}' to accept it`,
    );
  });

  it('reads nothing when [agent] projectInstructions is off', async () => {
    const root = project();
    const sessions = tempDir('instructions-sessions-');
    const result = await runHeadlessPrompt(
      'hello',
      {},
      {
        sessionsRoot: sessions,
        models: fauxModels(['done']),
        env: new NodeExecutionEnv(root),
        trustProject: () => true,
        projectInstructions: false,
      },
    );
    const prompt = await committedPrompt(sessions, result.sessionId);
    expect(prompt).not.toContain('<project_instructions>');
  });
});
