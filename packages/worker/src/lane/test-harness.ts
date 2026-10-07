// Faux-provider harness factory for Kubic tests.
// ONE place knows how a SoloLane is booted in tests: `bootSoloLane` over a
// pi-durable Storage, with the faux provider and a `FakeExecutionEnv`. Tests
// depend on the Kubic shapes this module returns (`SoloLane`, `EntryRecord`,
// the parsed tool results) instead of assembling `Harness.open` + storage +
// session handles themselves, so an upstream rename touches this file, not
// every lane test.
// Two session backings:
// - `storage: 'memory'` (default): a `MemoryStorage` behind a synthetic
//   `SessionHandle`. Fast, and the right choice for a lane contract.
// - `storage: 'jsonl'`: a REAL session created through `createSession` in a
//   `root` the CALLER owns (worker may not import `node:fs` — I/O confinement;
//   the test's own scratch-dir helper mints and removes it), so
//   recovery tests exercise the shipped JSONL format and the Kubic session
//   lock. The returned `root`/`store` let a test reopen the same session
//   (`attachSession`) as a second "process".
// The helpers are read-only views over the durable transcript: `run` is one
// admitted input and its wait — the same `submit()` → `wait()` shape `kubic
// run` drives (lane/turn.ts owns the production turn glue).
// Test-only: imported by `*.test.ts` files. The build compiles it but no
// runtime path reaches it (scripts/dead-surface.mjs lists it).

import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FakeExecutionEnv } from '../../../exec/src/env.js';
import { createNodeFileBridge } from '../../../exec/src/file-bridge.js';
import type { FileJournalStore } from '../../../exec/src/journal.js';
import {
  BACKGROUND_CONTEXT,
  type Context,
  createModels,
  type EntryRecord,
  fauxAssistantMessage,
  fauxProvider,
  MemoryStorage,
  SystemEntry,
  type ToolRegistration,
  ToolResultEntry,
} from '../pi-boundary.js';
import type { LaneEventSink } from './events.js';
import { subscribeLaneEvents } from './events.js';
import {
  createSession,
  openSessionStore,
  type SessionHandle,
  type SessionStore,
} from './session-store.js';
import {
  bootSoloLane,
  SOLO_PROMPT_SECTION,
  type SoloBootOptions,
  type SoloLane,
} from './solo.js';

type Models = ReturnType<typeof createModels>;

/** The faux provider handle, without importing pi-ai in a test file. */
export type Faux = ReturnType<typeof fauxProvider>;

/** One scripted faux response (`fauxAssistantMessage(...)` or a factory). */
export type FauxResponseStep = Parameters<Faux['setResponses']>[0][number];

/**
 * An assistant turn that calls tools. The faux provider only executes the
 * calls of a `toolUse` turn, so every tool-driving script goes through here
 * (a bare `fauxAssistantMessage([fauxToolCall(...)])` ends the turn instead).
 */
export function fauxToolUse(
  calls: Parameters<typeof fauxAssistantMessage>[0],
): ReturnType<typeof fauxAssistantMessage> {
  return fauxAssistantMessage(calls, { stopReason: 'toolUse' });
}

/** One faux model definition (`{ id, contextWindow, ... }`). */
export type FauxModel = NonNullable<
  NonNullable<Parameters<typeof fauxProvider>[0]>['models']
>[number];

export interface FauxLaneSessionOptions {
  // 'memory' (default) is a MemoryStorage behind a synthetic handle; 'jsonl'
  // creates a real session store, so recovery tests can
  // `attachSession` the same directory afterwards.
  storage?: 'memory' | 'jsonl';
  // The sessions root for `storage: 'jsonl'`, owned by the caller (worker
  // cannot touch node:fs: mint it with the test's scratch-dir helper and
  // remove it in `afterEach`/`afterAll`).
  root?: string;
  // Session id. Absent: minted by the store ('jsonl') or `sess-1` (memory).
  sessionId?: string;
  cwd?: string;
  workspace?: string;
  // Boot over an existing handle (the attach path of a recovery test).
  handle?: SessionHandle;
}

export interface FauxLaneOptions
  extends Omit<
      SoloBootOptions,
      | 'session'
      | 'models'
      | 'model'
      | 'env'
      | 'sessionId'
      | 'agentId'
      | 'context'
    >,
    FauxLaneSessionOptions {
  // Scripted faux responses, consumed in order. Default: one `'ok'` answer.
  responses?: readonly FauxResponseStep[];
  // Faux model definitions (the boot model is `model`, default the first).
  models?: readonly FauxModel[];
  model?: string;
  env?: FakeExecutionEnv;
  agentId?: string;
  context?: Context;
  // Reuse a provider/handle across boots (a reopen must see the same
  // registry and provider objects, like the host process does).
  faux?: Faux;
}

export interface HarnessToolResult {
  toolName: string;
  toolCallId: string;
  isError: boolean;
  text: string;
  details?: unknown;
  entry: EntryRecord;
}

export interface PromptResult {
  status: 'completed' | 'aborted' | 'failed';
  submissionId: string;
  // The durable reason when the submission settled `unanswered`.
  reason?: string;
}

export interface RunPromptOptions {
  requestId?: string;
  context?: Context;
  whenBusy?: 'reject' | 'followUp' | 'steer';
}

/**
 * Invoke a registered tool exactly as the durable harness invokes it:
 * `execute(args, api, context)`. The api is a minimal structural stub — the
 * tool wrappers under test (the permission/telemetry composition) run before
 * the core, and the core reads `env` from its own captured tool context.
 *
 * A real turn cannot reach this path for a tool the agent does not offer:
 * pi-durable answers `tool_unavailable` itself. This helper invokes the
 * registration the registry really carries, which is what pins the execute-
 * time defense in depth.
 */
export async function invokeRegisteredTool(
  lane: Pick<FauxLane, 'solo'>,
  name: string,
  args: Record<string, unknown>,
  options: { callId?: string; context?: Context } = {},
): Promise<unknown> {
  const tool = lane.solo.registry
    .snapshot()
    .tools()
    .find(({ tool: candidate }) => candidate.name === name)?.tool;
  if (tool === undefined) {
    throw new Error(`no registered tool '${name}'`);
  }
  const api = {
    callId: options.callId ?? 'call-1',
    taskId: 'task-1',
    conversationId: lane.solo.conversation.id,
    output: () => undefined,
    diagnostic: () => undefined,
    details: async () => undefined,
    memo: async () => undefined,
    commit: async () => undefined,
    env: undefined,
  };
  return tool.execute(
    args,
    api as never,
    options.context ?? BACKGROUND_CONTEXT,
  );
}

/** One turn: admit the input durably, then wait for its settlement. */
export async function runPrompt(
  solo: Pick<SoloLane, 'conversation'>,
  prompt: string,
  options: RunPromptOptions = {},
): Promise<PromptResult> {
  const context = options.context ?? BACKGROUND_CONTEXT;
  const submission = await solo.conversation.submit(
    {
      type: 'input',
      content: prompt,
      ...(options.requestId === undefined
        ? {}
        : { requestId: options.requestId }),
      ...(options.whenBusy === undefined ? {} : { whenBusy: options.whenBusy }),
    },
    context,
  );
  const settled = await submission.wait(context);
  const submissionId = String(settled.id);
  if (settled.status === 'done') {
    return { status: 'completed', submissionId };
  }
  if (settled.reason === 'aborted') {
    return { status: 'aborted', submissionId, reason: settled.reason };
  }
  return { status: 'failed', submissionId, reason: settled.reason };
}

/** The conversation's active transcript, oldest first. */
export async function laneEntries(
  solo: Pick<SoloLane, 'conversation'>,
  context: Context = BACKGROUND_CONTEXT,
): Promise<EntryRecord[]> {
  const page = await solo.conversation.entries({}, 1000, undefined, context);
  return [...page.items].reverse();
}

/** The tool results of a conversation, oldest first. */
export async function laneToolResults(
  solo: Pick<SoloLane, 'conversation'>,
  context: Context = BACKGROUND_CONTEXT,
): Promise<HarnessToolResult[]> {
  const entries = await laneEntries(solo, context);
  const out: HarnessToolResult[] = [];
  for (const entry of entries) {
    if (!ToolResultEntry.is(entry)) continue;
    const message = entry.model?.[0];
    if (message?.role !== 'toolResult') continue;
    out.push({
      toolName: message.toolName,
      toolCallId: message.toolCallId,
      isError: message.isError,
      text: message.content
        .map((part) => (part.type === 'text' ? part.text : ''))
        .join(''),
      ...(message.details === undefined ? {} : { details: message.details }),
      entry,
    });
  }
  return out;
}

/** The committed solo prompt (its one `kubic` section), newest entry first. */
export async function laneSystemPrompt(
  solo: Pick<SoloLane, 'conversation'>,
  context: Context = BACKGROUND_CONTEXT,
): Promise<string> {
  const page = await solo.conversation.entries({}, 500, undefined, context);
  for (const entry of page.items) {
    if (!SystemEntry.is(entry)) continue;
    const messages = entry.model as unknown as
      | Array<{ sections?: Record<string, string | null> }>
      | undefined;
    const prompt = messages?.[0]?.sections?.[SOLO_PROMPT_SECTION];
    if (typeof prompt === 'string' && prompt !== '') return prompt;
  }
  return '';
}

/** The tool names the conversation offers right now. */
export async function laneActiveTools(
  solo: Pick<SoloLane, 'conversation'>,
  context: Context = BACKGROUND_CONTEXT,
): Promise<string[]> {
  const agent = await solo.conversation.agent(context);
  return agent.tools.map((tool) => tool.name);
}

/** The `tools:` line of the committed solo prompt, decoded. */
export function promptToolsLine(prompt: string): string[] {
  const line = /^tools: (.*)$/m.exec(prompt)?.[1] ?? '';
  return line
    .split(',')
    .map((name) => name.trim())
    .filter((name) => name !== '');
}

export interface FauxLane {
  readonly solo: SoloLane;
  readonly faux: Faux;
  readonly models: Models;
  readonly env: FakeExecutionEnv;
  readonly session: SessionHandle;
  readonly sessionId: string;
  // Present for `storage: 'jsonl'`: the sessions root and its store, so a
  // recovery test can `attachSession` the same directory.
  readonly root?: string;
  readonly store?: SessionStore;
  run(prompt: string, options?: RunPromptOptions): Promise<PromptResult>;
  entries(): Promise<EntryRecord[]>;
  toolResults(): Promise<HarnessToolResult[]>;
  systemPrompt(): Promise<string>;
  activeTools(): Promise<string[]>;
  registeredTool(name: string): ToolRegistration | undefined;
  subscribe(sink: LaneEventSink): Promise<() => Promise<void>>;
  cleanup(): Promise<void>;
}

function memoryHandle(id: string, cwd: string): SessionHandle {
  const storage = new MemoryStorage();
  let adopted = false;
  return {
    id,
    dir: join(tmpdir(), 'kubic-memory-sessions', id),
    storage,
    meta: { cwd, createdAt: new Date(0).toISOString() },
    adopt: () => {
      adopted = true;
      return storage;
    },
    release: async (context: Context): Promise<void> => {
      // The harness owns the storage from `adopt()` on; a handle nobody
      // booted closes its own storage so the object cannot leak open.
      if (!adopted) await storage.close(context);
    },
  };
}

export async function bootFauxLane(
  options: FauxLaneOptions = {},
): Promise<FauxLane> {
  const {
    responses,
    models: fauxModels,
    model: modelId,
    env: envOption,
    agentId,
    context: contextOption,
    faux: sharedFaux,
    storage,
    root,
    sessionId: sessionIdOption,
    cwd,
    workspace,
    handle,
    ...bootOptions
  } = options;
  const context = contextOption ?? BACKGROUND_CONTEXT;
  const env = envOption ?? new FakeExecutionEnv({});
  const faux =
    sharedFaux ??
    fauxProvider(fauxModels === undefined ? {} : { models: [...fauxModels] });
  const models = createModels();
  models.setProvider(faux.provider);
  const model =
    modelId === undefined ? faux.getModel() : faux.getModel(modelId);
  if (model === undefined) {
    throw new Error(`faux model '${modelId}' is not registered`);
  }
  faux.setResponses([...(responses ?? [fauxAssistantMessage('ok')])]);

  let store: SessionStore | undefined;
  let session: SessionHandle;
  if (handle !== undefined) {
    session = handle;
  } else if (storage === 'jsonl') {
    if (root === undefined) {
      throw new Error(
        "storage: 'jsonl' needs an explicit `root` (worker may not import " +
          'node:fs — the test owns the sessions root)',
      );
    }
    store = openSessionStore(root, createNodeFileBridge(root));
    session = await createSession(
      store,
      {
        ...(sessionIdOption === undefined ? {} : { id: sessionIdOption }),
        cwd: cwd ?? env.cwd,
        ...(workspace === undefined ? {} : { workspace }),
      },
      context,
    );
  } else {
    session = memoryHandle(sessionIdOption ?? 'sess-1', cwd ?? env.cwd);
  }
  const sessionId = sessionIdOption ?? session.id;

  // Hand the storage to the harness before booting: `release()` then gives
  // the Kubic lock back without closing a storage the harness owns.
  session.adopt();
  const solo = await bootSoloLane({
    ...bootOptions,
    session,
    models,
    model,
    env,
    sessionId,
    agentId: agentId ?? 'root',
    context,
  });

  let cleaned = false;
  return {
    solo,
    faux,
    models,
    env,
    session,
    sessionId,
    ...(store === undefined ? {} : { store }),
    ...(root === undefined ? {} : { root }),
    run: (prompt, runOptions) => runPrompt(solo, prompt, runOptions),
    entries: () => laneEntries(solo, context),
    toolResults: () => laneToolResults(solo, context),
    systemPrompt: () => laneSystemPrompt(solo, context),
    activeTools: () => laneActiveTools(solo, context),
    registeredTool: (name) =>
      solo.registry
        .snapshot()
        .tools()
        .find(({ tool }) => tool.name === name)?.tool,
    subscribe: (sink) =>
      subscribeLaneEvents(solo.harness, solo.conversation.id, sink, context),
    cleanup: async () => {
      if (cleaned) return;
      cleaned = true;
      await solo.close(context);
      await session.release(context);
    },
  };
}

// Types a test needs to name the factory's session/journal options without
// importing exec or the session store directly.
export type { FileJournalStore, SessionHandle, SessionStore };
