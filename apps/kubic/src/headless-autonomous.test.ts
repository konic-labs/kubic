// The mode on the path: `kubic run --autonomous`
// records `autonomous` on the run's session; without the flag the session
// carries `interactive` (off by default, never assumed). Faux provider,
// scratch sessions root — zero network, zero paid tokens.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  listSessions,
  openSessionStore,
} from '@kubic/agent/lane/session-store';
import type { MutableModels } from '@kubic/agent/pi-boundary';
import {
  BACKGROUND_CONTEXT,
  createModels,
  fauxAssistantMessage,
  fauxProvider,
} from '@kubic/agent/pi-boundary';
import { NodeExecutionEnv } from '@kubic/exec/env';
import { createNodeFileBridge } from '@kubic/exec/file-bridge';
import {
  auditLedgerDirFor,
  readAuditLedger,
} from '@kubic/host/policy/audit-ledger';
import { buildRunEnvelope } from '@kubic/host/run-cli';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runHeadlessPrompt } from './headless-run.js';

const made: string[] = [];

function tmp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  made.push(dir);
  return dir;
}

beforeEach(() => {
  vi.stubEnv('KUBIC_NO_NOTICE', '1');
});

afterEach(() => {
  vi.unstubAllEnvs();
  for (const dir of made.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

function models(): MutableModels {
  const faux = fauxProvider({
    provider: 'faux',
    models: [{ id: 'small', contextWindow: 120000 }],
  });
  faux.setResponses([fauxAssistantMessage('nothing to change')]);
  const registry = createModels();
  registry.setProvider(faux.provider);
  return registry;
}

async function runModeOf(autonomous: boolean): Promise<{
  mode: string | undefined;
  cwd: string;
  resultMode: string | undefined;
  envelopeMode: string | undefined;
}> {
  const sessionsRoot = tmp('autonomous-sessions-');
  const cwd = tmp('autonomous-cwd-');
  const result = await runHeadlessPrompt(
    'hi',
    { autonomous },
    {
      sessionsRoot,
      models: models(),
      env: new NodeExecutionEnv(cwd),
    },
  );
  expect(result.terminus).toBe('completed');
  const store = openSessionStore(
    sessionsRoot,
    createNodeFileBridge(sessionsRoot),
  );
  const entries = await listSessions(store, BACKGROUND_CONTEXT);
  expect(entries).toHaveLength(1);
  const entry = entries[0];
  expect(entry).toBeDefined();
  return {
    mode: entry?.meta?.mode,
    cwd,
    resultMode: result.mode,
    envelopeMode: buildRunEnvelope(result, 0).mode,
  };
}

describe('kubic run --autonomous records the mode', () => {
  it('records autonomous when the flag is passed', async () => {
    await expect(runModeOf(true).then((run) => run.mode)).resolves.toBe(
      'autonomous',
    );
  }, 60_000);

  it('records interactive without the flag (off by default)', async () => {
    await expect(runModeOf(false).then((run) => run.mode)).resolves.toBe(
      'interactive',
    );
  }, 60_000);

  // Acceptance: the result and the --json envelope name the mode
  // (the status already names the stop condition).
  it.each([true, false])(
    'the result and envelope name the mode (flag=%s)',
    async (autonomous) => {
      const run = await runModeOf(autonomous);
      const expected = autonomous ? 'autonomous' : 'interactive';
      expect(run.resultMode).toBe(expected);
      expect(run.envelopeMode).toBe(expected);
    },
    60_000,
  );

  // Acceptance: the mode reaches the ledger at run start.
  it.each([true, false])(
    'writes a run:start ledger row with the mode (flag=%s)',
    async (autonomous) => {
      const run = await runModeOf(autonomous);
      const rows = readAuditLedger(auditLedgerDirFor(run.cwd));
      const start = rows.find((row) => row.what === 'run:start');
      expect(start).toMatchObject({
        result: 'ok',
      });
      expect(start?.reason).toContain(
        autonomous ? 'autonomous' : 'interactive',
      );
    },
    60_000,
  );

  // Review (low): the row records the resolved worktree base —
  // the scratch cwd is outside git, so the honest value is `none`, never
  // a hardcoded `unknown`.
  it('writes the resolved run base on the run:start row', async () => {
    const run = await runModeOf(false);
    const rows = readAuditLedger(auditLedgerDirFor(run.cwd));
    const start = rows.find((row) => row.what === 'run:start');
    expect(start?.workspace).toMatchObject({
      path: run.cwd,
      base: 'none',
    });
  }, 60_000);
});
