// Audit and trajectory identity on the prod run/tui paths (issues #148, #279,
// #295; §60, §46). The §60 row of every resolved ask and the §46 trajectory
// name the model the lane ACTUALLY runs — after the stored-model rule (#148)
// reconciled a resumed session, and after a TUI `/model` switch — and an
// orchestrated worker child's records carry its own identity (#279).
//
// Faux provider only: zero network, zero paid tokens. Real workspaces in temp
// dirs (the ledger lives under <workspace>/.kubic/orchestrator/approvals).
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runHeadlessPrompt } from '../../../apps/kubic/src/headless-run.js';
import {
  bootTuiLane,
  runTuiCommand,
  type TuiRunDeps,
} from '../../../apps/kubic/src/tui-run.js';
import { NodeExecutionEnv } from '../../exec/src/env.js';
import { createNodeFileBridge } from '../../exec/src/file-bridge.js';
import { parseTrajectoryExportJSON } from '../../trajectory/src/schema.js';
import {
  createSession,
  openSessionStore,
} from '../../worker/src/lane/session-store.js';
import { fauxToolUse } from '../../worker/src/lane/test-harness.js';
import {
  BACKGROUND_CONTEXT,
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
  type MutableModels,
} from '../../worker/src/pi-boundary.js';
import { installSoloPolicy } from './approvals.js';
import { createApprovalSigner } from './orchestrator/approvals/seal.js';
import { auditLedgerDir, readAuditLedger } from './policy/audit-ledger.js';

const made: string[] = [];

function tmpRoot(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  made.push(dir);
  return dir;
}

beforeEach(() => {
  vi.stubEnv('KUBIC_NO_NOTICE', '1');
  vi.stubEnv('KUBIC_PROVIDER', '');
  vi.stubEnv('KUBIC_WORKER_ID', '');
  vi.stubEnv('KUBIC_WORKER_GENERATION', '');
  vi.stubEnv('KUBIC_ORCHESTRATOR_SESSION', '');
  vi.stubEnv('KUBIC_APPROVALS_DIR', '');
  vi.stubEnv('KUBIC_APPROVALS_VERIFY_KEY', '');
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
// (and so the §60 ledger's workspace), skills discovery, role documents and
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

describe('kubic run: the audit row and the trajectory name the model the lane runs (issue #148)', () => {
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
    // The lane ran on the session's own model (issue #148) ...
    expect(result.model).toBe('faux/small');
    expect(result.terminus).toBe('approval_denied');
    // ... so the §60 row of the refused ask names it ...
    const records = readAuditLedger(auditLedgerDir(workspace));
    const record = records.find((r) => r.what === 'tool:bash');
    expect(record?.model).toMatchObject({ provider: 'faux', id: 'small' });
    // ... and so does the §46 trajectory (model and provenance).
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
  const writes: string[] = [];
  const counts = { started: 0, stopped: 0 };
  let handler: ((data: string) => void) | undefined;
  return {
    writes,
    counts,
    get frame(): string {
      return writes.join('');
    },
    feed: (data: string) => {
      handler?.(data);
    },
    terminal: {
      start: (input: (data: string) => void) => {
        counts.started += 1;
        handler = input;
      },
      stop: () => {
        counts.stopped += 1;
      },
      drainInput: () => Promise.resolve(),
      write: (data: string) => writes.push(data),
      get columns(): number {
        return width;
      },
      get rows(): number {
        return 30;
      },
      get kittyProtocolActive(): boolean {
        return false;
      },
      moveBy: () => {},
      hideCursor: () => {},
      showCursor: () => {},
      clearLine: () => {},
      clearFromCursor: () => {},
      clearScreen: () => {},
      setTitle: () => {},
      setProgress: () => {},
    },
  };
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

describe('kubic tui: the audit row names the model the lane runs (issues #148, #227, #295)', () => {
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
    await waitFor(() => fake.frame.includes('Approval required'));
    fake.feed('d');
    await waitFor(() => fake.frame.includes('after deny'));
    fake.feed('\x03');
    expect(await pending).toBe(0);
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
    await waitFor(() => fake.frame.includes('Approval required'));
    fake.feed('d');
    await waitFor(() => fake.frame.includes('after deny'));
    fake.feed('\x03');
    expect(await pending).toBe(0);
    const record = readAuditLedger(auditLedgerDir(workspace)).find(
      (r) => r.what === 'tool:bash',
    );
    expect(record?.model).toMatchObject({ provider: 'faux', id: 'small' });
  });
});

// Issue #279: an orchestrator-managed worker child (`kubic orchestrate` sets
// KUBIC_WORKER_ID / KUBIC_ORCHESTRATOR_SESSION / KUBIC_WORKER_GENERATION on
// each one) writes ITS §60 rows as orchestrator records in the main ledger.
// The composition root reads that identity from the real process env; before
// this test nothing pinned the read (deleting it left the suite green).
describe('an orchestrated worker child records its own identity (issue #279)', () => {
  function workerEnv(): void {
    vi.stubEnv('KUBIC_WORKER_ID', 'w-7');
    vi.stubEnv('KUBIC_ORCHESTRATOR_SESSION', 'orch-1');
    vi.stubEnv('KUBIC_WORKER_GENERATION', '3');
  }

  it('a locally decided ask is ONE orchestrator row for the worker, with its pid, generation and role', async () => {
    workerEnv();
    const root = tmpRoot('audit-id-worker-root-');
    const workspace = tmpRoot('audit-id-worker-ws-');
    const result = await runHeadlessPrompt(
      'clean up',
      {},
      {
        sessionsRoot: root,
        models: catalog([DESTRUCTIVE(), fauxAssistantMessage('done')]),
        ...hermetic(workspace),
      },
    );
    expect(result.terminus).toBe('approval_denied');
    const records = readAuditLedger(auditLedgerDir(workspace)).filter(
      (r) => r.what === 'tool:bash',
    );
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      who: 'agent:w-7',
      mode: 'orchestrator',
      result: 'deny',
      agent: { session: result.sessionId, role: 'worker', parent: 'orch-1' },
      worker: { pid: process.pid, generation: 3, role: 'worker' },
    });
  });

  it('an ask answered through the manager seat is recorded by the manager only: the child appends nothing', async () => {
    workerEnv();
    vi.stubEnv('KUBIC_APPROVALS_DIR', tmpRoot('audit-id-worker-mailbox-'));
    // The manager's public key travels with the mailbox (issue #149): without
    // it the child has nothing to verify an answer with and attaches no seat.
    // The seat's own bound: nobody answers, so it denies closed — still the
    // manager's decision to record, never a second child row.
    vi.stubEnv('KUBIC_APPROVALS_VERIFY_KEY', createApprovalSigner().verifyKey);
    vi.stubEnv('KUBIC_APPROVALS_BOUND_MS', '60');
    const root = tmpRoot('audit-id-worker-seat-root-');
    const workspace = tmpRoot('audit-id-worker-seat-ws-');
    const result = await runHeadlessPrompt(
      'clean up',
      {},
      {
        sessionsRoot: root,
        models: catalog([DESTRUCTIVE(), fauxAssistantMessage('done')]),
        ...hermetic(workspace),
      },
    );
    expect(result.terminus).not.toBe('completed');
    expect(
      readAuditLedger(auditLedgerDir(workspace)).filter(
        (r) => r.what === 'tool:bash',
      ),
    ).toEqual([]);
  });

  it('a plain solo run (no worker env) still records mode solo with generation 0', async () => {
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
      mode: 'solo',
      agent: { role: 'root' },
      worker: { pid: process.pid, generation: 0, role: 'root' },
    });
  });
});

describe('installSoloPolicy audit model (issues #148, #227)', () => {
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
