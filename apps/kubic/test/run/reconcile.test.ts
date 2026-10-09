// End-of-run reconciliation on the real composition path:
// `runHeadlessPrompt` must capture a baseline before the first turn and
// sweep after the last, so a file mutated through `bash` lands in the
// session journal as an unattributed entry — and stays reachable through
// `kubic diff --session <id>` / `kubic undo --session <id>`.
//
// It drives the composition root as a real caller, plus the CLI the operator
// runs. Faux provider only.
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
  type MutableModels,
} from '@kubic/agent/pi-boundary';
import { fauxToolUse } from '@kubic/agent/test-support/lane-harness';
import { NodeExecutionEnv } from '@kubic/exec/env';
import { FileJournalStore, restoreEntry } from '@kubic/exec/journal';
import { runJournalCommand } from '@kubic/host/journal';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runHeadlessPrompt } from '../../src/run/command.js';

const made: string[] = [];

function tmpRoot(prefix = 'reconcile-prod-'): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  made.push(dir);
  return dir;
}

beforeEach(() => {
  // The no-isolation notice is not under test here (approvals/no-isolation-notice.test.ts owns
  // it); the documented opt-out keeps it off the test runner's stderr.
  vi.stubEnv('KUBIC_NO_NOTICE', '1');
});

afterEach(() => {
  vi.unstubAllEnvs();
  for (const dir of made.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

// bash-mutates-then-settles: the tool call writes a file Kubic never
// intercepts (bash is replay:"never" and journals nothing), then the lane
// settles. This is the exact regression shape.
function bashMutationModels(): MutableModels {
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  faux.setResponses([
    fauxToolUse([
      fauxToolCall('bash', {
        command: 'printf "bash wrote this\\n" > mutated.txt',
      }),
    ]),
    fauxAssistantMessage('done'),
  ]);
  return models;
}

function journalFor(sessionsRoot: string, id: string): FileJournalStore {
  return new FileJournalStore(join(sessionsRoot, id, 'journal'));
}

function baselinePathFor(sessionsRoot: string, id: string): string {
  return join(sessionsRoot, id, 'journal', `baseline-${id}.json`);
}

describe('end-of-run reconciliation, prod path', () => {
  it('captures a baseline at boot and sweeps a bash mutation into the journal', async () => {
    const sessionsRoot = tmpRoot();
    const workspace = tmpRoot('ws-');
    writeFileSync(join(workspace, 'untouched.txt'), 'same\n');
    const result = await runHeadlessPrompt(
      'mutate a file through bash',
      {},
      {
        sessionsRoot,
        models: bashMutationModels(),
        env: new NodeExecutionEnv(workspace),
      },
    );
    expect(result.terminus).toBe('completed');
    const id = result.sessionId;

    // (a) the baseline was taken at boot and persisted beside the journal,
    // BEFORE the mutation could exist (had it been taken at sweep time,
    // `mutated.txt` would already be in it and no entry would appear).
    const baseline = JSON.parse(
      readFileSync(baselinePathFor(sessionsRoot, id), 'utf8'),
    ) as Record<string, string>;
    expect(Object.keys(baseline)).toContain('untouched.txt');
    expect(baseline['mutated.txt']).toBeUndefined();

    // (b) the bash mutation is journaled, unattributed, with no pre-image.
    const store = journalFor(sessionsRoot, id);
    const found = store
      .entries()
      .filter((e) => e.path === 'mutated.txt')
      .at(0);
    if (found === undefined) throw new Error('no mutated.txt entry');
    expect(found.unattributed).toBe(true);
    expect(found.toolCallId).toBe(null);
    expect(store.readBefore(found)).toBe(null);
    expect(store.readAfter(found)).toBe('bash wrote this\n');

    // (c) `kubic diff --session <id>` shows it as unattributed.
    const diffOut: string[] = [];
    expect(
      (
        await runJournalCommand(
          { command: 'diff', session: id },
          {
            root: workspace,
            sessionsRoot,
            out: (line) => diffOut.push(line),
          },
        )
      ).exitCode,
    ).toBe(0);
    expect(diffOut.join('\n')).toContain('mutated.txt');
    expect(diffOut.join('\n')).toContain('unattributed');

    // (d) `kubic status --session <id>` surfaces the count too.
    const statusOut: string[] = [];
    expect(
      (
        await runJournalCommand(
          { command: 'status', session: id },
          {
            root: workspace,
            sessionsRoot,
            out: (line) => statusOut.push(line),
          },
        )
      ).exitCode,
    ).toBe(0);
    expect(statusOut.join('\n')).toContain('unattributed: 1 of 1');

    // (e) `kubic undo --session <id>` reports it non-reversible, exits 1
    // (the partial outcome never reuses the usage code), and
    // writes nothing.
    const undoOut: string[] = [];
    expect(
      (
        await runJournalCommand(
          { command: 'undo', session: id },
          {
            root: workspace,
            sessionsRoot,
            out: (line) => undoOut.push(line),
          },
        )
      ).exitCode,
    ).toBe(1);
    // The exact documented skip line, plus the summary: the entry is named,
    // and the exit code says the run could not be fully reversed.
    expect(undoOut).toContain('non-reversible (skipped): mutated.txt');
    expect(undoOut.join('\n')).toContain('undo: 0 restored, 1 non-reversible');
    // The reason behind the skip is the missing pre-image itself: hashes
    // were recorded, no pre-image exists, so undo refuses rather than
    // guessing (exec restoreEntry reports exactly this).
    expect(restoreEntry(store, found, workspace)).toEqual({
      restored: false,
      reason:
        'no before-content: no retrievable pre-image for this entry — nothing to restore',
    });
    expect(readFileSync(join(workspace, 'mutated.txt'), 'utf8')).toBe(
      'bash wrote this\n',
    );
  });

  it('journals nothing unattributed when the run changes no files', async () => {
    const sessionsRoot = tmpRoot();
    const workspace = tmpRoot('ws-clean-');
    writeFileSync(join(workspace, 'stable.txt'), 'stable\n');
    const faux = fauxProvider();
    const models = createModels();
    models.setProvider(faux.provider);
    faux.setResponses([fauxAssistantMessage('nothing to do')]);
    const result = await runHeadlessPrompt(
      'do nothing',
      {},
      { sessionsRoot, models, env: new NodeExecutionEnv(workspace) },
    );
    expect(result.terminus).toBe('completed');
    // Capture happened (the walk is cheap) but the sweep found nothing.
    expect(existsSync(baselinePathFor(sessionsRoot, result.sessionId))).toBe(
      true,
    );
    expect(journalFor(sessionsRoot, result.sessionId).entries()).toEqual([]);
  });

  it('keeps the intercepted path journaled with its toolCallId, sweep adds nothing', async () => {
    const sessionsRoot = tmpRoot();
    const workspace = tmpRoot('ws-write-');
    const faux = fauxProvider();
    const models = createModels();
    models.setProvider(faux.provider);
    faux.setResponses([
      fauxToolUse([
        fauxToolCall('write', { path: 'via-tool.txt', content: 'tool\n' }),
      ]),
      fauxAssistantMessage('wrote it'),
    ]);
    const result = await runHeadlessPrompt(
      'write through the tool',
      {},
      { sessionsRoot, models, env: new NodeExecutionEnv(workspace) },
    );
    expect(result.terminus).toBe('completed');
    const entries = journalFor(sessionsRoot, result.sessionId).entries();
    const written = entries.filter((e) => e.path === 'via-tool.txt');
    expect(written).toHaveLength(1);
    expect(written[0]?.unattributed).toBeUndefined();
    expect(written[0]?.toolCallId).toMatch(/^.+$/);
    // The sweep adds nothing on top of an intercepted change.
    expect(entries.filter((e) => e.unattributed === true)).toEqual([]);
  });

  it('takes no baseline when the lane never boots', async () => {
    const sessionsRoot = tmpRoot();
    const result = await runHeadlessPrompt(
      'hello',
      {},
      { sessionsRoot, models: createModels() },
    );
    expect(result.terminus).toBe('provider_probe_failed');
    expect(existsSync(baselinePathFor(sessionsRoot, result.sessionId))).toBe(
      false,
    );
    expect(journalFor(sessionsRoot, result.sessionId).entries()).toEqual([]);
  });
});
