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
  buildCompactPrompt,
  type CompactionLane,
  compactionSettings,
  createManualKeepScope,
  DEFAULT_RESERVE_TOKENS,
  effectiveKeepRecentTokens,
  effectiveReserveTokens,
  KEEP_RECENT_TOKENS,
  MANUAL_KEEP_RECENT_TOKENS,
  MAX_KEEP_RECENT_FRACTION,
  parseCompactCommand,
  roomAfterCompaction,
  runCompactCommand,
  runManualCompaction,
  SYSTEM_ENTRY_ESTIMATE,
} from './compaction.js';
import {
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

// ─── the manual scope on every exit path ──────────────────────────────────

const USER_MESSAGE = {
  role: 'user',
  content: [{ type: 'text', text: 'hello there' }],
  timestamp: 0,
};

const ASSISTANT_MESSAGE = {
  role: 'assistant',
  content: [{ type: 'text', text: 'hi' }],
  usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 },
  stopReason: 'stop',
  timestamp: 0,
};

/** A lane whose admitted task settles as `outcome` (or whose admission throws). */
function fakeManualLane(
  outcome: unknown,
  admissionError?: string,
): {
  lane: CompactionLane;
  manualKeep: ReturnType<typeof createManualKeepScope>;
  activeWhilePending: boolean[];
} {
  const manualKeep = createManualKeepScope();
  const activeWhilePending: boolean[] = [];
  const messages = [USER_MESSAGE, ASSISTANT_MESSAGE, USER_MESSAGE];
  const lane = {
    manualKeep,
    harness: {
      waitForTask: async () => {
        activeWhilePending.push(manualKeep.active);
        return { state: { outcome } };
      },
    },
    conversation: {
      context: async () => ({
        head: undefined,
        entries: [],
        contributions: messages.map((message) => [message]),
        messages,
      }),
      compact: async () => {
        if (admissionError !== undefined) throw new Error(admissionError);
        return 1;
      },
    },
  };
  return {
    lane: lane as unknown as CompactionLane,
    manualKeep,
    activeWhilePending,
  };
}

// ─── the background-compaction decision ───────────────────────────────────

describe('background compaction is pinned off', () => {
  it('does not start below the blocking threshold with the Kubic default', async () => {
    // Window 3000, reserve 750, blocking threshold 2250. Pi's own default
    // (32768 below the threshold) would compact anywhere above -30518 -- i.e.
    // always; Kubic's pinned 0 keeps the reserved room as the only trigger.
    const result = await openLane({
      models: [{ id: 'small', contextWindow: 3000, maxTokens: 1000 }],
      compaction: compactionSettings({
        configuredReserveTokens: 7000,
        keepRecentTokens: 200,
        currentWindow: () => 3000,
      }),
      reply: () => text('a', 500),
    });
    await turn(result.root, text('u1', 500));
    await turn(result.root, text('u2', 20));
    await drainCompactions(result);
    expect(result.requests.summary).toHaveLength(0);
    expect(await compactionEntries(result.root)).toHaveLength(0);
  });

  it('still starts above the background threshold when a caller lowers it', async () => {
    // Same exchange, background band lowered to 2000 tokens below blocking:
    // now the ~1200-token context is inside the band, and the compaction
    // starts without blocking the turn.
    const result = await openLane({
      models: [{ id: 'small', contextWindow: 3000, maxTokens: 1000 }],
      compaction: compactionSettings({
        configuredReserveTokens: 7000,
        keepRecentTokens: 200,
        backgroundTokens: 2000,
        currentWindow: () => 3000,
      }),
      reply: () => text('a', 500),
    });
    await turn(result.root, text('u1', 500));
    await turn(result.root, text('u2', 20));
    await drainCompactions(result);
    expect(result.requests.summary).toHaveLength(1);
    expect(result.requests.agent).toHaveLength(2);
    const entries = await compactionEntries(result.root);
    expect(entries).toHaveLength(1);
    expect(entryReason(entries[0] ?? {})).toBe('threshold');
  });
});

// ─── the retained policy helpers ──────────────────────────────────────────

describe('reserve clamp (a reserve never eats more than a quarter of the window)', () => {
  it('clamps the reserve to floor(window / 4) and leaves large windows alone', () => {
    expect(effectiveReserveTokens(8192)).toBe(2048);
    expect(effectiveReserveTokens(200000)).toBe(16384);
    expect(effectiveReserveTokens(8192, 1000)).toBe(1000);
    // Unknown window (0): nothing to clamp against.
    expect(effectiveReserveTokens(0)).toBe(16384);
  });
});

describe('roomAfterCompaction (the room a compaction leaves)', () => {
  it('estimates the room with the default reserve, kept window and system entry', () => {
    expect(SYSTEM_ENTRY_ESTIMATE).toBe(2822);
    // 8192 - 2048 reserve - 2822 system entry - 1536 kept - 800 summary.
    expect(roomAfterCompaction(8192)).toBe(986);
    // 12288 - 3072 reserve - 2822 system entry - 2304 kept - 800 summary.
    expect(roomAfterCompaction(12288)).toBe(3290);
    // 16384 - 4096 reserve - 2822 system entry - 3072 kept - 800 summary.
    expect(roomAfterCompaction(16384)).toBe(5594);
  });

  it('uses the configured reserve and kept window', () => {
    expect(roomAfterCompaction(8192, 1000, 500)).toBe(
      8192 - 1000 - SYSTEM_ENTRY_ESTIMATE - 500 - 800,
    );
  });
});

describe('/compact focus instructions', () => {
  it('carries caller focus instructions verbatim into the compact prompt', () => {
    const focus = parseCompactCommand('/compact focus on the auth flow');
    const prompt = buildCompactPrompt({ focus });
    expect(prompt).toContain('focus on the auth flow');
    expect(prompt).toContain('focus: focus on the auth flow');
  });

  it('builds the exact prompt skeleton with no focus instructions', () => {
    expect(parseCompactCommand('/compact')).toBe('');
    // Exact sections, exact order, no focus line: a dropped or reordered
    // section fails here instead of reaching the summarizer silently.
    expect(buildCompactPrompt({})).toBe(
      'Summarize this session for compaction: goal, decisions, open work, next steps.',
    );
  });

  it('asks the summarizer only for sections Kubic has: no file ops, no spill refs', () => {
    const prompt = buildCompactPrompt({});
    expect(prompt).not.toMatch(/file ops|spill/i);
    expect(prompt).toMatch(/goal/);
    expect(prompt).toMatch(/decisions/);
    expect(prompt).toMatch(/open work/);
    expect(prompt).toMatch(/next steps/);
  });
});

// ─── the kept window scales with the model window ─────────────────────────

describe('effectiveKeepRecentTokens (the kept window scales with the window)', () => {
  it('keeps the configured window when the model window is unknown', () => {
    expect(effectiveKeepRecentTokens(0)).toBe(KEEP_RECENT_TOKENS);
  });

  it('keeps a share of the room below the reserve on small and mid-size windows', () => {
    // Room below the clamped reserve: 8192 - 2048, 16384 - 4096, 32768 - 8192.
    expect(MAX_KEEP_RECENT_FRACTION).toBe(0.25);
    expect(effectiveKeepRecentTokens(8192)).toBe(1536);
    expect(effectiveKeepRecentTokens(16384)).toBe(3072);
    expect(effectiveKeepRecentTokens(32768)).toBe(6144);
  });

  it('keeps the configured 20000 on large windows, and never more than configured', () => {
    expect(effectiveKeepRecentTokens(131072)).toBe(20000);
    expect(effectiveKeepRecentTokens(200000)).toBe(20000);
    expect(effectiveKeepRecentTokens(200000, 1000)).toBe(1000);
  });

  it('measures the room with the reserve it is given', () => {
    // A 1000-token reserve leaves 8192 - 1000 = 7192 below an 8k window.
    expect(effectiveKeepRecentTokens(8192, KEEP_RECENT_TOKENS, 1000)).toBe(
      1798,
    );
  });
});

describe('compactionSettings (the kept window is read live)', () => {
  it('follows the current model window, like the reserve', () => {
    let window = 8192;
    const settings = compactionSettings({ currentWindow: () => window });
    expect(settings.keepRecentTokens).toBe(1536);
    window = 200000;
    expect(settings.keepRecentTokens).toBe(20000);
    window = 0;
    expect(settings.keepRecentTokens).toBe(KEEP_RECENT_TOKENS);
  });
});

describe('manual compaction keeps less while it is pending', () => {
  it('keeps at most MANUAL_KEEP_RECENT_TOKENS while the scope is open, and resets on release', () => {
    expect(MANUAL_KEEP_RECENT_TOKENS).toBe(2000);
    const manualKeep = createManualKeepScope();
    const settings = compactionSettings({
      currentWindow: () => 200000,
      manualKeep,
    });
    expect(settings.keepRecentTokens).toBe(20000);
    const release = manualKeep.open();
    expect(manualKeep.active).toBe(true);
    expect(settings.keepRecentTokens).toBe(2000);
    release();
    release();
    expect(manualKeep.active).toBe(false);
    expect(settings.keepRecentTokens).toBe(20000);
  });

  it('keeps the smaller effective window on a tiny model', () => {
    const manualKeep = createManualKeepScope();
    const settings = compactionSettings({
      currentWindow: () => 8192,
      manualKeep,
    });
    const release = manualKeep.open();
    expect(settings.keepRecentTokens).toBe(1536);
    release();
  });

  it('counts overlapping scopes, so one release never ends another', () => {
    const manualKeep = createManualKeepScope();
    const first = manualKeep.open();
    const second = manualKeep.open();
    first();
    expect(manualKeep.active).toBe(true);
    second();
    expect(manualKeep.active).toBe(false);
  });
});

// ─── manual compaction on a real harness, with the reason it did not cut ──

describe('runManualCompaction on a short session', () => {
  it('places a summary on about 5k tokens of history with the default keep window', async () => {
    const manualKeep = createManualKeepScope();
    const result = await openLane({
      models: [{ id: 'large', contextWindow: 200000, maxTokens: 20000 }],
      compaction: compactionSettings({
        configuredReserveTokens: DEFAULT_RESERVE_TOKENS,
        currentWindow: () => 200000,
        manualKeep,
      }),
      reply: () => text('a', 500),
    });
    for (let index = 0; index < 4; index++) {
      await turn(result.root, text(`u${index}`, 1000));
    }
    const outcome = await runCompactCommand(
      { harness: result.harness, conversation: result.root, manualKeep },
      undefined,
      BACKGROUND_CONTEXT,
    );
    expect(outcome.status).toBe('completed');
    expect(outcome.tokensBefore).toBeGreaterThan(4000);
    expect(await compactionEntries(result.root)).toHaveLength(1);
  });

  it('reports a session that is only its most recent turn as nothing, with the reason', async () => {
    const result = await openLane({
      models: [{ id: 'large', contextWindow: 200000, maxTokens: 20000 }],
      compaction: compactionSettings({
        configuredReserveTokens: DEFAULT_RESERVE_TOKENS,
        currentWindow: () => 200000,
      }),
      reply: () => text('a', 500),
    });
    await turn(result.root, text('u1', 500));
    const outcome = await runManualCompaction(
      { harness: result.harness, conversation: result.root },
      undefined,
      BACKGROUND_CONTEXT,
    );
    expect(outcome.status).toBe('nothing');
    expect(outcome.reason).toBe('most-recent-turn');
    expect(result.requests.summary).toHaveLength(0);
    expect(await compactionEntries(result.root)).toHaveLength(0);
  });
});

describe('the /compact command holds the manual scope only while the task is pending', () => {
  it.each<[string, unknown, string | undefined]>([
    [
      'completed',
      { status: 'completed', result: { entryId: 'entry-1' } },
      undefined,
    ],
    ['nothing', { status: 'completed', result: {} }, 'no-cut'],
    [
      'failed',
      { status: 'failed', error: { message: 'model gone' } },
      undefined,
    ],
    ['aborted', { status: 'aborted', reason: 'operator' }, undefined],
    [
      'orphaned',
      { status: 'orphaned', reason: 'abort could not run' },
      undefined,
    ],
    [
      'faulted',
      { status: 'faulted', error: { message: 'contract' } },
      undefined,
    ],
  ])(
    'releases the scope when the task ends %s',
    async (status, outcome, reason) => {
      const { lane, manualKeep, activeWhilePending } = fakeManualLane(outcome);
      const result = await runCompactCommand(
        lane,
        undefined,
        BACKGROUND_CONTEXT,
      );
      expect(result.status).toBe(status);
      expect(result.reason).toBe(reason);
      expect(activeWhilePending).toEqual([true]);
      expect(manualKeep.active).toBe(false);
    },
  );

  it('releases the scope when the admission is refused', async () => {
    const { lane, manualKeep, activeWhilePending } = fakeManualLane(
      undefined,
      'compaction refused',
    );
    const result = await runCompactCommand(lane, undefined, BACKGROUND_CONTEXT);
    expect(result.status).toBe('failed');
    expect(activeWhilePending).toEqual([]);
    expect(manualKeep.active).toBe(false);
  });
});

describe('overflow recovery (runManualCompaction) keeps the effective window', () => {
  it('does not open the manual scope while the task is pending', async () => {
    const { lane, manualKeep, activeWhilePending } = fakeManualLane({
      status: 'completed',
      result: { entryId: 'entry-1' },
    });
    const result = await runManualCompaction(
      lane,
      undefined,
      BACKGROUND_CONTEXT,
    );
    expect(result.status).toBe('completed');
    expect(activeWhilePending).toEqual([false]);
    expect(manualKeep.active).toBe(false);
  });
});
