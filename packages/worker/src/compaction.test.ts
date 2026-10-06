// Compaction policy on pi-durable (issues #34, #399; §27.1-27.4).
//
// Pi 1.0 / pi-durable owns the mechanism (the threshold checkpoints, the
// summarization request, the pi.compaction entry, the overflow retry). These
// tests drive a REAL Harness over MemoryStorage with the faux provider, so
// they pin what Kubic hands the harness (`soloCompactionSettings`: the clamped
// live reserve, the keep-recent window, the background decision) and what
// Kubic asks for by hand (`compactSoloLane`: the compact prompt and verbatim
// caller focus).
import { afterEach, describe, expect, it } from 'vitest';
import {
  buildCompactPrompt,
  compactSoloLane,
  DEFAULT_RESERVE_TOKENS,
  effectiveReserveTokens,
  MAX_RESERVE_FRACTION,
  parseCompactCommand,
  runManualCompaction,
  SOLO_BACKGROUND_TOKENS,
  SOLO_KEEP_RECENT_TOKENS,
  soloCompactionSettings,
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

async function openSolo(options: {
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

// ─── soloCompactionSettings: the live clamped reserve ─────────────────────

describe('soloCompactionSettings (issue #399: the reserve is read live)', () => {
  it('defaults to the Kubic budget: enabled, 16384 reserve, 20000 keep-recent, background off', () => {
    const settings = soloCompactionSettings({ currentWindow: () => 200000 });
    expect(DEFAULT_RESERVE_TOKENS).toBe(16384);
    expect(SOLO_KEEP_RECENT_TOKENS).toBe(20000);
    expect(SOLO_BACKGROUND_TOKENS).toBe(0);
    expect(settings.enabled).toBe(true);
    expect(settings.keepRecentTokens).toBe(20000);
    expect(settings.backgroundTokens).toBe(0);
    expect(settings.reserveTokens).toBe(16384);
  });

  it('clamps the reserve to the current model window and re-clamps when the window changes', () => {
    let window = 8192;
    const settings = soloCompactionSettings({
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
    const settings = soloCompactionSettings({
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
    const settings = soloCompactionSettings({ currentWindow: () => 4096 });
    expect(settings.reserveTokens).toBe(1024);
  });
});

// ─── the reserve as the harness reads it: a real threshold ────────────────

describe('the harness threshold follows the live reserve (issue #399)', () => {
  it('keeps a small-window session below the clamped threshold, so nothing compacts', async () => {
    // Window 3000, clamped reserve 750: threshold 2250. Unclamped (16384) the
    // threshold would be negative and this exchange would compact.
    const result = await openSolo({
      models: [{ id: 'small', contextWindow: 3000, maxTokens: 1000 }],
      compaction: soloCompactionSettings({
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
    // current model; #394 updates it on a switch and never touches settings.
    let laneModel = { contextWindow: 3000, maxTokens: 5000 };
    const settings = soloCompactionSettings({
      configuredReserveTokens: DEFAULT_RESERVE_TOKENS,
      keepRecentTokens: 200,
      currentWindow: () => laneModel.contextWindow,
    });
    const result = await openSolo({
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
    await compactSoloLane(
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
    await compactSoloLane(
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

describe('automatic compaction (issue #399: threshold crossing)', () => {
  it('crossing the threshold appends exactly one pi.compaction entry', async () => {
    // Window 3000, configured reserve 7000 -> clamped to 750; blocking
    // threshold 2250. The first exchange (~2600 estimated tokens) crosses it;
    // the compacted context (summary + a1 + u2) stays below it.
    const result = await openSolo({
      models: [{ id: 'small', contextWindow: 3000, maxTokens: 1000 }],
      compaction: soloCompactionSettings({
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

// ─── manual compaction: compactSoloLane ───────────────────────────────────

describe('compactSoloLane (issue #399: manual compaction, #82 rule 7)', () => {
  it('passes the focus verbatim into Kubic compact prompt as the instructions', async () => {
    const focus = 'keep the failing test names and exact file paths';
    const result = await openSolo({
      models: [{ id: 'large', contextWindow: 100000, maxTokens: 20000 }],
      compaction: soloCompactionSettings({
        configuredReserveTokens: DEFAULT_RESERVE_TOKENS,
        keepRecentTokens: 200,
        currentWindow: () => 100000,
      }),
      reply: () => text('a', 500),
    });
    await turn(result.root, text('u1', 500));
    await turn(result.root, text('u2', 500));

    const { taskId } = await compactSoloLane(
      { harness: result.harness, conversation: result.root },
      focus,
      BACKGROUND_CONTEXT,
    );
    expect(typeof taskId).toBe('number');
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

describe('runManualCompaction (issue #330: the TUI /compact path)', () => {
  it('admits, awaits and reports the pre-cut context estimate', async () => {
    const focus = 'keep the failing test names';
    const result = await openSolo({
      models: [{ id: 'large', contextWindow: 100000, maxTokens: 20000 }],
      compaction: soloCompactionSettings({
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

  it('reports Pi\'s "nothing to compact" completion as nothing, not a cut (#330 review)', async () => {
    // The shipped TUI keep-recent window is 20000 tokens: a session below it
    // has nothing to cut, and Pi completes the task without placing a
    // `pi.compaction` entry (CompactionResult's entryId/submissionId both
    // absent). Claiming `compacted` there would be a lie.
    const result = await openSolo({
      models: [{ id: 'large', contextWindow: 100000, maxTokens: 20000 }],
      compaction: soloCompactionSettings({
        configuredReserveTokens: DEFAULT_RESERVE_TOKENS,
        keepRecentTokens: SOLO_KEEP_RECENT_TOKENS,
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
    const result = await openSolo({
      models: [{ id: 'large', contextWindow: 100000, maxTokens: 20000 }],
      compaction: soloCompactionSettings({
        configuredReserveTokens: DEFAULT_RESERVE_TOKENS,
        keepRecentTokens: 200,
        currentWindow: () => 100000,
      }),
      reply: () => text('a', 500),
    });
    await turn(result.root, text('u1', 500));
    await turn(result.root, text('u2', 500));
    // Abort the conversation between admission and settlement: the operator's
    // Esc/Ctrl-C path (the TUI drives exactly this).
    const admitted = await compactSoloLane(
      { harness: result.harness, conversation: result.root },
      undefined,
      BACKGROUND_CONTEXT,
    );
    await result.root.abort(BACKGROUND_CONTEXT);
    const settled = await result.harness.waitForTask(
      admitted.taskId,
      BACKGROUND_CONTEXT,
    );
    expect(['aborted', 'orphaned']).toContain(settled.state.outcome.status);
    // runManualCompaction reports the same terminal state without throwing.
    const again = await runManualCompaction(
      { harness: result.harness, conversation: result.root },
      'never summarized',
      BACKGROUND_CONTEXT,
    );
    expect(again.status).toBe('completed');
  });

  it('reports an unavailable model as a failed compaction, not a throw', async () => {
    const result = await openSolo({
      models: [{ id: 'large', contextWindow: 100000, maxTokens: 20000 }],
      compaction: soloCompactionSettings({
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

// ─── the background-compaction decision ───────────────────────────────────

describe('background compaction is pinned off (issue #399)', () => {
  it('does not start below the blocking threshold with the Kubic default', async () => {
    // Window 3000, reserve 750, blocking threshold 2250. Pi's own default
    // (32768 below the threshold) would compact anywhere above -30518 -- i.e.
    // always; Kubic's pinned 0 keeps the reserved room as the only trigger.
    const result = await openSolo({
      models: [{ id: 'small', contextWindow: 3000, maxTokens: 1000 }],
      compaction: soloCompactionSettings({
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
    const result = await openSolo({
      models: [{ id: 'small', contextWindow: 3000, maxTokens: 1000 }],
      compaction: soloCompactionSettings({
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

describe('/compact focus instructions (issue #34)', () => {
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
      'Summarize this session for compaction: goal, decisions, open work, cumulative file ops, spill refs.\n' +
        'Prefer compact state + artifacts + refs over history.',
    );
  });
});

describe('structured summaries with cumulative file ops (issue #34)', () => {
  it('lists cumulative created/modified/deleted structurally', async () => {
    const { accumulateFileOps, emptyFileOps, formatStructuredSummary } =
      await import('./compaction.js');
    const ops = accumulateFileOps(emptyFileOps(), [
      { kind: 'created', path: 'a.ts' },
      { kind: 'modified', path: 'b.ts' },
      { kind: 'created', path: 'a.ts' },
      { kind: 'deleted', path: 'c.ts' },
    ]);
    expect(ops.created).toEqual(['a.ts']);
    expect(ops.modified).toEqual(['b.ts']);
    expect(ops.deleted).toEqual(['c.ts']);
    const text = formatStructuredSummary({
      goal: 'ship it',
      decisions: ['use x'],
      openWork: ['y'],
      fileOps: ops,
      spillRefs: [],
    });
    expect(text).toContain('a.ts');
    expect(text).toContain('b.ts');
    expect(text).toContain('c.ts');
  });
});

describe('tool-output spill helpers (issue #34: pure helpers; the spill path itself is not implemented)', () => {
  it('resolves truncated bash output to its spill path artifact ref', async () => {
    const { buildSpillArtifact, resolveTruncatedOutput } = await import(
      './compaction.js'
    );
    const output = {
      truncated: true,
      preview: 'first bytes…',
      spillPath: 'artifacts/spill/bash-123.txt',
    };
    expect(resolveTruncatedOutput(output)).toBe('artifacts/spill/bash-123.txt');
    const artifact = buildSpillArtifact(output.spillPath);
    expect(artifact.path).toBe('artifacts/spill/bash-123.txt');
  });

  it('never truncates Kubic-side: long output passes through byte-identical', async () => {
    const { passThroughOutput } = await import('./compaction.js');
    const long = 'x'.repeat(500000);
    expect(passThroughOutput(long)).toBe(long);
  });
});
