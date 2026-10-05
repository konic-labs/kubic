// Prod extension startup (issue #93): the composition root loads the
// first-party bundle set at process startup for the solo lane (`kubic run`)
// and the manager lane (`kubic orchestrate`), through the SAME trust gates
// the doctor probe uses — and a live surface consumes the worker facet, so
// the limits the CLI started with actually bound the run.
//
// Lives in host because vitest only includes packages/*: it reaches across to
// the composition root (apps/kubic) purely as a black-box caller. Faux
// provider + FakeExecutionEnv only — zero network.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeExecutionEnv } from '../../../packages/exec/src/env.js';
import { createNodeFileBridge } from '../../../packages/exec/src/file-bridge.js';
import { startFirstPartyExtensions } from '../../../packages/extensions/src/runtime.js';
import type { BundleDirFiles } from '../../../packages/extensions/src/startup.js';
import { ExtensionStartupError } from '../../../packages/extensions/src/startup.js';
import {
  attachSession,
  openSessionStore,
} from '../../../packages/worker/src/lane/session-store.js';
import { fauxToolUse } from '../../../packages/worker/src/lane/test-harness.js';
import {
  entriesToTranscript,
  readSessionEntries,
} from '../../../packages/worker/src/lane/transcript.js';
import {
  BACKGROUND_CONTEXT,
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
  type MutableModels,
} from '../../../packages/worker/src/pi-boundary.js';
import {
  loadExtensionStartup,
  prodExtensionStartupOptions,
} from './extension-startup.js';
import { runHeadlessPrompt } from './headless-run.js';
import { orchestrateDepsWithDefaults } from './orchestrate-run.js';

const made: string[] = [];

function tmpRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), 'ext-startup-prod-'));
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

// Two ls calls then a closing message: enough for a budget to admit one and
// refuse the next.
function twoCallModels(): MutableModels {
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  faux.setResponses([
    fauxToolUse([fauxToolCall('ls', { path: '.' })]),
    fauxToolUse([fauxToolCall('ls', { path: '.' })]),
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
    // The shared adapter (#400) renders the 1.0 entries as text: user and
    // assistant text, plus every tool result's own output.
    const parts = entriesToTranscript(
      await readSessionEntries(session.storage, BACKGROUND_CONTEXT),
    ).map((item) => {
      if (item.kind === 'tool-result') return item.text;
      return 'text' in item && typeof item.text === 'string' ? item.text : '';
    });
    return parts.filter((part) => part !== '').join('\n');
  } finally {
    await session.release(BACKGROUND_CONTEXT);
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
    // maxToolCalls: 1 through the real startup loader: the second tool call
    // trips the run guard — the run ends budget_exhausted (exit 3) with the
    // limit named (issue #283), instead of settling completed with the
    // refusal as tool content. Remove the budgetToolGate contribution from
    // headless-run.ts and both calls run instead.
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
    expect(result.terminus).toBe('budget_exhausted');
    expect(result.summary).toContain('toolCalls');
    // Exactly one ls really executed: the budget admitted one call, the
    // guard tripped on the next.
    const transcript = await transcriptOf(root, result.sessionId);
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
      err: () => undefined,
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
      err: () => undefined,
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
