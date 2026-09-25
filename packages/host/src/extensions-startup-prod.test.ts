// Prod extension startup (issue #93): the composition root loads the
// first-party bundle set at process startup for the solo lane (`kubic run`)
// and the manager lane (`kubic orchestrate`), through the SAME trust gates
// the doctor probe uses — and a live surface consumes the worker facet, so
// the limits the CLI started with actually bound the run.
//
// Lives in host because vitest only includes packages/*: it reaches across to
// the composition root (apps/kubic) purely as a black-box caller. Faux
// provider + FakeExecutionEnv only — zero network.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  loadExtensionStartup,
  prodExtensionStartupOptions,
} from '../../../apps/kubic/src/extension-startup.js';
import { runHeadlessPrompt } from '../../../apps/kubic/src/headless-run.js';
import { orchestrateDepsWithDefaults } from '../../../apps/kubic/src/orchestrate-run.js';
import { FakeExecutionEnv } from '../../exec/src/env.js';
import { createNodeFileBridge } from '../../exec/src/file-bridge.js';
import {
  startFirstPartyExtensions,
  type ToolGateContribution,
} from '../../extensions/src/runtime.js';
import type { BundleDirFiles } from '../../extensions/src/startup.js';
import { ExtensionStartupError } from '../../extensions/src/startup.js';
import {
  attachSession,
  openSessionStore,
} from '../../worker/src/lane/session-store.js';
import {
  BACKGROUND_CONTEXT,
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
  type MutableModels,
} from '../../worker/src/pi-boundary.js';

function tmpRoot(): string {
  return mkdtempSync(join(tmpdir(), 'ext-startup-prod-'));
}

function fauxModels(texts: string[]): MutableModels {
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  faux.setResponses(texts.map((text) => fauxAssistantMessage(text)));
  return models;
}

// Two ls calls then a closing message: enough for a budget to admit one and
// refuse the next.
function twoCallModels(): MutableModels {
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  faux.setResponses([
    fauxAssistantMessage([fauxToolCall('ls', { path: '.' })]),
    fauxAssistantMessage([fauxToolCall('ls', { path: '.' })]),
    fauxAssistantMessage('done'),
  ]);
  return models;
}

// The session transcript as one string: the run's own record of what the
// tool stack did, so a live-facet assertion reads real output rather than a
// summary the lane composed afterwards. Text parts are joined raw (never
// re-stringified — escaping would hide the tool-result payloads being
// asserted on).
async function transcriptOf(root: string, sessionId: string): Promise<string> {
  const store = openSessionStore(root, createNodeFileBridge(root));
  const session = await attachSession(store, sessionId, BACKGROUND_CONTEXT);
  try {
    const entries = await session.findEntries(undefined, BACKGROUND_CONTEXT);
    const parts: string[] = [];
    for (const entry of entries) {
      const content = (entry as { message?: { content?: unknown } }).message
        ?.content;
      if (!Array.isArray(content)) continue;
      for (const part of content) {
        const text = (part as { text?: unknown }).text;
        if (typeof text === 'string') parts.push(text);
      }
    }
    return parts.join('\n');
  } finally {
    await session.close(BACKGROUND_CONTEXT);
  }
}

// A files bridge with no bundle dir anywhere: the walk finds nothing and the
// load fails closed with the named error.
function missingBundleFiles(): BundleDirFiles {
  return {
    joinPath: (parts: string[]) => parts.join('/'),
    exists: () => false,
    fileInfo: () => {
      throw new Error('ENOENT: no such file');
    },
    readTextFile: () => {
      throw new Error('ENOENT: no such file');
    },
  };
}

describe('prod extension startup, solo lane (issue #93)', () => {
  it('loads the first-party bundle on the production path and reports both refused attempts', async () => {
    const receipts: string[] = [];
    const result = await runHeadlessPrompt(
      'say hi',
      {},
      {
        sessionsRoot: tmpRoot(),
        models: fauxModels(['all done']),
        env: new FakeExecutionEnv({}),
        debug: (line) => receipts.push(line),
      },
    );
    expect(result.terminus).toBe('completed');
    // The loader really ran on the boot path: the receipt carries the same
    // detail the doctor surface prints, refusals included (not swallowed).
    const receipt = receipts.find((line) => line.startsWith('extensions: '));
    expect(receipt).toBeDefined();
    expect(receipt).toContain(
      'loaded 1 (kubic/budget: budget: none configured)',
    );
    expect(receipt).toContain(
      'refused 2 (owned-path traversal, remote-flag use)',
    );
  });

  it('applies the loaded worker-facet limits to the live tool stack', async () => {
    // maxToolCalls: 1 through the real startup loader: the second tool call is
    // refused. Remove the budgetToolGate contribution from headless-run.ts and
    // both calls run instead — the transcript carries no refusal.
    const extensions = await startFirstPartyExtensions({
      ...prodExtensionStartupOptions(process.cwd()),
      limits: { maxToolCalls: 1 },
    });
    const root = tmpRoot();
    const result = await runHeadlessPrompt(
      'list twice',
      {},
      {
        sessionsRoot: root,
        models: twoCallModels(),
        env: new FakeExecutionEnv({}),
        extensions,
      },
    );
    // The lane settles: a refused tool is model-readable content, not a lane
    // fault. The proof is the transcript, where the run actually happened.
    const transcript = await transcriptOf(root, result.sessionId);
    expect(transcript).toContain(
      'extension budget exhausted: toolCalls limit breached',
    );
    expect(transcript).toContain(
      'worker facet of the loaded first-party bundle',
    );
    // Exactly one ls really executed: the budget admitted one call, refused
    // the next.
    expect(transcript.match(/"path":"\.","entries":\[\]/g) ?? []).toHaveLength(
      1,
    );
  });

  it('admits every tool call when the loaded budget configures no limits', async () => {
    const extensions = await startFirstPartyExtensions(
      prodExtensionStartupOptions(process.cwd()),
    );
    const root = tmpRoot();
    const result = await runHeadlessPrompt(
      'list twice',
      {},
      {
        sessionsRoot: root,
        models: twoCallModels(),
        env: new FakeExecutionEnv({}),
        extensions,
      },
    );
    expect(result.terminus).toBe('completed');
    const transcript = await transcriptOf(root, result.sessionId);
    expect(transcript).not.toContain('extension budget exhausted');
    expect(transcript.match(/"path":"\.","entries":\[\]/g) ?? []).toHaveLength(
      2,
    );
  });

  it('fails closed on the production path when the bundle dir is gone', async () => {
    const result = await runHeadlessPrompt(
      'say hi',
      {},
      {
        sessionsRoot: tmpRoot(),
        models: fauxModels(['should never run']),
        env: new FakeExecutionEnv({}),
        extensionOptions: {
          ...prodExtensionStartupOptions(process.cwd()),
          files: missingBundleFiles(),
        },
      },
    );
    expect(result.terminus).toBe('failed');
    expect(result.summary).toContain('extension startup failed closed');
    expect(result.summary).toContain('skills/budget');
  });
});

describe('prod extension startup, manager lane (issue #93)', () => {
  it('loads the bundle at manager startup and reports the receipt', async () => {
    const debugLines: string[] = [];
    const deps = await orchestrateDepsWithDefaults({
      out: () => undefined,
      debug: (line) => debugLines.push(line),
      cwd: tmpRoot(),
    });
    expect(deps).toBeDefined();
    const receipt = debugLines.find((line) => line.startsWith('extensions: '));
    expect(receipt).toContain(
      'loaded 1 (kubic/budget: budget: none configured)',
    );
    expect(receipt).toContain('refused 2');
  });

  it('fails closed at manager startup when the bundle dir is gone', async () => {
    const error = await orchestrateDepsWithDefaults({
      out: () => undefined,
      cwd: tmpRoot(),
      extensionOptions: {
        ...prodExtensionStartupOptions(process.cwd()),
        files: missingBundleFiles(),
      },
    }).then(
      () => undefined,
      (thrown: unknown) => thrown,
    );
    expect(error).toBeInstanceOf(ExtensionStartupError);
    expect((error as Error).message).toContain('skills/budget');
  });
});

describe('extension startup doctrine (issue #93)', () => {
  it('loads for the lane boots and doctor, and stays out of the read-only commands', async () => {
    const loaded = await loadExtensionStartup('run', process.cwd());
    expect(loaded?.loaded).toEqual(['kubic/budget']);
    expect((await loadExtensionStartup('tui', process.cwd()))?.ok).toBe(true);
    expect((await loadExtensionStartup('orchestrate', process.cwd()))?.ok).toBe(
      true,
    );
    expect((await loadExtensionStartup('doctor', process.cwd()))?.ok).toBe(
      true,
    );
    expect(await loadExtensionStartup('diff', process.cwd())).toBeUndefined();
    expect(
      await loadExtensionStartup('--version', process.cwd()),
    ).toBeUndefined();
  });

  it('refuses to boot a lane while doctor still reports the posture', async () => {
    const broken = {
      ...prodExtensionStartupOptions(process.cwd()),
      files: missingBundleFiles(),
    };
    // Lane doctrine: throw, never run bare.
    await expect(startFirstPartyExtensions(broken)).rejects.toBeInstanceOf(
      ExtensionStartupError,
    );
    // Doctor doctrine: report the same failure as data so the check line
    // prints the named error (the CLI still exits non-zero).
    const posture = await loadExtensionStartup('doctor', process.cwd(), {
      options: broken,
    });
    expect(posture?.ok).toBe(false);
    expect(posture?.detail).toContain('skills/budget');
  });
});
