// Compaction policy on pi-durable.
//
// Pi 1.0 / pi-durable owns the mechanism (the threshold checkpoints, the
// summarization request, the pi.compaction entry, the overflow retry). These
// tests drive a REAL Harness over MemoryStorage with the faux provider, so
// they pin what Kubic hands the harness (`compactionSettings`: the clamped
// live reserve, the keep-recent window, the background decision) and what
// Kubic asks for by hand (`runManualCompaction`: the compact prompt and verbatim
// caller focus).
import { afterEach, describe, expect, it } from 'vitest';
import {
  BACKGROUND_TOKENS,
  buildCompactPrompt,
  compactionSettings,
  DEFAULT_RESERVE_TOKENS,
  effectiveReserveTokens,
  KEEP_RECENT_TOKENS,
  MAX_RESERVE_FRACTION,
  measureContext,
  runManualCompaction,
} from './compaction.js';
import {
  AssistantEntry,
  BACKGROUND_CONTEXT,
  CompactionEntry,
  createModels,
  createRegistry,
  fauxAssistantMessage,
  fauxProvider,
  Harness,
  type HarnessSettings,
  LiveDoc,
  MemoryStorage,
} from './pi-boundary.js';

// ─── faux harness scaffolding ─────────────────────────────────────────────

/** Text of about `tokens` estimated tokens, starting with `label`. */
function text(label: string, tokens: number): string {
  return `${label} ${'x'.repeat(Math.max(1, tokens * 4 - label.length - 1))}`;
}

const SUMMARY = '## Goal\nkeep the work going.';

type CapturedRequest = {
  readonly messages: readonly {
    readonly role?: unknown;
    readonly content?: unknown;
  }[];
  readonly maxTokens: number | undefined;
  readonly summary: boolean;
};

/** Text blocks of one pi-ai message, without importing pi-ai outside the seam. */
function messageText(
  message: { readonly content?: unknown } | undefined,
): string {
  if (message === undefined) return '';
  const content = message.content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((block) =>
      typeof block === 'object' &&
      block !== null &&
      typeof (block as { text?: unknown }).text === 'string'
        ? (block as { text: string }).text
        : '',
    )
    .join('');
}

/** The summarizer's user message (the serialized conversation + prompt). */
function promptText(request: CapturedRequest): string {
  return messageText(request.messages[request.messages.length - 1]);
}

function isSummaryRequest(messages: CapturedRequest['messages']): boolean {
  const first = messages[0];
  return (
    first?.role === 'system' &&
    typeof first.content === 'string' &&
    first.content.includes('summarization')
  );
}

type Faux = ReturnType<typeof fauxProvider>;

type Requests = { agent: CapturedRequest[]; summary: CapturedRequest[] };

/** Script `faux` with one factory that records agent and summary requests apart. */
function installScript(
  faux: Faux,
  reply: (request: CapturedRequest) => string,
): Requests {
  const requests: Requests = { agent: [], summary: [] };
  const steps: Parameters<Faux['setResponses']>[0] = [];
  for (let index = 0; index < 200; index++) {
    steps.push((transcript, options) => {
      const summary = isSummaryRequest(transcript.messages);
      const request: CapturedRequest = {
        messages: transcript.messages,
        maxTokens: options?.maxTokens,
        summary,
      };
      (summary ? requests.summary : requests.agent).push(request);
      return fauxAssistantMessage(summary ? SUMMARY : reply(request));
    });
  }
  faux.setResponses(steps);
  return requests;
}

type ModelSpec = {
  readonly id: string;
  readonly contextWindow: number;
  readonly maxTokens: number;
};

type OpenResult = {
  readonly harness: Harness;
  readonly root: Awaited<ReturnType<Harness['root']>>;
  readonly requests: Requests;
};

const openHarnesses = new Set<Harness>();

afterEach(async () => {
  for (const harness of openHarnesses) await harness.close(BACKGROUND_CONTEXT);
  openHarnesses.clear();
});

async function openLane(options: {
  readonly models: readonly ModelSpec[];
  readonly compaction: HarnessSettings['compaction'];
  readonly reply?: (request: CapturedRequest) => string;
}): Promise<OpenResult> {
  const faux = fauxProvider({ models: [...options.models] });
  const models = createModels();
  models.setProvider(faux.provider);
  const requests = installScript(faux, options.reply ?? (() => 'ok'));
  const settings: HarnessSettings = { compaction: options.compaction };
  const harness = await Harness.open(
    new MemoryStorage(),
    { models, registry: createRegistry(), settings },
    BACKGROUND_CONTEXT,
  );
  openHarnesses.add(harness);
  harness.resume();
  const root = await harness.root(BACKGROUND_CONTEXT, {
    agent: {
      model: { provider: 'faux', modelId: options.models[0]?.id ?? 'small' },
    },
  });
  return { harness, root, requests };
}

async function turn(root: OpenResult['root'], input: string): Promise<void> {
  const submission = await root.submit(
    { type: 'input', content: input },
    BACKGROUND_CONTEXT,
  );
  expect((await submission.wait(BACKGROUND_CONTEXT)).status).toBe('done');
}

/** Drain compactions the turn started in the background. */
async function drainCompactions(result: OpenResult): Promise<void> {
  const live = await result.harness.snapshot(
    LiveDoc,
    result.root.id,
    BACKGROUND_CONTEXT,
  );
  for (const status of live?.compactions ?? []) {
    await result.harness.waitForTask(status.taskId, BACKGROUND_CONTEXT);
  }
}

async function compactionEntries(
  root: OpenResult['root'],
): Promise<Awaited<ReturnType<OpenResult['root']['entries']>>['items']> {
  const page = await root.entries({}, 100, undefined, BACKGROUND_CONTEXT);
  return page.items.filter((entry) => CompactionEntry.is(entry));
}

function entryReason(entry: { readonly data?: unknown }): unknown {
  return (entry.data as { reason?: unknown } | undefined)?.reason;
}

// ─── compactionSettings: the live clamped reserve ─────────────────────

describe('compactionSettings (the reserve is read live)', () => {
  it('defaults to the Kubic budget: enabled, 16384 reserve, 20000 keep-recent, background off', () => {
    const settings = compactionSettings({ currentWindow: () => 200000 });
    expect(DEFAULT_RESERVE_TOKENS).toBe(16384);
    expect(KEEP_RECENT_TOKENS).toBe(20000);
    expect(BACKGROUND_TOKENS).toBe(0);
    expect(settings.enabled).toBe(true);
    expect(settings.keepRecentTokens).toBe(20000);
    expect(settings.backgroundTokens).toBe(0);
    expect(settings.reserveTokens).toBe(16384);
  });

  it('clamps the reserve to the current model window and re-clamps when the window changes', () => {
    let window = 8192;
    const settings = compactionSettings({
      currentWindow: () => window,
    });
    // 8192 * 0.25 = 2048, below the configured default: clamped.
    expect(settings.reserveTokens).toBe(2048);
    expect(settings.reserveTokens).toBe(
      effectiveReserveTokens(8192, DEFAULT_RESERVE_TOKENS),
    );
    // The getter is live: the SAME settings object follows the new window.
    window = 200000;
    expect(settings.reserveTokens).toBe(DEFAULT_RESERVE_TOKENS);
    // Unknown window: the configured reserve stands (nothing to clamp against).
    window = 0;
    expect(settings.reserveTokens).toBe(DEFAULT_RESERVE_TOKENS);
  });

  it('honours explicit overrides (configured reserve, keep-recent, background)', () => {
    const settings = compactionSettings({
      enabled: false,
      configuredReserveTokens: 1000,
      keepRecentTokens: 123,
      backgroundTokens: 4096,
      currentWindow: () => 8192,
    });
    expect(settings).toMatchObject({
      enabled: false,
      keepRecentTokens: 123,
      backgroundTokens: 4096,
    });
    expect(settings.reserveTokens).toBe(1000);
  });

  it('caps the reserve at a quarter of a small window', () => {
    expect(MAX_RESERVE_FRACTION).toBe(0.25);
    const settings = compactionSettings({ currentWindow: () => 4096 });
    expect(settings.reserveTokens).toBe(1024);
  });
});

// ─── the reserve as the harness reads it: a real threshold ────────────────

describe('the harness threshold follows the live reserve', () => {
  it('keeps a small-window session below the clamped threshold, so nothing compacts', async () => {
    // Window 3000, clamped reserve 750: threshold 2250. Unclamped (16384) the
    // threshold would be negative and this exchange would compact.
    const result = await openLane({
      models: [{ id: 'small', contextWindow: 3000, maxTokens: 1000 }],
      compaction: compactionSettings({
        configuredReserveTokens: DEFAULT_RESERVE_TOKENS,
        keepRecentTokens: 200,
        currentWindow: () => 3000,
      }),
      reply: () => text('a', 500),
    });
    await turn(result.root, text('u1', 500));
    await turn(result.root, text('u2', 500));
    await drainCompactions(result);
    expect(result.requests.summary).toHaveLength(0);
    expect(await compactionEntries(result.root)).toHaveLength(0);
  });

  it('uses the new clamp after configure({ model }) with no manual re-clamp', async () => {
    // The settings object is built ONCE. `laneModel` mirrors the lane's
    // current model; updates it on a switch and never touches settings.
    let laneModel = { contextWindow: 3000, maxTokens: 5000 };
    const settings = compactionSettings({
      configuredReserveTokens: DEFAULT_RESERVE_TOKENS,
      keepRecentTokens: 200,
      currentWindow: () => laneModel.contextWindow,
    });
    const result = await openLane({
      models: [
        { id: 'small', contextWindow: 3000, maxTokens: 5000 },
        { id: 'large', contextWindow: 100000, maxTokens: 5000 },
      ],
      compaction: settings,
      reply: () => text('a', 500),
    });
    await turn(result.root, text('u1', 500));
    await turn(result.root, text('u2', 500));
    expect(settings.reserveTokens).toBe(750);

    // The summary request's maxTokens is derived from the reserve the agent
    // model resolves at that use: 0.8 * 750 = 600 on the small window.
    await runManualCompaction(
      { harness: result.harness, conversation: result.root },
      undefined,
      BACKGROUND_CONTEXT,
    );
    await result.harness.waitForIdle(BACKGROUND_CONTEXT);
    expect(result.requests.summary).toHaveLength(1);
    expect(result.requests.summary[0]?.maxTokens).toBe(600);

    // One more exchange, so the second manual compaction has a prefix to cut.
    await turn(result.root, text('u3', 500));

    await result.root.configure(
      { model: { provider: 'faux', modelId: 'large' } },
      BACKGROUND_CONTEXT,
    );
    laneModel = { contextWindow: 100000, maxTokens: 5000 };
    expect(settings.reserveTokens).toBe(DEFAULT_RESERVE_TOKENS);

    // Same settings object, new window: 0.8 * 16384 = 13107, capped by the
    // model's own 5000. A stale clamp would still send 600.
    await runManualCompaction(
      { harness: result.harness, conversation: result.root },
      undefined,
      BACKGROUND_CONTEXT,
    );
    await result.harness.waitForIdle(BACKGROUND_CONTEXT);
    expect(result.requests.summary).toHaveLength(2);
    expect(result.requests.summary[1]?.maxTokens).toBe(5000);
  });
});

// ─── automatic (threshold) compaction ─────────────────────────────────────

describe('automatic compaction (threshold crossing)', () => {
  it('crossing the threshold appends exactly one pi.compaction entry', async () => {
    // Window 3000, configured reserve 7000 -> clamped to 750; blocking
    // threshold 2250. The first exchange (~2600 estimated tokens) crosses it;
    // the compacted context (summary + a1 + u2) stays below it.
    const result = await openLane({
      models: [{ id: 'small', contextWindow: 3000, maxTokens: 1000 }],
      compaction: compactionSettings({
        configuredReserveTokens: 7000,
        keepRecentTokens: 200,
        currentWindow: () => 3000,
      }),
      reply: () => text('a', 1200),
    });
    await turn(result.root, text('u1', 1200));
    await turn(result.root, text('u2', 20));
    await drainCompactions(result);

    expect(result.requests.summary).toHaveLength(1);
    expect(result.requests.agent).toHaveLength(2);
    const entries = await compactionEntries(result.root);
    expect(entries).toHaveLength(1);
    expect(entryReason(entries[0] ?? {})).toBe('threshold');

    // The summary heads the kept entry: it is the first thing the model sees,
    // and the summarizer read the old prefix, not the kept turn.
    const view = await result.root.context(BACKGROUND_CONTEXT);
    expect(CompactionEntry.is(view.head)).toBe(true);
    expect(messageText(view.messages[0])).toContain(SUMMARY);
    expect(promptText(result.requests.summary[0] ?? {})).toContain('u1 ');
    expect(promptText(result.requests.summary[0] ?? {})).not.toContain('u2 ');
  });
});

// ─── manual compaction: runManualCompaction ───────────────────────────────────

describe('runManualCompaction (manual compaction)', () => {
  it('passes the focus verbatim into Kubic compact prompt as the instructions', async () => {
    const focus = 'keep the failing test names and exact file paths';
    const result = await openLane({
      models: [{ id: 'large', contextWindow: 100000, maxTokens: 20000 }],
      compaction: compactionSettings({
        configuredReserveTokens: DEFAULT_RESERVE_TOKENS,
        keepRecentTokens: 200,
        currentWindow: () => 100000,
      }),
      reply: () => text('a', 500),
    });
    await turn(result.root, text('u1', 500));
    await turn(result.root, text('u2', 500));

    await runManualCompaction(
      { harness: result.harness, conversation: result.root },
      focus,
      BACKGROUND_CONTEXT,
    );
    await result.harness.waitForIdle(BACKGROUND_CONTEXT);

    expect(result.requests.summary).toHaveLength(1);
    const prompt = promptText(result.requests.summary[0] ?? {});
    // Pi appends the instructions after its own summarization prompt; Kubic's
    // built prompt (focus included verbatim) is exactly what rides there.
    expect(
      prompt.endsWith(`Additional focus: ${buildCompactPrompt({ focus })}`),
    ).toBe(true);
    expect(prompt).toContain(focus);
    const entries = await compactionEntries(result.root);
    expect(entries).toHaveLength(1);
    expect(entryReason(entries[0] ?? {})).toBe('manual');
    const view = await result.root.context(BACKGROUND_CONTEXT);
    expect(messageText(view.messages[0])).toContain(SUMMARY);
  });
});

describe('runManualCompaction (the TUI /compact path)', () => {
  it('admits, awaits and reports the pre-cut context estimate', async () => {
    const focus = 'keep the failing test names';
    const result = await openLane({
      models: [{ id: 'large', contextWindow: 100000, maxTokens: 20000 }],
      compaction: compactionSettings({
        configuredReserveTokens: DEFAULT_RESERVE_TOKENS,
        keepRecentTokens: 200,
        currentWindow: () => 100000,
      }),
      reply: () => text('a', 500),
    });
    await turn(result.root, text('u1', 500));
    await turn(result.root, text('u2', 500));

    const outcome = await runManualCompaction(
      { harness: result.harness, conversation: result.root },
      focus,
      BACKGROUND_CONTEXT,
    );
    expect(outcome.status).toBe('completed');
    expect(outcome.error).toBeUndefined();
    // The estimate is a real pre-cut number: the two 500-token turns.
    expect(outcome.tokensBefore).toBeGreaterThan(200);
    // The custom instructions reached the summarization request.
    expect(result.requests.summary).toHaveLength(1);
    const prompt = promptText(result.requests.summary[0] ?? {});
    expect(prompt).toContain(
      `Additional focus: ${buildCompactPrompt({ focus })}`,
    );
    expect(prompt).toContain(focus);
    const entries = await compactionEntries(result.root);
    expect(entries).toHaveLength(1);
    expect(entryReason(entries[0] ?? {})).toBe('manual');
  });

  it('reports Pi\'s "nothing to compact" completion as nothing, not a cut', async () => {
    // The shipped TUI keep-recent window is 20000 tokens: a session below it
    // has nothing to cut, and Pi completes the task without placing a
    // `pi.compaction` entry (CompactionResult's entryId/submissionId both
    // absent). Claiming `compacted` there would be a lie.
    const result = await openLane({
      models: [{ id: 'large', contextWindow: 100000, maxTokens: 20000 }],
      compaction: compactionSettings({
        configuredReserveTokens: DEFAULT_RESERVE_TOKENS,
        keepRecentTokens: KEEP_RECENT_TOKENS,
        currentWindow: () => 100000,
      }),
      reply: () => text('a', 500),
    });
    await turn(result.root, text('u1', 200));
    const outcome = await runManualCompaction(
      { harness: result.harness, conversation: result.root },
      'focus',
      BACKGROUND_CONTEXT,
    );
    expect(outcome.status).toBe('nothing');
    expect(outcome.tokensBefore).toBeGreaterThan(0);
    expect(outcome.error).toBeUndefined();
    expect(await compactionEntries(result.root)).toHaveLength(0);
  });

  it('reports a cancelled compaction as aborted, never as a silent no-op', async () => {
    const result = await openLane({
      models: [{ id: 'large', contextWindow: 100000, maxTokens: 20000 }],
      compaction: compactionSettings({
        configuredReserveTokens: DEFAULT_RESERVE_TOKENS,
        keepRecentTokens: 200,
        currentWindow: () => 100000,
      }),
      reply: () => text('a', 500),
    });
    await turn(result.root, text('u1', 500));
    await turn(result.root, text('u2', 500));
    // Abort the conversation the moment the task is admitted: the operator's
    // Esc/Ctrl-C path (the TUI drives exactly this).
    const cancelled = await runManualCompaction(
      { harness: result.harness, conversation: result.root },
      undefined,
      BACKGROUND_CONTEXT,
      { onAdmitted: () => result.root.abort(BACKGROUND_CONTEXT) },
    );
    expect(cancelled.status).toBe('aborted');
    // runManualCompaction reports the same terminal state without throwing.
    const again = await runManualCompaction(
      { harness: result.harness, conversation: result.root },
      'never summarized',
      BACKGROUND_CONTEXT,
    );
    expect(again.status).toBe('completed');
  });

  it('reports an unavailable model as a failed compaction, not a throw', async () => {
    const result = await openLane({
      models: [{ id: 'large', contextWindow: 100000, maxTokens: 20000 }],
      compaction: compactionSettings({
        configuredReserveTokens: DEFAULT_RESERVE_TOKENS,
        keepRecentTokens: 200,
        currentWindow: () => 100000,
      }),
      reply: () => text('a', 500),
    });
    await turn(result.root, text('u1', 500));
    await turn(result.root, text('u2', 500));
    // Point the conversation at a model that is not registered: Pi's own
    // compaction refuses with `no_model`, and Kubic reports that message.
    await result.root.configure(
      { model: { provider: 'faux', modelId: 'ghost' } },
      BACKGROUND_CONTEXT,
    );
    const outcome = await runManualCompaction(
      { harness: result.harness, conversation: result.root },
      undefined,
      BACKGROUND_CONTEXT,
    );
    expect(outcome.status).toBe('failed');
    expect(outcome.error).toMatch(/ghost|not available/i);
    expect(await compactionEntries(result.root)).toHaveLength(0);
  });
});

// ─── measureContext: the context gauge reading ───────────────────────────

/** Usage of the newest committed response. */
async function lastResponseUsage(root: OpenResult['root']): Promise<{
  readonly input: number;
  readonly output: number;
  readonly cacheRead: number;
  readonly cacheWrite: number;
}> {
  const page = await root.entries({}, 100, undefined, BACKGROUND_CONTEXT);
  const response = page.items
    .filter((entry) => AssistantEntry.is(entry))
    .at(-1);
  const message = response?.model?.[0];
  if (message?.role !== 'assistant') throw new Error('no committed response');
  return message.usage;
}

describe('measureContext (the context gauge reading)', () => {
  it('counts the newest response whole, then estimates what was committed after it', async () => {
    const result = await openLane({
      models: [{ id: 'large', contextWindow: 100000, maxTokens: 20000 }],
      compaction: compactionSettings({ currentWindow: () => 100000 }),
      reply: () => text('a', 300),
    });
    await turn(result.root, text('u1', 200));
    const lane = { harness: result.harness, conversation: result.root };

    const usage = await lastResponseUsage(result.root);
    const answered = await measureContext(lane, BACKGROUND_CONTEXT);
    // The reply rides along in the next request, so its output counts.
    expect(usage.output).toBe(300);
    expect(answered).toBe(
      usage.input + usage.output + usage.cacheRead + usage.cacheWrite,
    );

    // A message committed after the response (a tool result, the next
    // prompt) is in no usage yet, so it is estimated.
    const write = await result.root.submit(
      {
        type: 'write',
        entry: {
          kind: 'test.note',
          model: [
            { role: 'user', content: text('note', 400), timestamp: Date.now() },
          ],
        },
      },
      BACKGROUND_CONTEXT,
    );
    await write.wait(BACKGROUND_CONTEXT);
    expect(await measureContext(lane, BACKGROUND_CONTEXT)).toBe(answered + 400);
  });
});
