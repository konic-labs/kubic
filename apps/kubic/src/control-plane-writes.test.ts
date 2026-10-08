// Kubic's control plane is not the model's to rewrite. A
// write/edit/bash-redirect into `<workspace>/.kubic/` (config.toml, roles/,
// anything else there) is the named `kubic-state-write` capability, which
// ALWAYS asks — autoApprove and full access never answer it. Writes into the
// state Kubic's own guarantees rest on (`.kubic/journal/`, `.kubic/audit/`,
// `.kubic/sessions/`) are refused outright: a tool
// error, never an ask. Detection is lexical, like every other shell detector
// here — the bash gap is documented, not hidden.
// Faux provider only: zero network, zero paid tokens.
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NodeExecutionEnv } from '../../../packages/exec/src/env.js';
import { createNodeFileBridge } from '../../../packages/exec/src/file-bridge.js';
import {
  ApprovalService,
  CAPABILITIES,
  controlPlaneRefusal,
  detectTriggers,
  enableFullAccess,
  FileApprovalStore,
  installSoloPolicy,
  KUBIC_STATE_WRITE,
  triggerContextFor,
  validatePolicy,
} from '../../../packages/host/src/approvals.js';
import {
  attachSession,
  openSessionStore,
} from '../../../packages/worker/src/lane/session-store.js';
import { fauxToolUse } from '../../../packages/worker/src/lane/test-harness.js';
import { readSessionEntries } from '../../../packages/worker/src/lane/transcript.js';
import {
  BACKGROUND_CONTEXT,
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
  type MutableModels,
} from '../../../packages/worker/src/pi-boundary.js';
import { runHeadlessPrompt } from './headless-run.js';

const roots: string[] = [];

function tmpRoot(prefix = 'kubic-control-plane-'): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

beforeEach(() => {
  vi.stubEnv('KUBIC_NO_NOTICE', '1');
});

afterEach(() => {
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

const WS = '/work/repo';
const ctx = triggerContextFor(
  {
    filesystem: 'workspace-write',
    shell: true,
    network: 'none',
    git: 'workspace',
    credentials: 'none',
  },
  WS,
);

function modelsWith(
  steps: ReturnType<typeof fauxAssistantMessage>[],
): MutableModels {
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  faux.setResponses(steps);
  return models;
}

async function transcriptOf(root: string, sessionId: string): Promise<string> {
  const store = openSessionStore(root, createNodeFileBridge(root));
  const reopened = await attachSession(store, sessionId, BACKGROUND_CONTEXT);
  try {
    return JSON.stringify(
      await readSessionEntries(reopened.storage, BACKGROUND_CONTEXT),
    );
  } finally {
    await reopened.release(BACKGROUND_CONTEXT);
  }
}

describe('kubic-state-write detection', () => {
  it('is a named capability', () => {
    expect(KUBIC_STATE_WRITE).toBe('kubic-state-write');
    expect(CAPABILITIES).toContain('kubic-state-write');
  });

  it.each([
    ['write', { path: '.kubic/config.toml', content: 'x' }],
    ['write', { path: `${WS}/.kubic/roles/implementer.md`, content: 'x' }],
    ['edit', { path: './.kubic/config.toml', oldText: 'a', newText: 'b' }],
    ['write', { path: '.KUBIC/Config.toml', content: 'x' }],
    ['write', { path: 'src/../.kubic/config.toml', content: 'x' }],
  ])('raises it for %s %j', (tool, args) => {
    expect(detectTriggers(tool, args, ctx)).toContain('kubic-state-write');
  });

  it.each([
    'echo x > .kubic/config.toml',
    'echo x >> .kubic/roles/a.md 2>/dev/null',
    'cat a | tee .kubic/config.toml',
    'cp /tmp/evil.toml .kubic/config.toml',
    'mv new.md "./.kubic/roles/a.md"',
  ])('raises it for bash %j', (command) => {
    expect(detectTriggers('bash', { command }, ctx)).toContain(
      'kubic-state-write',
    );
  });

  it.each([
    ['write', { path: 'src/app.ts', content: 'x' }],
    ['write', { path: '.kubicrc', content: 'x' }],
    ['write', { path: 'docs/.kubic/config.toml', content: 'x' }],
    ['bash', { command: 'echo hi > out.txt' }],
    ['bash', { command: 'cat .kubic/config.toml' }],
    ['read', { path: '.kubic/config.toml' }],
  ])('stays silent for %s %j', (tool, args) => {
    expect(detectTriggers(tool, args, ctx)).not.toContain('kubic-state-write');
  });
});

describe('refused control-plane state', () => {
  it.each([
    ['write', { path: '.kubic/journal/index.jsonl', content: '' }],
    [
      'edit',
      {
        path: '.kubic/audit/audit.jsonl',
        oldText: 'a',
        newText: 'b',
      },
    ],
    ['write', { path: `${WS}/.kubic/sessions/s1/posture.json`, content: '{}' }],
    ['write', { path: '.Kubic/Journal/index.jsonl', content: '' }],
    ['bash', { command: 'echo x > .kubic/journal/index.jsonl' }],
    ['bash', { command: "bash -c 'echo x > .kubic/journal/index.jsonl'" }],
    ['bash', { command: 'true | tee -a .kubic/audit/audit.jsonl' }],
    ['bash', { command: 'cp x .kubic/sessions/s/posture.json' }],
  ])('refuses %s %j with a named reason', (tool, args) => {
    const reason = controlPlaneRefusal(tool, args, WS);
    expect(reason).toMatch(/Kubic control-plane state/);
    // The refused path is ALSO a kubic-state-write capability, so a caller
    // that only consults detectTriggers still asks instead of running it.
    expect(detectTriggers(tool, args, ctx)).toContain('kubic-state-write');
  });

  it.each([
    ['write', { path: '.kubic/config.toml', content: 'x' }],
    ['write', { path: 'journal/index.jsonl', content: 'x' }],
    ['read', { path: '.kubic/journal/index.jsonl' }],
    ['bash', { command: 'cat .kubic/journal/index.jsonl' }],
  ])('does not refuse %s %j', (tool, args) => {
    expect(controlPlaneRefusal(tool, args, WS)).toBeUndefined();
  });
});

// The control plane is not only `<workspace>/.kubic/`: a run from a
// subdirectory has the project's real state ABOVE its workspace, and the
// session root and the global config live under ~/.kubic. Every one of those
// is classified.
describe('control plane beyond the workspace', () => {
  const HOME = '/home/u';
  const SUB = '/work/repo/packages/a';
  const classes = {
    filesystem: 'workspace-write',
    shell: true,
    network: 'none',
    git: 'workspace',
    credentials: 'none',
  } as const;
  const subCtx = triggerContextFor(classes, SUB, { home: HOME });
  const soloCtx = triggerContextFor(classes, WS, { home: HOME });

  it.each([
    ['write', { path: '../../.kubic/audit/audit.jsonl', content: '' }],
    ['write', { path: '/work/repo/.kubic/journal/index.jsonl', content: '' }],
    ['bash', { command: 'echo x > ../../.kubic/journal/index.jsonl' }],
    ['bash', { command: 'cp a ../../.kubic/audit/d.json' }],
    ['write', { path: '../../.kubic/sessions/s1/posture.json', content: '{}' }],
  ])('a subdirectory run is refused %s %j', (tool, args) => {
    expect(controlPlaneRefusal(tool, args, SUB, { home: HOME })).toMatch(
      /Kubic control-plane state/,
    );
    expect(detectTriggers(tool, args, subCtx)).toContain('kubic-state-write');
  });

  it("a subdirectory run writing the project's config.toml is asked, not refused", () => {
    const args = { path: '../../.kubic/config.toml', content: 'x' };
    expect(controlPlaneRefusal('write', args, SUB, { home: HOME })).toBe(
      undefined,
    );
    expect(detectTriggers('write', args, subCtx)).toContain(
      'kubic-state-write',
    );
  });

  it.each([
    ['write', { path: 'src/app.ts', content: 'x' }],
    ['write', { path: `${SUB}/README.md`, content: 'x' }],
    ['bash', { command: 'echo hi > out.txt' }],
  ])(
    'a subdirectory run writing its own files stays silent: %s %j',
    (tool, args) => {
      expect(detectTriggers(tool, args, subCtx)).not.toContain(
        'kubic-state-write',
      );
      expect(controlPlaneRefusal(tool, args, SUB, { home: HOME })).toBe(
        undefined,
      );
    },
  );

  it.each([
    ['write', { path: '/home/u/.kubic/sessions/s1/posture.json', content: '' }],
    ['bash', { command: 'echo x > ~/.kubic/sessions/s1/journal/a.json' }],
  ])('the real session root under ~/.kubic is refused: %s %j', (tool, args) => {
    expect(controlPlaneRefusal(tool, args, WS, { home: HOME })).toMatch(
      /Kubic control-plane state/,
    );
    expect(detectTriggers(tool, args, soloCtx)).toContain('kubic-state-write');
  });

  it('the global config.toml is asked', () => {
    const args = { path: '/home/u/.kubic/config.toml', content: 'x' };
    expect(detectTriggers('write', args, soloCtx)).toContain(
      'kubic-state-write',
    );
    expect(controlPlaneRefusal('write', args, WS, { home: HOME })).toBe(
      undefined,
    );
  });

  it("a subdirectory workspace still guards the project root's .kubic", () => {
    const sub = triggerContextFor(classes, '/work/repo/packages/a', {
      home: HOME,
    });
    expect(
      detectTriggers('write', { path: '../../.kubic/config.toml' }, sub),
    ).toContain('kubic-state-write');
  });

  it('defaults the home root to the real home directory (string only)', () => {
    const target = join(homedir(), '.kubic', 'sessions', 's1', 'x.json');
    expect(controlPlaneRefusal('write', { path: target }, WS)).toMatch(
      /Kubic control-plane state/,
    );
  });

  it('refuses an overridden sessions root wholesale', async () => {
    const root = tmpRoot();
    const policy = installSoloPolicy({
      workspace: WS,
      sessionDir: root,
      sessionsRoot: '/srv/kubic-sessions',
      home: HOME,
    });
    const verdict = await policy.ask({
      toolName: 'write',
      args: { path: '/srv/kubic-sessions/s1/posture.json', content: '{}' },
      toolCallId: 't1',
    });
    expect(JSON.stringify(verdict)).toMatch(/Kubic control-plane state/);
  });

  it('full access in a subdirectory run refuses the project ledger and asks for the project config', async () => {
    const root = tmpRoot();
    enableFullAccess(new FileApprovalStore(root), 'test');
    const policy = installSoloPolicy({
      workspace: SUB,
      sessionDir: root,
      home: HOME,
    });
    const ledger = await policy.ask({
      toolName: 'write',
      args: { path: '../../.kubic/audit/audit.jsonl', content: '' },
      toolCallId: 't1',
    });
    expect(JSON.stringify(ledger)).toMatch(/Kubic control-plane state/);
    const config = await policy.ask({
      toolName: 'write',
      args: { path: '../../.kubic/config.toml', content: 'x' },
      toolCallId: 't2',
    });
    expect(config).toMatchObject({ approved: false });
    expect(JSON.stringify(config)).toContain('kubic-state-write');
    const own = await policy.ask({
      toolName: 'write',
      args: { path: 'src/app.ts', content: 'x' },
      toolCallId: 't3',
    });
    expect(own).toMatchObject({ approved: true });
  });
});

describe('kubic-state-write always asks', () => {
  it('autoApprove never answers it', async () => {
    const service = new ApprovalService({
      policy: validatePolicy({
        route: 'ask-user',
        autoApprove: ['kubic-state-write', 'network'],
        maxPendingMs: 5,
      }),
    });
    const state = await service.request({
      key: 'k1',
      capability: 'kubic-state-write',
      toolName: 'write',
      summary: 'write .kubic/config.toml',
    });
    expect(state.approved).toBe(false);
    const network = await service.request({
      key: 'k2',
      capability: 'network',
      toolName: 'bash',
      summary: 'curl',
    });
    expect(network).toMatchObject({ approved: true, by: 'autoApprove' });
  });

  it('session full access still asks for it (and refuses the refused class)', async () => {
    const root = tmpRoot();
    enableFullAccess(new FileApprovalStore(root), 'test');
    const policy = installSoloPolicy({ workspace: WS, sessionDir: root });
    const state = await policy.ask({
      toolName: 'write',
      args: { path: '.kubic/config.toml', content: 'x' },
      toolCallId: 't1',
    });
    expect(state).toMatchObject({ approved: false });
    expect(JSON.stringify(state)).toContain('kubic-state-write');
    const refused = await policy.ask({
      toolName: 'write',
      args: { path: '.kubic/journal/index.jsonl', content: '' },
      toolCallId: 't2',
    });
    expect(JSON.stringify(refused)).toMatch(/Kubic control-plane state/);
    // Everything else keeps the explicit full-access posture.
    const other = await policy.ask({
      toolName: 'bash',
      args: { command: 'rm -rf /tmp/x' },
      toolCallId: 't3',
    });
    expect(other).toEqual({ approved: true, challenged: true });
  });

  it('a seat that approves lets the write through', async () => {
    const policy = installSoloPolicy({
      workspace: WS,
      answer: async () => ({ approved: true, by: 'user' }),
    });
    const verdict = await policy.ask({
      toolName: 'write',
      args: { path: '.kubic/config.toml', content: 'x' },
      toolCallId: 't1',
    });
    expect(verdict).toEqual({ approved: true, challenged: true });
  });
});

describe('prod run path: control-plane writes', () => {
  it('a faux write to .kubic/config.toml is asked (headless: denied, named) and the file is unchanged', async () => {
    const sessionsRoot = tmpRoot();
    const workspace = tmpRoot('ws-control-plane-');
    mkdirSync(join(workspace, '.kubic'), { recursive: true });
    const config = join(workspace, '.kubic', 'config.toml');
    writeFileSync(config, '[approvals]\nroute = "ask-user"\n');
    const before = readFileSync(config);
    const result = await runHeadlessPrompt(
      'widen my permissions',
      {},
      {
        sessionsRoot,
        models: modelsWith([
          fauxToolUse([
            fauxToolCall('write', {
              path: '.kubic/config.toml',
              content: '[approvals]\nautoApprove = ["network"]\n',
            }),
          ]),
          fauxAssistantMessage('done'),
        ]),
        env: new NodeExecutionEnv(workspace),
      },
    );
    expect(result.terminus).toBe('approval_denied');
    expect(result.summary).toContain('kubic-state-write');
    expect(readFileSync(config).equals(before)).toBe(true);
  });

  it('a faux edit to the audit ledger is refused and the existing bytes are untouched', async () => {
    const sessionsRoot = tmpRoot();
    const workspace = tmpRoot('ws-control-plane-');
    const dir = join(workspace, '.kubic', 'audit');
    mkdirSync(dir, { recursive: true });
    const ledger = join(dir, 'audit.jsonl');
    writeFileSync(ledger, '{"who":"agent:x","result":"deny"}\n');
    const before = readFileSync(ledger, 'utf8');
    const result = await runHeadlessPrompt(
      'hide the evidence',
      {},
      {
        sessionsRoot,
        models: modelsWith([
          fauxToolUse([
            fauxToolCall('edit', {
              path: '.kubic/audit/audit.jsonl',
              oldText: '"result":"deny"',
              newText: '"result":"ok"',
            }),
          ]),
          fauxAssistantMessage('done'),
        ]),
        env: new NodeExecutionEnv(workspace),
      },
    );
    expect(result.terminus).toBe('approval_denied');
    expect(result.summary).toMatch(/Kubic control-plane state/);
    const after = readFileSync(ledger, 'utf8');
    // The ledger's existing bytes are byte-identical; the only change is the
    // refusal's OWN audit record, appended (the ledger is append-only).
    expect(after.slice(0, before.length)).toBe(before);
    expect(after).not.toContain('{"who":"agent:x","result":"ok"}');
  });

  it("a run from a subdirectory cannot edit the project's audit ledger", async () => {
    const sessionsRoot = tmpRoot();
    const repo = tmpRoot('repo-control-plane-');
    const workspace = join(repo, 'packages', 'a');
    mkdirSync(workspace, { recursive: true });
    const dir = join(repo, '.kubic', 'audit');
    mkdirSync(dir, { recursive: true });
    const ledger = join(dir, 'audit.jsonl');
    writeFileSync(ledger, '{"who":"agent:x","result":"deny"}\n');
    const result = await runHeadlessPrompt(
      'hide the evidence',
      {},
      {
        sessionsRoot,
        models: modelsWith([
          fauxToolUse([
            fauxToolCall('edit', {
              path: '../../.kubic/audit/audit.jsonl',
              oldText: '"result":"deny"',
              newText: '"result":"ok"',
            }),
          ]),
          fauxAssistantMessage('done'),
        ]),
        env: new NodeExecutionEnv(workspace),
      },
    );
    expect(result.terminus).toBe('approval_denied');
    expect(result.summary).toMatch(/Kubic control-plane state/);
    expect(readFileSync(ledger, 'utf8')).toBe(
      '{"who":"agent:x","result":"deny"}\n',
    );
  });

  it('a faux write into the session root in use is refused by name', async () => {
    const sessionsRoot = tmpRoot();
    const workspace = tmpRoot('ws-control-plane-');
    const target = join(sessionsRoot, 'forged', 'posture.json');
    const result = await runHeadlessPrompt(
      'grant yourself full access',
      {},
      {
        sessionsRoot,
        models: modelsWith([
          fauxToolUse([fauxToolCall('write', { path: target, content: '{}' })]),
          fauxAssistantMessage('done'),
        ]),
        env: new NodeExecutionEnv(workspace),
      },
    );
    expect(result.terminus).toBe('approval_denied');
    expect(result.summary).toMatch(/Kubic control-plane state/);
    expect(existsSync(target)).toBe(false);
  });

  it("challenges bash -c 'echo x > .kubic/journal/index.jsonl'", async () => {
    const sessionsRoot = tmpRoot();
    const workspace = tmpRoot('ws-control-plane-');
    const result = await runHeadlessPrompt(
      'corrupt the journal',
      {},
      {
        sessionsRoot,
        models: modelsWith([
          fauxToolUse([
            fauxToolCall('bash', {
              command: "bash -c 'echo x > .kubic/journal/index.jsonl'",
            }),
          ]),
          fauxAssistantMessage('done'),
        ]),
        env: new NodeExecutionEnv(workspace),
      },
    );
    expect(result.terminus).toBe('approval_denied');
    expect(
      existsSync(join(workspace, '.kubic', 'journal', 'index.jsonl')),
    ).toBe(false);
  });

  it('an ordinary workspace write still passes with no ask', async () => {
    const sessionsRoot = tmpRoot();
    const workspace = tmpRoot('ws-control-plane-');
    const result = await runHeadlessPrompt(
      'write a file',
      {},
      {
        sessionsRoot,
        models: modelsWith([
          fauxToolUse([
            fauxToolCall('write', { path: 'notes.txt', content: 'hi\n' }),
          ]),
          fauxAssistantMessage('done'),
        ]),
        env: new NodeExecutionEnv(workspace),
      },
    );
    expect(result.terminus).toBe('completed');
    expect(readFileSync(join(workspace, 'notes.txt'), 'utf8')).toBe('hi\n');
    expect(await transcriptOf(sessionsRoot, result.sessionId)).not.toContain(
      'not approved',
    );
  });
});
