// Audit and trajectory identity on the prod run/tui paths. The audit row of
// every resolved ask and the trajectory name the model the lane ACTUALLY
// runs — after the stored-model rule reconciled a resumed session, and after
// a TUI `/model` switch — and every row carries the run's own identity.
//
// Faux provider only: zero network, zero paid tokens. Real workspaces in temp
// dirs (the ledger lives under <workspace>/.kubic/audit).
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NodeExecutionEnv } from '../../../packages/exec/src/env.js';
import { createNodeFileBridge } from '../../../packages/exec/src/file-bridge.js';
import { installSoloPolicy } from '../../../packages/host/src/approvals.js';
import {
  auditLedgerDir,
  readAuditLedger,
} from '../../../packages/host/src/policy/audit-ledger.js';
import { parseTrajectoryExportJSON } from '../../../packages/trajectory/src/schema.js';
import {
  createSession,
  openSessionStore,
} from '../../../packages/worker/src/lane/session-store.js';
import { fauxToolUse } from '../../../packages/worker/src/lane/test-harness.js';
import {
  BACKGROUND_CONTEXT,
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
  type MutableModels,
} from '../../../packages/worker/src/pi-boundary.js';
import { terminalRig } from '../../../test/fake-terminal.js';
import { runHeadlessPrompt } from './headless-run.js';
import { bootTuiLane, runTuiCommand, type TuiRunDeps } from './tui-run.js';

const made: string[] = [];

function tmpRoot(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  made.push(dir);
  return dir;
}

beforeEach(() => {
  vi.stubEnv('KUBIC_NO_NOTICE', '1');
  vi.stubEnv('KUBIC_PROVIDER', '');
});

afterEach(() => {
  vi.unstubAllEnvs();
  for (const dir of made.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

type FauxMessage = ReturnType<typeof fauxAssistantMessage>;

const DESTRUCTIVE = (): FauxMessage =>
  fauxToolUse([fauxToolCall('bash', { command: 'rm -rf /tmp/x' })]);

// Two faux models on one provider; the default (unpinned) pick is `big`.
function catalog(steps: FauxMessage[]): MutableModels {
  const faux = fauxProvider({
    provider: 'faux',
    models: [
      { id: 'big', contextWindow: 200000 },
      { id: 'small', contextWindow: 120000 },
    ],
  });
  const models = createModels();
  models.setProvider(faux.provider);
  faux.setResponses(steps);
  return models;
}

// The seams of a headless run that default to process.cwd() — the tool env
// (and so the ledger's workspace), skills discovery, role documents and
// models.json — pinned to a temp workspace, so a run never reads or writes the
// real cwd (a Stryker sandbox is a directory inside the checkout: the ledger
// resolver would climb out of it into the real repo).
function hermetic(workspace: string) {
  return {
    env: new NodeExecutionEnv(workspace),
    modelsCwd: workspace,
    skills: { cwd: workspace, homeDir: workspace, trusted: false },
    roles: { cwd: workspace },
    notice: () => undefined,
  };
}

// The same pinning for the interactive boot.
function hermeticBoot(workspace: string) {
  return {
    env: new NodeExecutionEnv(workspace),
    skills: { cwd: workspace, homeDir: workspace, trusted: false },
  };
}

// A session whose lane was created on faux/small (the stored model).
async function sessionOnSmall(root: string): Promise<string> {
  const store = openSessionStore(root, createNodeFileBridge(root));
  const session = await createSession(
    store,
    { cwd: '/work' },
    BACKGROUND_CONTEXT,
  );
  const id = session.id;
  await session.release(BACKGROUND_CONTEXT);
  const first = await runHeadlessPrompt(
    'first',
    { sessionId: id },
    {
      sessionsRoot: root,
      models: catalog([fauxAssistantMessage('one')]),
      model: { provider: 'faux', id: 'small' },
      ...hermetic(tmpRoot('audit-id-first-ws-')),
    },
  );
  expect(first.model).toBe('faux/small');
  return id;
}

describe('kubic run: the audit row and the trajectory name the model the lane runs', () => {
  it('an unpinned resume of a faux/small session records faux/small, not the selected default faux/big', async () => {
    const root = tmpRoot('audit-id-root-');
    const workspace = tmpRoot('audit-id-ws-');
    const id = await sessionOnSmall(root);
    const result = await runHeadlessPrompt(
      'clean up',
      { sessionId: id },
      {
        sessionsRoot: root,
        models: catalog([DESTRUCTIVE(), fauxAssistantMessage('done')]),
        ...hermetic(workspace),
      },
    );
    // The lane ran on the session's own model ...
    expect(result.model).toBe('faux/small');
    expect(result.terminus).toBe('approval_denied');
    // ... so the audit row of the refused ask names it ...
    const records = readAuditLedger(auditLedgerDir(workspace));
    const record = records.find((r) => r.what === 'tool:bash');
    expect(record?.model).toMatchObject({ provider: 'faux', id: 'small' });
    // ... and so does the trajectory (model and provenance).
    const exported = parseTrajectoryExportJSON(
      readFileSync(result.trajectoryRef ?? '', 'utf8'),
    );
    expect(exported.provenance.model).toBe('faux/small');
    expect(exported.model).toMatchObject({ provider: 'faux', model: 'small' });
  });

  it('an explicit pin that switches the resumed session is what the audit row names', async () => {
    const root = tmpRoot('audit-id-pin-root-');
    const workspace = tmpRoot('audit-id-pin-ws-');
    const id = await sessionOnSmall(root);
    const result = await runHeadlessPrompt(
      'clean up',
      { sessionId: id },
      {
        sessionsRoot: root,
        models: catalog([DESTRUCTIVE(), fauxAssistantMessage('done')]),
        model: { provider: 'faux', id: 'big' },
        ...hermetic(workspace),
      },
    );
    expect(result.model).toBe('faux/big');
    const record = readAuditLedger(auditLedgerDir(workspace)).find(
      (r) => r.what === 'tool:bash',
    );
    expect(record?.model).toMatchObject({ provider: 'faux', id: 'big' });
    const exported = parseTrajectoryExportJSON(
      readFileSync(result.trajectoryRef ?? '', 'utf8'),
    );
    expect(exported.provenance.model).toBe('faux/big');
    expect(exported.model).toMatchObject({ provider: 'faux', model: 'big' });
  });
});

function fakeTerminal(width: number) {
  return terminalRig(width, 30);
}

async function waitFor(condition: () => boolean): Promise<void> {
  for (let i = 0; i < 1000 && !condition(); i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  expect(condition()).toBe(true);
}

function type(fake: ReturnType<typeof fakeTerminal>, text: string): void {
  for (const ch of text) fake.feed(ch);
  fake.feed('\r');
}

describe('kubic tui: the audit row names the model the lane runs', () => {
  it('after `/model alt/m1` the refused ask is recorded on alt/m1, not the boot model', async () => {
    const workspace = tmpRoot('audit-id-tui-ws-');
    const sessionsRoot = tmpRoot('audit-id-tui-root-');
    const models = createModels();
    const faux = fauxProvider({
      provider: 'faux',
      models: [{ id: 'big', contextWindow: 200000 }],
    });
    faux.setResponses([fauxAssistantMessage('from faux')]);
    models.setProvider(faux.provider);
    const alt = fauxProvider({
      provider: 'alt',
      models: [{ id: 'm1', contextWindow: 100000 }],
    });
    alt.setResponses([DESTRUCTIVE(), fauxAssistantMessage('after deny')]);
    models.setProvider(alt.provider);
    const fake = fakeTerminal(120);
    const bootLane: TuiRunDeps['bootLane'] = async (sid, answer) =>
      bootTuiLane(sid, {
        sessionsRoot,
        models,
        ...hermeticBoot(workspace),
        ...(answer === undefined ? {} : { answer }),
        model: { provider: 'faux', id: 'big' },
      });
    const pending = runTuiCommand(
      {},
      {
        out: () => undefined,
        createTerminal: () => fake.terminal,
        approvalArmingMs: 0,
        bootLane,
      },
    );
    await waitFor(() => fake.counts.started === 1);
    type(fake, '/model alt/m1');
    await waitFor(() => fake.frame.includes('model: alt/m1'));
    type(fake, 'clean up');
    await waitFor(() => fake.frame.includes('APPROVAL'));
    fake.feed('d');
    await waitFor(() => fake.frame.includes('after deny'));
    fake.feed('\x03');
    fake.feed('\x03');
    expect((await pending).exitCode).toBe(0);
    const record = readAuditLedger(auditLedgerDir(workspace)).find(
      (r) => r.what === 'tool:bash',
    );
    expect(record?.model).toMatchObject({ provider: 'alt', id: 'm1' });
  });

  it('an unpinned resume of a faux/small session records faux/small', async () => {
    const workspace = tmpRoot('audit-id-tui-resume-ws-');
    const sessionsRoot = tmpRoot('audit-id-tui-resume-root-');
    const id = await sessionOnSmall(sessionsRoot);
    const models = catalog([DESTRUCTIVE(), fauxAssistantMessage('after deny')]);
    const fake = fakeTerminal(120);
    const pending = runTuiCommand(
      { session: id },
      {
        out: () => undefined,
        createTerminal: () => fake.terminal,
        approvalArmingMs: 0,
        bootLane: async (sid, answer) =>
          bootTuiLane(sid, {
            sessionsRoot,
            models,
            ...hermeticBoot(workspace),
            ...(answer === undefined ? {} : { answer }),
          }),
      },
    );
    await waitFor(() => fake.counts.started === 1);
    type(fake, 'clean up');
    await waitFor(() => fake.frame.includes('APPROVAL'));
    fake.feed('d');
    await waitFor(() => fake.frame.includes('after deny'));
    fake.feed('\x03');
    fake.feed('\x03');
    expect((await pending).exitCode).toBe(0);
    const record = readAuditLedger(auditLedgerDir(workspace)).find(
      (r) => r.what === 'tool:bash',
    );
    expect(record?.model).toMatchObject({ provider: 'faux', id: 'small' });
  });
});

describe('a run records its own identity', () => {
  it('a locally decided ask is one root row with the process pid', async () => {
    const root = tmpRoot('audit-id-solo-root-');
    const workspace = tmpRoot('audit-id-solo-ws-');
    await runHeadlessPrompt(
      'clean up',
      {},
      {
        sessionsRoot: root,
        models: catalog([DESTRUCTIVE(), fauxAssistantMessage('done')]),
        ...hermetic(workspace),
      },
    );
    const records = readAuditLedger(auditLedgerDir(workspace)).filter(
      (r) => r.what === 'tool:bash',
    );
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      who: 'agent:root',
      agent: { role: 'root' },
      process: { pid: process.pid },
    });
  });
});

describe('installSoloPolicy audit model', () => {
  const call = (id: string) => ({
    toolName: 'bash',
    args: { command: 'rm -rf build' },
    toolCallId: id,
  });

  it('a string model is recorded as given; a function is read at RECORD time, per row', async () => {
    const workspace = tmpRoot('audit-id-install-ws-');
    let live = 'faux/big';
    const withFn = installSoloPolicy({
      workspace,
      sessionDir: tmpRoot('audit-id-install-s1-'),
      sessionId: 'fn-session',
      route: 'deny',
      model: () => live,
    });
    await withFn.ask(call('c1'));
    live = 'alt/m1';
    await withFn.ask(call('c2'));
    const withString = installSoloPolicy({
      workspace,
      sessionDir: tmpRoot('audit-id-install-s2-'),
      sessionId: 'str-session',
      route: 'deny',
      model: 'faux/small',
    });
    await withString.ask(call('c3'));
    const withNone = installSoloPolicy({
      workspace,
      sessionDir: tmpRoot('audit-id-install-s3-'),
      sessionId: 'none-session',
      route: 'deny',
    });
    await withNone.ask(call('c4'));
    const rows = readAuditLedger(auditLedgerDir(workspace));
    expect(
      rows.map((r) => [r.agent.session, r.model.provider, r.model.id]),
    ).toEqual([
      ['fn-session', 'faux', 'big'],
      ['fn-session', 'alt', 'm1'],
      ['str-session', 'faux', 'small'],
      ['none-session', 'unknown', 'unknown'],
    ]);
  });
});
