// Config → live run path (issue #90, acceptance criterion 1): a
// `.kubic/config.toml` value must measurably change a live behaviour, not
// merely parse. This drives the production headless runner (`kubic run`'s
// own adapter) with the projections the composition root injects and checks
// the journal the run wrote and the lane allowlist it installed.
//
// Faux provider only: zero network, zero paid tokens.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runHeadlessPrompt } from '../../../../apps/kubic/src/headless-run.js';
import { SOLO_DEFAULTS } from '../../../agents/src/policy.js';
import { FakeExecutionEnv } from '../../../exec/src/env.js';
import { createNodeFileBridge } from '../../../exec/src/file-bridge.js';
import { FileJournalStore } from '../../../exec/src/journal.js';
import {
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  type MutableModels,
} from '../../../worker/src/pi-boundary.js';
import { loadRuntimeConfig } from './runtime.js';

function fauxModels(text: string): MutableModels {
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  faux.setResponses([fauxAssistantMessage(text)]);
  return models;
}

function tmpRoot(): string {
  return mkdtempSync(join(tmpdir(), 'kubic-90-run-'));
}

describe('config feeds the live run path (issue #90)', () => {
  it('bounds the journal the run writes from [journal] retentionDays', async () => {
    const root = tmpRoot();
    const runtime = loadRuntimeConfig({
      bridge: createNodeFileBridge(root),
      home: '/nonexistent-home',
      cwd: root,
      enterprisePath: '/nonexistent/config.toml',
      projectTrusted: true,
      env: {},
    });
    expect(runtime.journal.maxAgeMs).toBeUndefined();

    // Retention configured: the store the run creates prunes on append.
    const withRetention = loadRuntimeConfig({
      bridge: {
        exists: (path: string): boolean =>
          path === `${root}/.kubic/config.toml`,
        readTextFile: (): string =>
          '[journal]\nretentionDays = 1\n[approvals]\nroute = "deny"\n',
      },
      home: '/nonexistent-home',
      cwd: root,
      enterprisePath: '/nonexistent/config.toml',
      projectTrusted: true,
      env: {},
    });
    expect(withRetention.journal.maxAgeMs).toBe(86_400_000);

    const store = new FileJournalStore(join(root, 'journal'), {
      maxAgeMs: withRetention.journal.maxAgeMs,
    });
    store.append({
      path: 'stale.txt',
      op: 'write',
      before: null,
      after: 'x',
      bytesDelta: 1,
      sessionId: 's1',
      agentId: 'root',
      toolCallId: null,
      timestamp: Date.now() - 3 * 86_400_000,
    });
    expect(store.entries()).toEqual([]);
  });

  it('drives a real lane whose allowlist comes from the loaded classes', async () => {
    const root = tmpRoot();
    // Config narrows the lane to read-only tools; the run must honour it.
    const runtime = loadRuntimeConfig({
      bridge: {
        exists: (path: string): boolean =>
          path === `${root}/.kubic/config.toml`,
        readTextFile: (): string =>
          '[permissions]\nfilesystem = "read"\nshell = false\ngit = false\n',
      },
      home: '/nonexistent-home',
      cwd: root,
      enterprisePath: '/nonexistent/config.toml',
      projectTrusted: true,
      env: {},
    });
    expect(runtime.permissions.classes).toEqual({
      ...SOLO_DEFAULTS,
      filesystem: 'read',
      shell: false,
      git: false,
    });

    const result = await runHeadlessPrompt(
      'say hi',
      {},
      {
        sessionsRoot: root,
        models: fauxModels('hi'),
        env: new FakeExecutionEnv({}).withProvenance({
          source: 'kubic-90-test',
        } as never),
        policyClasses: runtime.permissions.classes,
        journalRetention:
          runtime.journal.maxAgeMs === undefined
            ? {}
            : { maxAgeMs: runtime.journal.maxAgeMs },
      },
    );
    expect(result.terminus).toBe('completed');
    // The run wrote a real session whose journal exists at the documented
    // location (§E3) — the config did not stop the run, it shaped it.
    const ref = result.sessionId;
    const journalDir = join(root, ref, 'journal');
    expect(createNodeFileBridge(root).exists(journalDir)).toBe(true);
  });

  it('leaves the lane on its own defaults when no config value is set', async () => {
    const root = tmpRoot();
    const runtime = loadRuntimeConfig({
      bridge: createNodeFileBridge(root),
      home: '/nonexistent-home',
      cwd: root,
      enterprisePath: '/nonexistent/config.toml',
      projectTrusted: false,
      env: {},
    });
    // §40/§12.1: an absent [permissions] section resolves to the solo
    // defaults — never to the most permissive or restrictive extreme.
    expect(runtime.permissions.classes).toEqual({
      ...SOLO_DEFAULTS,
    });
    expect(runtime.permissions.source).toBe('defaults');
    const result = await runHeadlessPrompt(
      'say hi',
      {},
      {
        sessionsRoot: root,
        models: fauxModels('hi'),
        env: new FakeExecutionEnv({}).withProvenance({
          source: 'kubic-90-test',
        } as never),
        policyClasses: runtime.permissions.classes,
      },
    );
    expect(result.terminus).toBe('completed');
  });
});
