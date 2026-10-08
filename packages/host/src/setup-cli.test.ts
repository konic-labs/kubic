// `kubic setup`. The prompt frame is
// faked: every question the wizard asks is answered from a script.
import { describe, expect, it } from 'vitest';
import { EXIT_CANCELLED } from '../../core/src/cli/exit-codes.js';
import { createLineLogger } from '../../core/src/cli/logger.js';
import type { SelectChoice } from '../../core/src/cli/prompt.js';
import {
  runSetupCommand,
  type SetupDeps,
  type SetupProviderChoice,
} from './setup-cli.js';

const ANTHROPIC: SetupProviderChoice = {
  id: 'anthropic',
  auth: 'ANTHROPIC_API_KEY',
  models: [
    {
      id: 'sonnet',
      contextWindow: 200_000,
      thinking: ['off', 'low', 'medium', 'high'],
    },
    { id: 'haiku', contextWindow: 200_000, thinking: ['off'] },
  ],
};
const OPENAI: SetupProviderChoice = {
  id: 'openai',
  auth: 'OPENAI_API_KEY',
  models: [{ id: 'gpt-x', contextWindow: 400_000, thinking: ['off', 'high'] }],
};

type Answer = string | boolean | null;

function rig(
  answers: Answer[],
  overrides: Partial<SetupDeps> = {},
): {
  deps: SetupDeps;
  asked: string[];
  steps: string[];
  written: () => string | undefined;
  ended: () => string | undefined;
  errors: string[];
} {
  const asked: string[] = [];
  const steps: string[] = [];
  const errors: string[] = [];
  let written: string | undefined;
  let ended: string | undefined;
  const next = (): Answer =>
    answers.length === 0 ? null : (answers.shift() as Answer);
  const deps: SetupDeps = {
    out: () => {},
    logger: createLineLogger((line) =>
      errors.push(line.replace(/^error: /u, '')),
    ),

    interactive: true,
    ui: async () => ({
      intro: (title: string) => steps.push(`intro ${title}`),
      step: (message: string) => steps.push(message),
      select: async <T extends string>(
        message: string,
        choices: readonly SelectChoice<T>[],
        initial?: T,
      ) => {
        asked.push(
          `${message} [${choices.map((c) => c.value).join(',')}] ${initial ?? '-'}`,
        );
        return next() as T | null;
      },
      confirm: async (message: string) => {
        asked.push(`confirm ${message}`);
        return next() as boolean | null;
      },
      outro: (message: string) => {
        ended = `outro ${message}`;
      },
      cancel: (message: string) => {
        ended = `cancel ${message}`;
      },
    }),
    providers: [ANTHROPIC],
    configPath: '/home/me/.kubic/config.toml',
    readConfig: () => undefined,
    writeConfig: (text: string) => {
      written = text;
    },
    ...overrides,
  };
  return {
    deps,
    asked,
    steps,
    written: () => written,
    ended: () => ended,
    errors,
  };
}

describe('kubic setup', () => {
  it('one detected provider: model and thinking, then saves [model]', async () => {
    const r = rig(['sonnet', 'high']);
    expect((await runSetupCommand({}, r.deps)).exitCode).toBe(0);
    expect(r.steps).toEqual([
      'intro kubic setup',
      'Provider  anthropic — key from ANTHROPIC_API_KEY',
    ]);
    expect(r.asked).toEqual([
      'Default model [sonnet,haiku] -',
      'Thinking level [off,low,medium,high] medium',
    ]);
    expect(r.written()).toBe(
      '[model]\nprovider = "anthropic"\nid = "sonnet"\nthinking = "high"\n',
    );
    expect(r.ended()).toBe(
      'outro saved to /home/me/.kubic/config.toml — run kubic to start',
    );
  });

  it('several providers: asks which, preselects the current one', async () => {
    const r = rig(['openai', 'gpt-x', 'off'], {
      providers: [ANTHROPIC, OPENAI],
      current: 'openai/gpt-x',
    });
    expect((await runSetupCommand({}, r.deps)).exitCode).toBe(0);
    expect(r.asked[0]).toBe('Provider [anthropic,openai] openai');
    expect(r.asked[1]).toBe('Default model [gpt-x] gpt-x');
    expect(r.written()).toContain('provider = "openai"');
  });

  it('skips the thinking question for a model without thinking', async () => {
    const r = rig(['haiku']);
    expect((await runSetupCommand({}, r.deps)).exitCode).toBe(0);
    expect(r.asked).toEqual(['Default model [sonnet,haiku] -']);
    expect(r.written()).toBe('[model]\nprovider = "anthropic"\nid = "haiku"\n');
  });

  it('updates an existing config instead of replacing it', async () => {
    const r = rig(['haiku'], {
      readConfig: () => '# mine\n[ui]\ntheme = "light"\n',
    });
    await runSetupCommand({}, r.deps);
    expect(r.written()).toBe(
      '# mine\n[ui]\ntheme = "light"\n\n[model]\nprovider = "anthropic"\nid = "haiku"\n',
    );
  });

  it('a cancelled question writes nothing and exits 130', async () => {
    const r = rig([null]);
    expect((await runSetupCommand({}, r.deps)).exitCode).toBe(EXIT_CANCELLED);
    expect(r.written()).toBeUndefined();
    expect(r.ended()).toMatch(/^cancel setup cancelled/);
  });

  it('no provider with a key: names the fix, writes nothing, exits 6', async () => {
    const r = rig([], { providers: [] });
    expect((await runSetupCommand({}, r.deps)).exitCode).toBe(6);
    expect(r.written()).toBeUndefined();
    expect(r.ended()).toContain('export ANTHROPIC_API_KEY=');
  });

  it('a frozen enterprise model asks no model question', async () => {
    const r = rig([], { enterpriseModel: 'corp/approved' });
    expect((await runSetupCommand({}, r.deps)).exitCode).toBe(0);
    expect(r.asked).toEqual([]);
    expect(r.steps).toContain(
      'Model  corp/approved — pinned by enterprise policy',
    );
    expect(r.written()).toBeUndefined();
  });

  it('asks the trust question when there is one, and records the answer', async () => {
    const decisions: (boolean | null)[] = [];
    const r = rig(['haiku', true], {
      trust: async (confirm) => {
        const answer = await confirm('Trust project /repo?');
        decisions.push(answer);
        return answer === null ? false : answer;
      },
    });
    expect((await runSetupCommand({}, r.deps)).exitCode).toBe(0);
    expect(r.asked.at(-1)).toBe('confirm Trust project /repo?');
    expect(decisions).toEqual([true]);
    expect(r.steps).toContain('Project trusted');
  });

  it('a cancelled trust question cancels the setup', async () => {
    const r = rig(['haiku', null], {
      trust: async (confirm) => {
        await confirm('Trust?');
        return false;
      },
    });
    expect((await runSetupCommand({}, r.deps)).exitCode).toBe(EXIT_CANCELLED);
    expect(r.written()).toBeUndefined();
  });

  it('refuses off a terminal with the manual alternative (exit 2)', async () => {
    const r = rig([], { interactive: false });
    expect((await runSetupCommand({}, r.deps)).exitCode).toBe(2);
    expect(r.errors[0]).toMatch(/kubic setup is interactive/);
  });

  it('reports a config it cannot write (exit 1)', async () => {
    const r = rig(['haiku'], {
      writeConfig: () => {
        throw new Error('read-only file system');
      },
    });
    expect((await runSetupCommand({}, r.deps)).exitCode).toBe(1);
    expect(r.errors[0]).toMatch(/could not write .*read-only file system/);
  });
});
