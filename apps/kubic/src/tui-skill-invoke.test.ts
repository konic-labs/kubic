// Explicit skill invocation in `kubic tui`:
// `/skill:<name> [instructions]` expands the booted skill (hidden skills
// included, withheld skills excluded) into the turn prompt. Unknown names
// refuse locally by name and never reach the model. Faux provider only:
// zero network, zero paid tokens.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeExecutionEnv } from '../../../packages/exec/src/env.js';
import {
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  type MutableModels,
} from '../../../packages/worker/src/pi-boundary.js';
import { terminalRig } from '../../../test/fake-terminal.js';
import {
  bootTuiLane,
  parseSkillInvokeCommand,
  runTuiCommand,
  SKILL_COMMAND_USAGE,
  type TuiLaneBoot,
} from './tui-run.js';

const made: string[] = [];

function tmpRoot(prefix = 'kubic-tui-skill-'): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  made.push(dir);
  return dir;
}

beforeEach(() => {
  vi.stubEnv('KUBIC_PROVIDER', undefined);
  vi.stubEnv('KUBIC_NO_NOTICE', '1');
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  for (const dir of made.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

async function waitFor(condition: () => boolean): Promise<void> {
  for (let i = 0; i < 500 && !condition(); i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  expect(condition()).toBe(true);
}

// The alt-screen rewrites the whole frame per render, so joining every
// write on every poll turns a footer wait into seconds of string copies.
// Track a high-water mark and scan only fresh output (with a one-write
// overlap, so a match split across the boundary is still seen).
async function waitForText(
  fake: ReturnType<typeof recordingTerminal>,
  text: string,
): Promise<void> {
  let from = 0;
  for (let i = 0; i < 500; i += 1) {
    const fresh = fake.writes.slice(Math.max(0, from - 1)).join('');
    if (fresh.includes(text)) return;
    from = fake.writes.length;
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  expect(fake.writes.join('').includes(text)).toBe(true);
}

function recordingTerminal() {
  return terminalRig(140, 30);
}

type SeenMessage = {
  role: string;
  content: unknown;
  sections?: Record<string, unknown>;
};

// The system prompt rides `sections`, not `content` (pi-durable assembles
// it from named sections): string content plus every string section.
function messageText(message: SeenMessage): string {
  const parts: string[] = [];
  if (typeof message.content === 'string') parts.push(message.content);
  else if (message.content !== undefined && message.content !== null)
    parts.push(JSON.stringify(message.content));
  for (const section of Object.values(message.sections ?? {})) {
    if (typeof section === 'string') parts.push(section);
  }
  return parts.join('\n');
}

// Every message the faux provider receives, in arrival order.
function captureAllMessages() {
  const seen: SeenMessage[] = [];
  const optionKeys: string[] = [];
  return {
    seen,
    optionKeys,
    respond: (context: { messages: SeenMessage[] }, options?: unknown) => {
      for (const message of context.messages) seen.push(message);
      if (options !== undefined && options !== null) {
        optionKeys.push(
          Object.keys(options as Record<string, unknown>).join(','),
        );
      }
      return fauxAssistantMessage('seen');
    },
  };
}

function textModels(
  respond: (context: {
    messages: SeenMessage[];
  }) => ReturnType<typeof fauxAssistantMessage>,
): MutableModels {
  const faux = fauxProvider({ models: [{ id: 'text', input: ['text'] }] });
  faux.setResponses([respond]);
  const registry = createModels();
  registry.setProvider(faux.provider);
  return registry;
}

function writeSkill(dir: string, frontmatter: string, body: string): string {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, 'SKILL.md');
  writeFileSync(path, `---\n${frontmatter}\n---\n\n${body}\n`);
  return path;
}

describe('parseSkillInvokeCommand', () => {
  it('parses the colon form with instructions', () => {
    expect(parseSkillInvokeCommand('/skill:hidden do x')).toEqual({
      kind: 'invoke',
      name: 'hidden',
      instructions: 'do x',
    });
  });

  it('parses the bare colon form without instructions', () => {
    expect(parseSkillInvokeCommand('/skill:hidden')).toEqual({
      kind: 'invoke',
      name: 'hidden',
      instructions: '',
    });
  });

  it('reports the usage for a bare /skill or an empty name', () => {
    expect(parseSkillInvokeCommand('/skill')).toEqual({
      kind: 'invalid',
      message: SKILL_COMMAND_USAGE,
    });
    expect(parseSkillInvokeCommand('/skill:')).toEqual({
      kind: 'invalid',
      message: SKILL_COMMAND_USAGE,
    });
  });

  it('leaves anything else alone', () => {
    expect(parseSkillInvokeCommand('hello')).toBeUndefined();
    expect(parseSkillInvokeCommand('/skilled x')).toBeUndefined();
    expect(parseSkillInvokeCommand('/skillfoo')).toBeUndefined();
  });
});

describe('kubic tui /skill: over a stub lane', () => {
  function startStubSkillSession() {
    const fake = recordingTerminal();
    const admitted: string[] = [];
    const loop = {
      runTurn: async (prompt: string) => {
        admitted.push(prompt);
        return { kind: 'completed', submissionId: `sub-${admitted.length}` };
      },
      supportsImages: async () => true,
      subscribe: async () => async () => {},
      entries: async () => [],
      abort: async () => {},
      forgetKills: () => {},
      killsKey: 'conversation',
      kills: { track: () => {}, drain: () => [] },
      context: { signal: new AbortController().signal },
    };
    const exit = runTuiCommand(
      {},
      {
        out: () => {},
        createTerminal: () => fake.terminal,
        colorLevel: 'none',
        bootLane: async (sessionId?: string) =>
          ({
            sessionId: sessionId ?? 's1',
            model: 'faux/test',
            loop,
            skillInvocation: {
              names: ['hidden'],
              invoke: (name: string, instructions?: string) => {
                if (name !== 'hidden')
                  throw new Error(`unknown skill '${name}'`);
                const extra = instructions?.trim() ?? '';
                return extra === ''
                  ? 'Hidden content.'
                  : `Hidden content.\n\n${extra}`;
              },
            },
          }) as unknown as TuiLaneBoot,
      },
    );
    return { fake, exit, admitted };
  }

  it('expands the invocation into the submitted turn prompt', async () => {
    const { fake, exit, admitted } = startStubSkillSession();
    await waitFor(() => fake.counts.started === 1);

    for (const ch of '/skill:hidden do x') fake.feed(ch);
    fake.feed('\r');
    await waitFor(() => admitted.length === 1);
    expect(admitted[0]).toBe('Hidden content.\n\ndo x');

    fake.feed('\x03');
    fake.feed('\x03');
    expect(await exit).toBe(0);
  });

  it('refuses an unknown skill locally, by name', async () => {
    const { fake, exit, admitted } = startStubSkillSession();
    await waitFor(() => fake.counts.started === 1);

    for (const ch of '/skill:ghost do x') fake.feed(ch);
    fake.feed('\r');
    await waitForText(fake, "skill: unknown skill 'ghost'");
    // Nothing reached the lane.
    expect(admitted).toEqual([]);

    // A refused submit keeps the draft, and the first Ctrl-C clears it —
    // only the double press after it quits.
    fake.feed('\x03');
    fake.feed('\x03');
    fake.feed('\x03');
    expect(await exit).toBe(0);
  });

  it('reports the usage for a bare /skill', async () => {
    const { fake, exit, admitted } = startStubSkillSession();
    await waitFor(() => fake.counts.started === 1);

    for (const ch of '/skill') fake.feed(ch);
    fake.feed('\r');
    await waitForText(fake, 'usage: /skill:<name>');
    expect(admitted).toEqual([]);

    // As above: the refused draft eats the first Ctrl-C.
    fake.feed('\x03');
    fake.feed('\x03');
    fake.feed('\x03');
    expect(await exit).toBe(0);
  });
});

describe('kubic tui /skill: over the real lane', () => {
  it('drives the hidden skill content to the model, never the system prompt', async () => {
    const root = tmpRoot();
    const skillsDir = join(root, 'skills');
    const secret = writeSkill(
      join(skillsDir, 'secret'),
      'name: secret\ndescription: Hidden helper\ndisableModelInvocation: true',
      'Hidden content.',
    );
    // A visible skill proves the boot loaded the set (its name reaches the
    // system prompt while the hidden one stays out).
    writeSkill(
      join(skillsDir, 'open'),
      'name: open\ndescription: Visible helper',
      'Open content.',
    );
    const capture = captureAllMessages();
    const fake = recordingTerminal();
    const exit = runTuiCommand(
      {},
      {
        out: () => {},
        createTerminal: () => fake.terminal,
        colorLevel: 'none',
        bootLane: async (sessionId) =>
          bootTuiLane(sessionId, {
            sessionsRoot: root,
            models: textModels(capture.respond),
            env: new FakeExecutionEnv({}),
            model: { provider: 'faux', id: 'text' },
            noSkills: true,
            skillsList: [secret, join(skillsDir, 'open', 'SKILL.md')],
          }),
      },
    );
    await waitFor(() => fake.counts.started === 1);

    for (const ch of '/skill:secret do x') fake.feed(ch);
    fake.feed('\r');
    // The turn's request carries the user message first; the system prompt
    // arrives on its own request — wait for both before asserting.
    await waitFor(
      () =>
        capture.seen.some((message) => message.role === 'user') &&
        capture.seen.some((message) => message.role === 'system'),
    );

    const userTexts = capture.seen
      .filter((message) => message.role === 'user')
      .map(messageText)
      .join('\n');
    expect(userTexts).toContain('Hidden content.');
    expect(userTexts).toContain('do x');

    const systemTexts = capture.seen
      .filter((message) => message.role === 'system')
      .map(messageText)
      .join('\n');
    expect(systemTexts).toContain('<name>open</name>');
    expect(systemTexts).not.toContain('Hidden content.');

    fake.feed('\x03');
    fake.feed('\x03');
    expect(await exit).toBe(0);
  });
});

describe('withheld skills are not invocable or completed', () => {
  it('excludes a role-withheld skill from completion names and invocation', async () => {
    const workspace = tmpRoot('kubic-tui-skill-gate-');
    mkdirSync(join(workspace, '.git'), { recursive: true });
    const skillsDir = join(workspace, '.agents', 'skills');
    writeSkill(
      join(skillsDir, 'secret'),
      'name: secret\ndescription: Hidden helper\ndisableModelInvocation: true',
      'Hidden content.',
    );
    writeSkill(
      join(skillsDir, 'open'),
      'name: open\ndescription: Visible helper',
      'Open content.',
    );
    mkdirSync(join(workspace, '.kubic', 'roles'), { recursive: true });
    writeFileSync(
      join(workspace, '.kubic', 'roles', 'narrow.md'),
      '---\nrole: narrow\ntools: [read, ls]\nfilesystem: read\nshell: false\nnetwork: none\ngit: false\ncredentials: none\nskills: [open]\n---\n# Narrow\n\n## Prompt\n\nBe narrow.\n',
    );
    const boot = await bootTuiLane(undefined, {
      sessionsRoot: tmpRoot(),
      models: textModels(() => fauxAssistantMessage('seen')),
      env: new FakeExecutionEnv({}),
      model: { provider: 'faux', id: 'text' },
      noSkills: true,
      skillsList: [
        join(skillsDir, 'secret', 'SKILL.md'),
        join(skillsDir, 'open', 'SKILL.md'),
      ],
      role: 'narrow',
      roles: { cwd: workspace, trusted: true },
    });
    try {
      expect(boot.skillInvocation?.names).toEqual(['open']);
      expect(() => boot.skillInvocation?.invoke('secret', 'do x')).toThrow(
        "unknown skill 'secret'",
      );
    } finally {
      await boot.close?.();
    }
  });
});
