// Approval interception through pi-durable ToolTask hooks (issues #16, #96,
// #232, #397). The approvals here are driven end to end: a REAL Harness over
// Storage with the faux provider, the production `createApprovalAsk` adapter,
// and `policyInterceptorHooks` as the lane's policy extension.
//
// The durable contract under test: `beforeTool` runs BEFORE the harness
// commits the tool's intent, so a crash while a seat is deciding re-runs the
// ask on resume — a resumed process never inherits a stand-down it did not
// grant, and the tool never runs unapproved.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { validateClasses } from '../../agents/src/policy.js';
import { policyInterceptorHooks } from '../../worker/src/lane/interceptors.js';
import {
  BACKGROUND_CONTEXT,
  type Conversation,
  createModels,
  createRegistry,
  defineExtension,
  defineTool,
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
  Harness,
  MemoryStorage,
  openNodeJsonlStorage,
  type Storage,
  Type,
} from '../../worker/src/pi-boundary.js';
import {
  type ApprovalRequest,
  ApprovalService,
  type ApprovalVerdict,
  approvalKey,
  createApprovalAsk,
  FileApprovalStore,
  triggerContextFor,
  validatePolicy,
} from './approvals.js';
import { TIMEOUT_REASON_MARKER } from './orchestrator/approvals/timeout-reason.js';

const COMMAND = 'rm -rf /tmp/x';

const made: string[] = [];

function mkTmp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  made.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of made.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

interface World {
  calls: Array<Record<string, unknown>>;
}

interface Booted {
  harness: Harness;
  storage: Storage;
  root: Conversation;
  service: ApprovalService;
  world: World;
}

// One process boot: a fresh approvals store/service (like a resumed command),
// the real approval adapter, and the lane's policy hooks over the harness.
async function bootHarness(options: {
  workspace: string;
  storage?: Storage;
  answer: (request: ApprovalRequest) => Promise<ApprovalVerdict | undefined>;
  maxPendingMs?: number;
  // false scripts only the post-tools answer (a resumed run).
  scriptToolCall?: boolean;
}): Promise<Booted> {
  const world: World = { calls: [] };
  const store = new FileApprovalStore(options.workspace);
  const service = new ApprovalService({
    policy: validatePolicy({
      maxPendingMs: options.maxPendingMs ?? 60_000,
    }),
    store,
    awaitAnswer: options.answer,
  });
  const ask = createApprovalAsk(
    service,
    triggerContextFor(validateClasses({}), options.workspace),
    store,
  );
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  faux.setResponses(
    options.scriptToolCall === false
      ? [fauxAssistantMessage('done')]
      : [
          fauxAssistantMessage(fauxToolCall('bash', { command: COMMAND }), {
            stopReason: 'toolUse',
          }),
          fauxAssistantMessage('done'),
        ],
  );
  const registry = createRegistry();
  registry.install(
    defineExtension({
      name: 'kubic.policy',
      hooks: policyInterceptorHooks({
        workspace: options.workspace,
        approve: ask,
      }),
    }),
  );
  registry.install(
    defineExtension({
      name: 'kubic',
      tools: [
        defineTool({
          name: 'bash',
          description: 'run a shell command',
          parameters: Type.Object({ command: Type.String() }),
          execute: async (args) => {
            world.calls.push(args);
            return { content: [{ type: 'text', text: 'ran' }] };
          },
        }),
      ],
    }),
  );
  const storage = options.storage ?? new MemoryStorage();
  const harness = await Harness.open(
    storage,
    { models, registry },
    BACKGROUND_CONTEXT,
  );
  const model = faux.getModel();
  const root = await harness.root(BACKGROUND_CONTEXT, {
    agent: { model: { provider: model.provider, modelId: model.id } },
  });
  return { harness, storage, root, service, world };
}

async function drive(root: Conversation): Promise<void> {
  const submission = await root.submit(
    { type: 'input', content: 'clean up' },
    BACKGROUND_CONTEXT,
  );
  expect((await submission.wait(BACKGROUND_CONTEXT)).status).toBe('done');
}

async function toolResultText(root: Conversation): Promise<string> {
  const view = await root.context(BACKGROUND_CONTEXT);
  return view.messages
    .filter((message) => message.role === 'toolResult')
    .map((message) =>
      JSON.stringify(
        (message as unknown as { content?: unknown }).content ?? '',
      ),
    )
    .join('\n');
}

async function waitUntil(predicate: () => boolean, ms = 2_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!predicate()) {
    if (Date.now() > deadline) {
      throw new Error('condition was not reached in time');
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe('approval hooks on a real harness (issues #96, #397)', () => {
  it('lets an allow-once seat answer the challenged call through', async () => {
    const workspace = mkTmp('kubic-approval-allow-');
    let asks = 0;
    const booted = await bootHarness({
      workspace,
      answer: async () => {
        asks += 1;
        return { approved: true, by: 'allow-once' };
      },
    });
    try {
      await drive(booted.root);
      expect(asks).toBe(1);
      expect(booted.world.calls).toEqual([{ command: COMMAND }]);
      expect(await toolResultText(booted.root)).not.toContain('not approved');
    } finally {
      await booted.harness.close(BACKGROUND_CONTEXT);
    }
  });

  it('blocks the call when the seat denies it', async () => {
    const workspace = mkTmp('kubic-approval-deny-');
    let asks = 0;
    const booted = await bootHarness({
      workspace,
      answer: async () => {
        asks += 1;
        return { approved: false, reason: 'denied by the user' };
      },
    });
    try {
      await drive(booted.root);
      expect(asks).toBe(1);
      expect(booted.world.calls).toEqual([]);
      expect(await toolResultText(booted.root)).toContain(
        'not approved: denied by the user',
      );
    } finally {
      await booted.harness.close(BACKGROUND_CONTEXT);
    }
  });

  it('a seat that never answers times out to deny and stops tracking the ask (#232)', async () => {
    const workspace = mkTmp('kubic-approval-timeout-');
    let asks = 0;
    const booted = await bootHarness({
      workspace,
      maxPendingMs: 20,
      answer: () => {
        asks += 1;
        return new Promise<ApprovalVerdict | undefined>(() => {
          // The seat never answers: the service's own bound must end the wait.
        });
      },
    });
    try {
      await drive(booted.root);
      expect(asks).toBe(1);
      expect(booted.world.calls).toEqual([]);
      const text = await toolResultText(booted.root);
      expect(text).toContain('not approved');
      expect(text).toContain(TIMEOUT_REASON_MARKER);
      // The wait ended: the ask is no longer pending, so the service is not
      // still awaiting any seat promise.
      expect(booted.service.pendingRequests()).toEqual([]);
    } finally {
      await booted.harness.close(BACKGROUND_CONTEXT);
    }
  });
});

describe('approval resume after a crash (issues #232, #397)', () => {
  it('re-asks on resume and never runs the tool unapproved', async () => {
    const workspace = mkTmp('kubic-approval-crash-');
    const sessions = join(workspace, 'session');
    let asks = 0;

    // Process 1: the ask is raised and never answered, then the process
    // "dies" — the harness is abandoned with the tool task still in its
    // beforeTool phase, so no intent was committed.
    const first = await bootHarness({
      workspace,
      storage: await openNodeJsonlStorage(sessions, BACKGROUND_CONTEXT),
      answer: () => {
        asks += 1;
        return new Promise<ApprovalVerdict | undefined>(() => {});
      },
    });
    const submission = await first.root.submit(
      { type: 'input', content: 'clean up' },
      BACKGROUND_CONTEXT,
    );
    await waitUntil(() => asks === 1);
    expect(first.world.calls).toEqual([]);
    // Release the crashed process's storage; closing the harness itself would
    // join the interrupted invocation. No intent was committed, so nothing
    // of process 1 needs to be settled before process 2 opens.
    await first.storage.close(BACKGROUND_CONTEXT);

    // Process 2: a fresh harness over the same storage re-runs the tool's
    // `call` phase, so the approval is asked again and answered.
    const second = await bootHarness({
      workspace,
      storage: await openNodeJsonlStorage(sessions, BACKGROUND_CONTEXT),
      scriptToolCall: false,
      answer: async () => {
        asks += 1;
        return { approved: false, reason: 'denied by the user' };
      },
    });
    try {
      second.harness.resume();
      const resumed = await second.harness.submission(
        submission.id,
        BACKGROUND_CONTEXT,
      );
      expect(resumed).toBeDefined();
      expect((await resumed?.wait(BACKGROUND_CONTEXT))?.status).toBe('done');
      // Re-asked, and the resumed call was refused without running.
      expect(asks).toBe(2);
      expect(second.world.calls).toEqual([]);
      expect(await toolResultText(second.root)).toContain(
        'not approved: denied by the user',
      );
    } finally {
      await second.harness.close(BACKGROUND_CONTEXT);
    }
  });

  it('reuses a remembered decision on resume instead of asking again', async () => {
    const workspace = mkTmp('kubic-approval-remembered-');
    const sessions = join(workspace, 'session');
    let asks = 0;

    const first = await bootHarness({
      workspace,
      storage: await openNodeJsonlStorage(sessions, BACKGROUND_CONTEXT),
      answer: () => {
        asks += 1;
        return new Promise<ApprovalVerdict | undefined>(() => {});
      },
    });
    const submission = await first.root.submit(
      { type: 'input', content: 'clean up' },
      BACKGROUND_CONTEXT,
    );
    await waitUntil(() => asks === 1);
    await first.storage.close(BACKGROUND_CONTEXT);

    // The answer was recorded before the crash: the resumed process finds the
    // session decision and never asks the seat.
    const key = approvalKey('bash', 'destructive-shell', { command: COMMAND });
    new FileApprovalStore(workspace).save({
      [key]: { approved: true, by: 'allow-session' },
    });

    const second = await bootHarness({
      workspace,
      storage: await openNodeJsonlStorage(sessions, BACKGROUND_CONTEXT),
      scriptToolCall: false,
      answer: async () => {
        asks += 1;
        return { approved: false, reason: 'the seat must not be asked' };
      },
    });
    try {
      second.harness.resume();
      const resumed = await second.harness.submission(
        submission.id,
        BACKGROUND_CONTEXT,
      );
      expect((await resumed?.wait(BACKGROUND_CONTEXT))?.status).toBe('done');
      // Only the crashed ask reached the seat; the remembered decision ran
      // the call without a second one.
      expect(asks).toBe(1);
      expect(second.world.calls).toEqual([{ command: COMMAND }]);
      expect(await toolResultText(second.root)).not.toContain('not approved');
    } finally {
      await second.harness.close(BACKGROUND_CONTEXT);
    }
  });
});
