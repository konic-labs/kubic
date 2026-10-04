// Skills on the live solo path (issue #99, scope item 2; §29).
// Before #99 nothing in the shipped binary called discoverSkills /
// formatSkillsForSystemPrompt and `--no-skills` did not exist. These tests
// pin that the composition root runs discovery through the real FileBridge
// and hands the model-visible blocks to the lane boot.
//
// Faux provider only (zero network, zero paid tokens): the assertions are
// about the committed solo prompt bytes, read back from the session
// transcript (#400's reader) after a real `kubic run`.
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runHeadlessPrompt } from '../../../apps/kubic/src/headless-run.js';
import { FakeExecutionEnv, NodeExecutionEnv } from '../../exec/src/env.js';
import { createNodeFileBridge } from '../../exec/src/file-bridge.js';
import {
  attachSession,
  openSessionStore,
} from '../../worker/src/lane/session-store.js';
import { SOLO_PROMPT_SECTION } from '../../worker/src/lane/solo.js';
import { fauxToolUse } from '../../worker/src/lane/test-harness.js';
import {
  entriesToTranscript,
  readSessionEntries,
} from '../../worker/src/lane/transcript.js';
import {
  BACKGROUND_CONTEXT,
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
  type MutableModels,
  SystemEntry,
} from '../../worker/src/pi-boundary.js';
import { runRunCommand } from './run-cli.js';

const made: string[] = [];

function tmpRoot(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  made.push(dir);
  return dir;
}

function fauxModels(texts: string[]): MutableModels {
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  faux.setResponses(texts.map((text) => fauxAssistantMessage(text)));
  return models;
}

// A discovery root holding one skill, written with real files: the prod
// path runs the real FileBridge, so a fake bridge would not prove it.
function writeSkill(root: string, name: string, description: string): string {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, 'SKILL.md');
  writeFileSync(
    file,
    `---\nname: ${name}\ndescription: ${description}\n---\n\nBody for ${name}.\n`,
  );
  return file;
}

// The solo prompt the lane committed for this session (#400's reader): the
// run's own durable record of the bytes the model saw.
async function committedPrompt(
  root: string,
  sessionId: string,
): Promise<string> {
  const store = openSessionStore(root, createNodeFileBridge(root));
  const session = await attachSession(store, sessionId, BACKGROUND_CONTEXT);
  try {
    const entries = await readSessionEntries(
      session.storage,
      BACKGROUND_CONTEXT,
    );
    for (const entry of [...entries].reverse()) {
      if (!SystemEntry.is(entry)) continue;
      const messages = entry.model as unknown as
        | Array<{ sections?: Record<string, string | null> }>
        | undefined;
      const prompt = messages?.[0]?.sections?.[SOLO_PROMPT_SECTION];
      if (typeof prompt === 'string' && prompt !== '') return prompt;
    }
    return '';
  } finally {
    await session.release(BACKGROUND_CONTEXT);
  }
}

beforeEach(() => {
  // The solo notice is not under test here (solo-notice-prod.test.ts owns
  // it); the documented opt-out keeps it off the test runner's stderr.
  vi.stubEnv('KUBIC_NO_NOTICE', '1');
});

afterEach(() => {
  vi.restoreAllMocks();
  // Restores KUBIC_TRUST_PROJECT to the developer's own value too.
  vi.unstubAllEnvs();
  for (const dir of made.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

describe('skills reach the live solo prompt (issue #99, §29.3)', () => {
  it("injects a discovered skill's name, description and path into the assembled system prompt", async () => {
    const home = tmpRoot('skills-home-');
    const skillFile = writeSkill(
      join(home, '.agents', 'skills'),
      'deploy-widget',
      'Ship the widget to staging',
    );
    const root = tmpRoot('skills-sessions-');
    const result = await runHeadlessPrompt(
      'hello',
      {},
      {
        sessionsRoot: root,
        models: fauxModels(['done']),
        env: new FakeExecutionEnv({}),
        // The documented trust opt-in is the prod default; the test
        // injects it so the assertion does not depend on the dev's env.
        skills: { homeDir: home, trusted: true },
      },
    );
    expect(result.terminus).toBe('completed');
    const prompt = await committedPrompt(root, result.sessionId);
    // The §29 injection block itself.
    expect(prompt).toContain('<skills>');
    expect(prompt).toContain('<name>deploy-widget</name>');
    expect(prompt).toContain(
      '<description>Ship the widget to staging</description>',
    );
    expect(prompt).toContain(`<filePath>${skillFile}</filePath>`);
    // Appended, never a replacement: the assembled base survives.
    expect(prompt).toContain('cwd:');
    expect(prompt).toContain('tools:');
  });

  it('excludes a project skill when the cwd is untrusted, and includes it once trusted', async () => {
    const home = tmpRoot('skills-home-');
    const cwd = tmpRoot('skills-cwd-');
    const skillFile = writeSkill(
      join(cwd, '.agents', 'skills'),
      'project-only',
      'Lives in the repo',
    );
    const root = tmpRoot('skills-sessions-');
    const untrusted = await runHeadlessPrompt(
      'hello',
      {},
      {
        sessionsRoot: root,
        models: fauxModels(['done']),
        env: new FakeExecutionEnv({}),
        // Untrusted cwd: the project roots are never traversed.
        skills: { homeDir: home, cwd, trusted: false },
      },
    );
    const untrustedPrompt = await committedPrompt(root, untrusted.sessionId);
    expect(untrustedPrompt).not.toContain('project-only');
    expect(untrustedPrompt).not.toContain(`<filePath>${skillFile}</filePath>`);

    // Same tree, trusted: the skill appears — so the exclusion above is
    // the trust gate, not a loader that never finds anything.
    const trusted = await runHeadlessPrompt(
      'hello',
      {},
      {
        sessionsRoot: root,
        models: fauxModels(['done']),
        env: new FakeExecutionEnv({}),
        skills: { homeDir: home, cwd, trusted: true },
      },
    );
    const trustedPrompt = await committedPrompt(root, trusted.sessionId);
    expect(trustedPrompt).toContain('<name>project-only</name>');
    expect(trustedPrompt).toContain(`<filePath>${skillFile}</filePath>`);
  });

  it('suppresses discovery under --no-skills', async () => {
    const home = tmpRoot('skills-home-');
    writeSkill(
      join(home, '.agents', 'skills'),
      'deploy-widget',
      'Ship the widget to staging',
    );
    const root = tmpRoot('skills-sessions-');
    const result = await runHeadlessPrompt(
      'hello',
      { noSkills: true },
      {
        sessionsRoot: root,
        models: fauxModels(['done']),
        env: new FakeExecutionEnv({}),
        skills: { homeDir: home, trusted: true },
      },
    );
    const prompt = await committedPrompt(root, result.sessionId);
    expect(prompt).not.toContain('<skills>');
    expect(prompt).not.toContain('deploy-widget');
  });

  it('parses --no-skills and a repeatable --skill on the run command', async () => {
    const seen: Array<Record<string, unknown>> = [];
    const out: string[] = [];
    const exit = await runRunCommand(
      { prompt: 'hi', noSkills: true, skills: ['/tmp/one', '/tmp/two'] },
      {
        out: (line) => out.push(line),
        run: (prompt, options) => {
          seen.push({ prompt, ...options });
          return Promise.resolve({
            terminus: 'completed',
            summary: 'ok',
            sessionId: 's',
            journalRef: 'journal:s',
            usageRef: 'usage:s',
            trajectoryRef: 'trajectory:s',
          });
        },
      },
    );
    expect(exit).toBe(0);
    expect(seen[0]?.noSkills).toBe(true);
    expect(seen[0]?.skills).toEqual(['/tmp/one', '/tmp/two']);
  });

  it('leaves skills unset when the flags are absent', async () => {
    const seen: Array<Record<string, unknown>> = [];
    await runRunCommand(
      { prompt: 'hi' },
      {
        out: () => undefined,
        run: (prompt, options) => {
          seen.push({ prompt, ...options });
          return Promise.resolve({
            terminus: 'completed',
            summary: 'ok',
            sessionId: 's',
            journalRef: 'journal:s',
            usageRef: 'usage:s',
            trajectoryRef: 'trajectory:s',
          });
        },
      },
    );
    expect(seen[0]?.noSkills).toBeUndefined();
    expect(seen[0]?.skills).toBeUndefined();
  });

  it('reads the documented trust opt-in from the environment on the production default', async () => {
    // The prod default for `trusted` is the same switch the config layer
    // reads (`KUBIC_TRUST_PROJECT`, §35.1/§29.3) — not an always-on. With
    // the variable absent the project skill stays out; with it set the
    // skill lands, so the flag is genuinely read rather than hardcoded.
    const home = tmpRoot('skills-home-');
    const cwd = tmpRoot('skills-cwd-');
    writeSkill(join(cwd, '.agents', 'skills'), 'env-gated', 'Needs the opt-in');
    const root = tmpRoot('skills-sessions-');
    vi.stubEnv('KUBIC_TRUST_PROJECT', undefined);
    const untrusted = await runHeadlessPrompt(
      'hello',
      {},
      {
        sessionsRoot: root,
        models: fauxModels(['done']),
        env: new FakeExecutionEnv({}),
        // No explicit `trusted`: the env switch decides.
        skills: { homeDir: home, cwd },
      },
    );
    expect(await committedPrompt(root, untrusted.sessionId)).not.toContain(
      'env-gated',
    );

    vi.stubEnv('KUBIC_TRUST_PROJECT', '1');
    const trusted = await runHeadlessPrompt(
      'hello',
      {},
      {
        sessionsRoot: root,
        models: fauxModels(['done']),
        env: new FakeExecutionEnv({}),
        skills: { homeDir: home, cwd },
      },
    );
    expect(await committedPrompt(root, trusted.sessionId)).toContain(
      '<name>env-gated</name>',
    );
  });
});

// Issue #173: the advertised <filePath> must be openable by the read tool.
describe('advertised skills outside the workspace are readable (issue #173, §29.3)', () => {
  async function readResults(
    calls: { name: string; args: Parameters<typeof fauxToolCall>[1] }[],
    skills: { homeDir: string; cwd: string; trusted: boolean },
  ): Promise<{ toolName?: string; isError?: boolean; text: string }[]> {
    const root = tmpRoot('skills-sessions-');
    const faux = fauxProvider();
    const models = createModels();
    models.setProvider(faux.provider);
    faux.setResponses([
      // Only a toolUse turn runs its calls (fauxToolUse, #401).
      fauxToolUse(calls.map((call) => fauxToolCall(call.name, call.args))),
      fauxAssistantMessage('done'),
    ]);
    const result = await runHeadlessPrompt(
      'load the skill',
      {},
      {
        sessionsRoot: root,
        models,
        env: new NodeExecutionEnv(skills.cwd),
        skills,
      },
    );
    const store = openSessionStore(root, createNodeFileBridge(root));
    const session = await attachSession(
      store,
      result.sessionId,
      BACKGROUND_CONTEXT,
    );
    try {
      return entriesToTranscript(
        await readSessionEntries(session.storage, BACKGROUND_CONTEXT),
      )
        .filter((item) => item.kind === 'tool-result')
        .map((item) => ({
          toolName: item.name,
          isError: item.isError,
          text: item.text,
        }));
    } finally {
      await session.release(BACKGROUND_CONTEXT);
    }
  }

  it('reads a user skill by its absolute path; an unrelated outside read stays re-rooted', async () => {
    const home = tmpRoot('skills-home-');
    const cwd = tmpRoot('skills-ws-');
    const skillFile = writeSkill(
      join(home, '.agents', 'skills'),
      'a',
      'User skill a',
    );
    writeFileSync(join(home, 'secret.txt'), 'top secret\n');
    const results = await readResults(
      [
        { name: 'read', args: { path: skillFile } },
        { name: 'read', args: { path: join(home, 'secret.txt') } },
      ],
      { homeDir: home, cwd, trusted: false },
    );
    // Tool results may settle in either order: match them by content.
    expect(results).toHaveLength(2);
    const skillRead = results.find((r) => r.text.includes('Body for a.'));
    expect(skillRead?.isError, JSON.stringify(results)).toBe(false);
    // The unrelated outside path was re-rooted into the workspace (where
    // no such file exists), never served from $HOME.
    expect(results.some((r) => r.text.includes('top secret'))).toBe(false);
    expect(results.some((r) => r.text.includes('not_found'))).toBe(true);
  });

  it('never lets write or edit reach the skill file', async () => {
    const home = tmpRoot('skills-home-');
    const cwd = tmpRoot('skills-ws-');
    const skillFile = writeSkill(
      join(home, '.agents', 'skills'),
      'a',
      'User skill a',
    );
    await readResults(
      [
        { name: 'write', args: { path: skillFile, content: 'pwned' } },
        {
          name: 'edit',
          args: { path: skillFile, oldText: 'Body', newText: 'Pwned' },
        },
      ],
      { homeDir: home, cwd, trusted: false },
    );
    expect(readFileSync(skillFile, 'utf8')).toContain('Body for a.');
  });

  it('reads a trusted ancestor project skill', async () => {
    const home = tmpRoot('skills-home-');
    const ancestor = tmpRoot('skills-ancestor-');
    const cwd = join(ancestor, 'pkg');
    mkdirSync(cwd, { recursive: true });
    const skillFile = writeSkill(
      join(ancestor, '.agents', 'skills'),
      'b',
      'Ancestor skill b',
    );
    const results = await readResults(
      [{ name: 'read', args: { path: skillFile } }],
      { homeDir: home, cwd, trusted: true },
    );
    expect(results[0]?.isError).toBe(false);
    expect(results[0]?.text).toContain('Body for b.');
  });
});
