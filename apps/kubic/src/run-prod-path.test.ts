// Prod `kubic run -p` path: drives the composition-root
// adapter (apps/kubic) against a real lane with faux models. This file
// lives in host because vitest only includes packages/* — it reaches
// across to the adapter purely as a black-box caller, never into lane
// internals. Faux provider only: zero network.
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  attachSession,
  openSessionStore,
} from '../../../packages/agent/src/lane/session-store.js';
import {
  entriesToTranscript,
  readSessionEntries,
} from '../../../packages/agent/src/lane/transcript.js';
import {
  BACKGROUND_CONTEXT,
  createModels,
  type EntryRecord,
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
  type MutableModels,
} from '../../../packages/agent/src/pi-boundary.js';
import { FakeExecutionEnv } from '../../../packages/exec/src/env.js';
import { createNodeFileBridge } from '../../../packages/exec/src/file-bridge.js';
import { resolveEffectivePolicy } from '../../../packages/host/src/policy/enterprise.js';
import {
  buildRunEnvelope,
  mapTerminusToExitCode,
  runRunCommand,
} from '../../../packages/host/src/run-cli.js';
import { runHeadlessPrompt } from './headless-run.js';

const made: string[] = [];

function tmpRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), 'run-prod-path-'));
  made.push(dir);
  return dir;
}

beforeEach(() => {
  // The solo notice is not under test here (solo-notice-prod.test.ts owns
  // it); the documented opt-out keeps it off the test runner's stderr.
  vi.stubEnv('KUBIC_NO_NOTICE', '1');
});

afterEach(() => {
  vi.unstubAllEnvs();
  for (const dir of made.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

function fauxModels(texts: string[]): MutableModels {
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  faux.setResponses(texts.map((text) => fauxAssistantMessage(text)));
  return models;
}

function entryTexts(entries: unknown): string[] {
  if (!Array.isArray(entries)) return [];
  const out: string[] = [];
  for (const entry of entries) {
    const model = (entry as { model?: unknown }).model;
    if (!Array.isArray(model)) continue;
    for (const message of model) {
      const content = (message as { content?: unknown }).content;
      if (typeof content === 'string') {
        out.push(content);
        continue;
      }
      if (!Array.isArray(content)) continue;
      for (const part of content) {
        const text = (part as { type?: unknown; text?: unknown }).text;
        if (
          (part as { type?: unknown }).type === 'text' &&
          typeof text === 'string'
        )
          out.push(text);
      }
    }
  }
  return out;
}

// The user-message texts of a session's active transcript, in order: the
// unit the "exactly one user entry per prompt" counts.
function userTexts(entries: unknown): string[] {
  if (!Array.isArray(entries)) return [];
  const out: string[] = [];
  for (const entry of entries) {
    if ((entry as { kind?: unknown }).kind !== 'pi.user') continue;
    out.push(...entryTexts([entry]));
  }
  return out;
}

// Read a session's active transcript the way a CLI reader does: the
// storage directly, no harness boot, and the handle gives the lock back.
async function readTranscript(
  root: string,
  id: string,
): Promise<EntryRecord[]> {
  const store = openSessionStore(root, createNodeFileBridge(root));
  const session = await attachSession(store, id, BACKGROUND_CONTEXT);
  try {
    return await readSessionEntries(session.storage, BACKGROUND_CONTEXT);
  } finally {
    await session.release(BACKGROUND_CONTEXT);
  }
}

describe('prod run path, live lane', () => {
  it('drives a faux lane to completed with the assistant summary', async () => {
    const root = tmpRoot();
    const result = await runHeadlessPrompt(
      'do it',
      {},
      {
        sessionsRoot: root,
        models: fauxModels(['all done']),
        env: new FakeExecutionEnv({}),
      },
    );
    expect(result.terminus).toBe('completed');
    expect(result.summary).toContain('all done');
    expect(result.sessionId).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(existsSync(join(root, result.sessionId, 'journal'))).toBe(true);
    const entries = await readTranscript(root, result.sessionId);
    expect(entryTexts(entries).join('\n')).toMatch(/do it/);
  });

  it('maps a starved lane drive to failed', async () => {
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
  });
});

describe('prod run path, resume chain', () => {
  it('resumes the same session and keeps one user entry per prompt', async () => {
    const root = tmpRoot();
    const env = new FakeExecutionEnv({});
    const first = await runHeadlessPrompt(
      'first prompt',
      {},
      { sessionsRoot: root, models: fauxModels(['first done']), env },
    );
    expect(first.terminus).toBe('completed');
    const id = first.sessionId;
    const second = await runHeadlessPrompt(
      'second prompt',
      { sessionId: id },
      { sessionsRoot: root, models: fauxModels(['second done']), env },
    );
    expect(second.terminus).toBe('completed');
    expect(second.sessionId).toBe(id);
    const entries = await readTranscript(root, id);
    // The 1.0 store is linear and identifies entries by its own ids; what
    // the resume must preserve is the transcript: both prompts, once each.
    const ids = entries.map((entry) => String((entry as { id?: unknown }).id));
    expect(new Set(ids).size).toBe(ids.length);
    expect(userTexts(entries)).toEqual(['first prompt', 'second prompt']);
    expect(entryTexts(entries).join('\n')).toMatch(/first prompt/);
    expect(entryTexts(entries).join('\n')).toMatch(/second prompt/);
    expect(entryTexts(entries).join('\n')).toMatch(/first done/);
    expect(entryTexts(entries).join('\n')).toMatch(/second done/);
  });
});

describe('prod run path, durable retry', () => {
  it('settles completed after a transient provider error, with both attempts counted', {
    timeout: 20_000,
  }, async () => {
    const root = tmpRoot();
    const faux = fauxProvider();
    const models = createModels();
    models.setProvider(faux.provider);
    // The first attempt is a retryable provider error; the harness owns the
    // backoff and retries inside the durable generation task.
    faux.setResponses([
      fauxAssistantMessage('failed attempt', {
        stopReason: 'error',
        errorMessage: 'server error 500',
      }),
      fauxAssistantMessage('recovered'),
    ]);
    const result = await runHeadlessPrompt(
      'retry please',
      {},
      { sessionsRoot: root, models, env: new FakeExecutionEnv({}) },
    );
    expect(result.terminus).toBe('completed');
    // The ANSWER is the second response: the retry happened, and it happened
    // inside the harness (Kubic has no drive loop and no sleep of its own).
    expect(result.summary).toBe('recovered');
    expect(faux.state.callCount).toBe(2);
    // The failed attempt spent tokens: the run's usage counts both requests.
    expect(result.usage?.input).toBeGreaterThan(0);
    const entries = await readTranscript(root, result.sessionId);
    const items = entriesToTranscript(entries);
    // Stands on the retry path too: the prompt appears exactly once.
    expect(items.filter((item) => item.kind === 'user')).toHaveLength(1);
    // Both attempts are committed responses: the retryable error, then the
    // answer. That the ANSWER is the summary proves the harness retried
    // without Kubic driving anything.
    const assistantTexts = items
      .filter((item) => item.kind === 'assistant')
      .map((item) => item.text);
    expect(assistantTexts).toEqual(['failed attempt', 'recovered']);
  });
});

describe('exactly one user entry per kubic run prompt', () => {
  it('writes ONE user entry for a turn that calls a tool', async () => {
    const root = tmpRoot();
    const env = new FakeExecutionEnv({});
    env.fs.writeFile('a.txt', 'one entry reads this\n');
    const faux = fauxProvider();
    const models = createModels();
    models.setProvider(faux.provider);
    faux.setResponses([
      fauxAssistantMessage([fauxToolCall('read', { path: 'a.txt' })], {
        stopReason: 'toolUse',
      }),
      fauxAssistantMessage('read it'),
    ]);
    const result = await runHeadlessPrompt(
      'read the file',
      {},
      { sessionsRoot: root, models, env },
    );
    expect(result.terminus).toBe('completed');
    const entries = await readTranscript(root, result.sessionId);
    // The raw pre-boot prompt write duplicated submit's own pi.user
    // entry on every run; the prompt must appear exactly once.
    expect(userTexts(entries)).toEqual(['read the file']);
    expect(entryTexts(entries).join('\n')).toMatch(/one entry reads this/);
  });

  it('writes ONE user entry per prompt across a resume', async () => {
    const root = tmpRoot();
    const env = new FakeExecutionEnv({});
    const first = await runHeadlessPrompt(
      'first prompt',
      {},
      { sessionsRoot: root, models: fauxModels(['first done']), env },
    );
    const second = await runHeadlessPrompt(
      'second prompt',
      { sessionId: first.sessionId },
      { sessionsRoot: root, models: fauxModels(['second done']), env },
    );
    expect(second.terminus).toBe('completed');
    const entries = await readTranscript(root, second.sessionId);
    expect(userTexts(entries)).toEqual(['first prompt', 'second prompt']);
  });

  it('writes the prompt once even when the turn never started (no model)', async () => {
    const root = tmpRoot();
    const result = await runHeadlessPrompt(
      'durable no-model prompt',
      {},
      {
        sessionsRoot: root,
        models: createModels(),
        env: new FakeExecutionEnv({}),
      },
    );
    expect(result.terminus).toBe('provider_probe_failed');
    const entries = await readTranscript(root, result.sessionId);
    expect(userTexts(entries)).toEqual(['durable no-model prompt']);
  });
});

describe('prod run path, empty summary honesty', () => {
  const NON_ANSWER = '(no assistant text — the run settled without output)';
  const PROMPT_FIXTURE = 'PROMPT-FIXTURE-never-echoed-8f2c';

  function out(): { lines: string[]; write: (line: string) => void } {
    const lines: string[] = [];
    return { lines, write: (line: string) => lines.push(line) };
  }

  function emptySummaryRun(root: string) {
    // An empty assistant text block: the lane settles completed with no
    // model-authored summary to report.
    return (prompt: string) =>
      runHeadlessPrompt(
        prompt,
        {},
        {
          sessionsRoot: root,
          models: fauxModels(['']),
          env: new FakeExecutionEnv({}),
        },
      );
  }

  it('prints the named non-answer instead of echoing the prompt (text)', async () => {
    const root = tmpRoot();
    const o = out();
    const exit = (
      await runRunCommand(
        { prompt: PROMPT_FIXTURE },
        {
          out: o.write,
          run: emptySummaryRun(root),
        },
      )
    ).exitCode;
    expect(exit).toBe(0);
    const text = o.lines.join('\n');
    expect(text).toContain(`result: ${NON_ANSWER}`);
    // The operator's own input never comes back as the result.
    expect(text).not.toContain(PROMPT_FIXTURE);
  });

  it('carries the same named non-answer in the --json envelope', async () => {
    const root = tmpRoot();
    const o = out();
    const exit = (
      await runRunCommand(
        { prompt: PROMPT_FIXTURE, json: true },
        {
          out: o.write,
          run: emptySummaryRun(root),
        },
      )
    ).exitCode;
    expect(exit).toBe(0);
    expect(o.lines.length).toBe(1);
    const envelope = JSON.parse(o.lines[0] as string) as {
      status: string;
      exitCode: number;
      result: { summary: string };
    };
    expect(envelope.status).toBe('completed');
    expect(envelope.exitCode).toBe(0);
    expect(envelope.result.summary).toBe(NON_ANSWER);
    expect(envelope.result.summary).not.toContain(PROMPT_FIXTURE);
  });

  it('still reports one empty-summary run as the envelope built from its result', async () => {
    const root = tmpRoot();
    const result = await runHeadlessPrompt(
      PROMPT_FIXTURE,
      {},
      {
        sessionsRoot: root,
        models: fauxModels(['']),
        env: new FakeExecutionEnv({}),
      },
    );
    expect(result.terminus).toBe('completed');
    const envelope = buildRunEnvelope(
      result,
      mapTerminusToExitCode(result.terminus),
    );
    expect(envelope.result.summary).toBe(NON_ANSWER);
  });

  it('passes real assistant text through byte-identical (control)', async () => {
    const root = tmpRoot();
    const result = await runHeadlessPrompt(
      'do it',
      {},
      {
        sessionsRoot: root,
        models: fauxModels(['all done']),
        env: new FakeExecutionEnv({}),
      },
    );
    expect(result.terminus).toBe('completed');
    expect(result.summary).toBe('all done');
  });
});

describe('enterprise policy gate on model selection', () => {
  it('refuses a model outside allowed_models before any provider call', async () => {
    const root = tmpRoot();
    const allowed = fauxProvider();
    const denied = fauxProvider({ provider: 'other' });
    const models = createModels();
    models.setProvider(allowed.provider);
    models.setProvider(denied.provider);
    allowed.setResponses([fauxAssistantMessage('should never run')]);
    denied.setResponses([fauxAssistantMessage('should never run')]);
    const policy = resolveEffectivePolicy([
      { layer: 'enterprise', policy: { models: { allowed: ['faux/*'] } } },
    ]).policy;
    const result = await runHeadlessPrompt(
      'hello',
      {},
      {
        sessionsRoot: root,
        models,
        env: new FakeExecutionEnv({}),
        model: { provider: 'other', id: denied.getModel().id },
        modelPolicy: policy,
      },
    );
    // A named policy refusal, never a probe against the denied provider: the

    // run ends before the first request.
    expect(result.terminus).toBe('provider_probe_failed');
    expect(result.error?.message).toMatch(/policy/i);
    expect(result.error?.message).toContain('other');
    expect(allowed.state.callCount).toBe(0);
    expect(denied.state.callCount).toBe(0);
  });

  it('skips a policy-denied provider for the implicit fallback pick', async () => {
    const root = tmpRoot();
    const allowed = fauxProvider();
    const denied = fauxProvider({ provider: 'other' });
    const models = createModels();
    // The registered order makes the DENIED provider first: the fallback
    // pick must skip it rather than select-and-refuse.
    models.setProvider(denied.provider);
    models.setProvider(allowed.provider);
    allowed.setResponses([fauxAssistantMessage('allowed answer')]);
    denied.setResponses([fauxAssistantMessage('should never run')]);
    const policy = resolveEffectivePolicy([
      { layer: 'enterprise', policy: { models: { allowed: ['faux/*'] } } },
    ]).policy;
    const result = await runHeadlessPrompt(
      'hello',
      {},
      {
        sessionsRoot: root,
        models,
        env: new FakeExecutionEnv({}),
        modelPolicy: policy,
      },
    );
    expect(result.terminus).toBe('completed');
    expect(result.model).toContain(`faux/`);
    expect(allowed.state.callCount).toBeGreaterThan(0);
    expect(denied.state.callCount).toBe(0);
  });

  it('does not let a resumed session keep a stored model the policy refuses', async () => {
    const root = tmpRoot();
    const allowed = fauxProvider();
    const other = fauxProvider({ provider: 'other' });
    const models = createModels();
    models.setProvider(allowed.provider);
    models.setProvider(other.provider);
    allowed.setResponses([fauxAssistantMessage('allowed answer')]);
    other.setResponses([fauxAssistantMessage('created')]);
    // A session created on `other` (an explicit pin, no policy yet)...
    const created = await runHeadlessPrompt(
      'first',
      {},
      {
        sessionsRoot: root,
        models,
        env: new FakeExecutionEnv({}),
        model: { provider: 'other', id: other.getModel().id },
      },
    );
    expect(created.terminus).toBe('completed');
    expect(created.model).toContain('other/');
    const otherCalls = other.state.callCount;
    // ...resumed under an enterprise allowlist that only admits `faux/*`, no
    // pin: the stored `other/*` model must not survive the gate (the session
    // file is user-writable, so it cannot be trusted to carry a compliant one).
    const resumed = await runHeadlessPrompt(
      'second',
      { sessionId: created.sessionId },
      {
        sessionsRoot: root,
        models,
        env: new FakeExecutionEnv({}),
        modelPolicy: resolveEffectivePolicy([
          { layer: 'enterprise', policy: { models: { allowed: ['faux/*'] } } },
        ]).policy,
      },
    );
    expect(resumed.terminus).toBe('completed');
    expect(resumed.model).toContain('faux/');
    expect(resumed.summary).toBe('allowed answer');
    expect(other.state.callCount).toBe(otherCalls);
  });

  it('runs a model the policy allows, unchanged (control)', async () => {
    const root = tmpRoot();
    const result = await runHeadlessPrompt(
      'hello',
      {},
      {
        sessionsRoot: root,
        models: fauxModels(['policy ok']),
        env: new FakeExecutionEnv({}),
        modelPolicy: resolveEffectivePolicy([
          { layer: 'enterprise', policy: { models: { allowed: ['faux/*'] } } },
        ]).policy,
      },
    );
    expect(result.terminus).toBe('completed');
    expect(result.summary).toBe('policy ok');
  });
});

describe('prod run path, result refs (mutation hardening)', () => {
  it('points journal/usage/trajectory refs at the live session', async () => {
    const root = tmpRoot();
    const result = await runHeadlessPrompt(
      'do it',
      {},
      {
        sessionsRoot: root,
        models: fauxModels(['all done']),
        env: new FakeExecutionEnv({}),
      },
    );
    expect(result.terminus).toBe('completed');
    const id = result.sessionId;
    expect(result.journalRef).toBe(`journal:${id}`);
    expect(result.usageRef).toBe(`usage:${id}`);
    // The ref resolves — it names the written trajectory file.
    expect(result.trajectoryRef).toBe(join(root, id, 'trajectory.json'));
    expect(existsSync(result.trajectoryRef)).toBe(true);
    expect(result.error).toBeUndefined();
  });

  it('maps an unknown --session attach to workspace_unavailable, keeping the id in every ref', async () => {
    const root = tmpRoot();
    const result = await runHeadlessPrompt(
      'hello',
      { sessionId: 'sess-nope' },
      {
        sessionsRoot: root,
        models: fauxModels(['unused']),
        env: new FakeExecutionEnv({}),
      },
    );
    expect(result.terminus).toBe('workspace_unavailable');
    expect(result.sessionId).toBe('sess-nope');
    expect(result.journalRef).toBe('journal:sess-nope');
    expect(result.usageRef).toBe('usage:sess-nope');
    expect(result.trajectoryRef).toBe('trajectory:sess-nope');
    expect(result.error?.kind).toBe('workspace_unavailable');
    expect(result.error?.message).toMatch(/sess-nope/);
  });

  it('maps an empty model registry to provider_probe_failed with that kind', async () => {
    const root = tmpRoot();
    const result = await runHeadlessPrompt(
      'hello',
      {},
      {
        sessionsRoot: root,
        models: createModels(),
        env: new FakeExecutionEnv({}),
      },
    );
    expect(result.terminus).toBe('provider_probe_failed');
    expect(result.sessionId).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(result.error?.kind).toBe('provider_probe_failed');
    expect(result.error?.message).toMatch(/\S/);
  });

  it('persists the prompt even when no model can run it', async () => {
    const root = tmpRoot();
    const result = await runHeadlessPrompt(
      'durable hello',
      {},
      {
        sessionsRoot: root,
        models: createModels(),
        env: new FakeExecutionEnv({}),
      },
    );
    expect(result.terminus).toBe('provider_probe_failed');
    const entries = await readTranscript(root, result.sessionId);
    expect(entryTexts(entries).join('\n')).toMatch(/durable hello/);
  });
});

// The failure taxonomy reaches the --json envelope. The
// durable `model_error` reason is generic; the detail carries the domain,
// and the envelope's `failure` field reports the classified code.
describe('prod run path, failure code in the envelope', () => {
  function out(): { lines: string[]; write: (line: string) => void } {
    const lines: string[] = [];
    return { lines, write: (line: string) => lines.push(line) };
  }

  function envelopeRun(
    root: string,
    responses: Parameters<ReturnType<typeof fauxProvider>['setResponses']>[0],
  ) {
    const faux = fauxProvider();
    const models = createModels();
    models.setProvider(faux.provider);
    faux.setResponses(responses);
    return (prompt: string) =>
      runHeadlessPrompt(
        prompt,
        {},
        {
          sessionsRoot: root,
          models,
          env: new FakeExecutionEnv({}),
        },
      );
  }

  it('reports a mid-run provider rate-limit refusal as provider_transient, not the probe code', async () => {
    const o = out();
    // 'provider capacity exhausted' is pi-ai's own non-retryable capacity
    // shape (the rate-limit family): the harness settles immediately instead
    // of sleeping through three backoffs, and the failure code is still the
    // provider one.
    const exit = (
      await runRunCommand(
        { prompt: 'rate limited', json: true },
        {
          out: o.write,
          run: envelopeRun(tmpRoot(), [
            fauxAssistantMessage('refused', {
              stopReason: 'error',
              errorMessage: 'provider capacity exhausted',
            }),
          ]),
        },
      )
    ).exitCode;
    expect(exit).toBe(1);
    const envelope = JSON.parse(o.lines[0] as string) as {
      status: string;
      exitCode: number;
      failure?: { code: string };
    };
    expect(envelope.status).toBe('provider_transient');
    expect(envelope.status).not.toBe('provider_probe_failed');
    expect(envelope.exitCode).toBe(1);
    expect(envelope.failure?.code).toBe('provider_transient');
  });

  it('reports a faux tool failure as tool_failed', async () => {
    const o = out();
    const exit = (
      await runRunCommand(
        { prompt: 'tool fails', json: true },
        {
          out: o.write,
          run: envelopeRun(tmpRoot(), [
            fauxAssistantMessage('failed', {
              stopReason: 'error',
              errorMessage: "tool 'read' failed: ENOENT",
            }),
          ]),
        },
      )
    ).exitCode;
    expect(exit).toBe(1);
    const envelope = JSON.parse(o.lines[0] as string) as {
      status: string;
      failure?: { code: string; strategy: string };
    };
    expect(envelope.status).toBe('failed');
    expect(envelope.failure?.code).toBe('tool_failed');
    expect(envelope.failure?.strategy).toBe('retry_same');
  });

  it('reports a plain faux model error as model_failed', async () => {
    const o = out();
    const exit = (
      await runRunCommand(
        { prompt: 'model fails', json: true },
        {
          out: o.write,
          run: envelopeRun(tmpRoot(), [
            fauxAssistantMessage('failed', {
              stopReason: 'error',
              errorMessage: 'the model produced nothing',
            }),
          ]),
        },
      )
    ).exitCode;
    expect(exit).toBe(1);
    const envelope = JSON.parse(o.lines[0] as string) as {
      status: string;
      failure?: { code: string };
    };
    expect(envelope.status).toBe('failed');
    expect(envelope.failure?.code).toBe('model_failed');
  });
});
