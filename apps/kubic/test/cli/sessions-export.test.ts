// `kubic sessions export`: a real faux run exported as Markdown and HTML —
// the conversation, the tool call and its result, the audit rows and the
// journal's change summary — with every secret the run saw redacted, and the
// refusals (a live session, an unknown one) named. Faux provider only.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  attachSession,
  openSessionStore,
} from '@kubic/agent/lane/session-store';
import {
  BACKGROUND_CONTEXT,
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from '@kubic/agent/pi-boundary';
import { fauxToolUse } from '@kubic/agent/test-support/lane-harness';
import { createLineLogger } from '@kubic/core/cli/logger';
import { NodeExecutionEnv } from '@kubic/exec/env';
import { createNodeFileBridge } from '@kubic/exec/file-bridge';
import {
  runSessionsCommand,
  type SessionsInvocation,
} from '@kubic/host/sessions';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { tempDir } from '../../../../test/temp-dir.js';
import { runHeadlessPrompt } from '../../src/run/command.js';

const KEY = 'sk-live-0123456789abcdefghij';
const TOKEN = 'ghp_0123456789abcdefghijABCD';

beforeEach(() => {
  vi.stubEnv('KUBIC_NO_NOTICE', '1');
});

afterEach(() => {
  vi.unstubAllEnvs();
});

// A finished session: the model writes a file holding a key, then answers
// with a token in its text; the prompt names a password.
async function recordedSession(): Promise<{
  root: string;
  workspace: string;
  id: string;
}> {
  const root = tempDir('sessions-export-root-');
  const workspace = tempDir('sessions-export-ws-');
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  faux.setResponses([
    fauxToolUse([
      fauxToolCall('write', {
        path: 'config.env',
        content: `OPENAI_API_KEY=${KEY}\n`,
      }),
    ]),
    fauxAssistantMessage(`Saved it. The deploy token is ${TOKEN}.`),
  ]);
  const result = await runHeadlessPrompt(
    'store the key; password=hunter2-correct-horse',
    {},
    { sessionsRoot: root, models, env: new NodeExecutionEnv(workspace) },
  );
  expect(result.terminus).toBe('completed');
  return { root, workspace, id: result.sessionId };
}

function cli(root: string) {
  const out: string[] = [];
  const err: string[] = [];
  return {
    out,
    err,
    run: (invocation: SessionsInvocation) =>
      runSessionsCommand(invocation, {
        sessionsRoot: root,
        out: (line) => out.push(line),
        logger: createLineLogger((line: string) => err.push(line)),
      }).then((result) => result.exitCode),
  };
}

function expectNoSecret(text: string): void {
  expect(text).not.toContain(KEY);
  expect(text).not.toContain(TOKEN);
  expect(text).not.toContain('hunter2-correct-horse');
}

describe('kubic sessions export', () => {
  it('exports the conversation, tool calls, audit rows and changes as Markdown, redacted', async () => {
    const { root, workspace, id } = await recordedSession();
    // The file the tool wrote really holds the key: only the export hides it.
    expect(readFileSync(join(workspace, 'config.env'), 'utf8')).toContain(KEY);
    const c = cli(root);
    expect(await c.run({ command: 'export', id })).toBe(0);
    const md = c.out.join('\n');
    expect(md).toContain(`# Kubic session ${id}`);
    expect(md).toContain(`- Workspace: ${workspace}`);
    expect(md).toContain('### User');
    expect(md).toContain('store the key; password=[REDACTED]');
    expect(md).toContain('Tool call `write`:');
    expect(md).toContain('#### Result of `write`');
    expect(md).toContain('### Assistant · faux/');
    // The persisted-text redactor over-redacts on purpose: `token is …`.
    expect(md).toContain('Saved it. The deploy token [REDACTED]');
    expect(md).toContain('"content": "OPENAI_API_KEY=[REDACTED]');
    expect(md).toContain('## Audit');
    expect(md).toContain('| run:start |');
    expect(md).toContain('## Changes');
    expect(md).toContain('| config.env | create |');
    expect(md).toContain(`\`kubic diff --session ${id}\``);
    expectNoSecret(md);
  });

  it('exports one self-contained, escaped HTML page, redacted', async () => {
    const { root, id } = await recordedSession();
    const c = cli(root);
    expect(await c.run({ command: 'export', id, format: 'html' })).toBe(0);
    const html = c.out.join('\n');
    expect(html.startsWith('<!doctype html>')).toBe(true);
    expect(html).toContain(`<title>Kubic session ${id}</title>`);
    expect(html).toContain('<h2>Conversation</h2>');
    expect(html).toContain('Tool call <code>write</code>');
    expect(html).toContain('<td>config.env</td><td>create</td>');
    expect(html).not.toMatch(/<script|https?:\/\//);
    expectNoSecret(html);
  });

  it('refuses a session a live run holds, and an unknown one', async () => {
    const { root, id } = await recordedSession();
    const store = openSessionStore(root, createNodeFileBridge(root));
    const held = await attachSession(store, id, BACKGROUND_CONTEXT);
    try {
      const live = cli(root);
      expect(await live.run({ command: 'export', id })).toBe(1);
      expect(live.err.join('\n')).toContain(
        `session ${id} is in use by a live run`,
      );
      expect(live.out).toEqual([]);
    } finally {
      await held.release(BACKGROUND_CONTEXT);
    }
    const unknown = cli(root);
    expect(await unknown.run({ command: 'export', id: 'no-such' })).toBe(1);
    expect(unknown.err.join('\n')).toContain('no-such');
  });
});
