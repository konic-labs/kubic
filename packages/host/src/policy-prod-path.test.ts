// Prod `kubic run` policy path (issue #86): the shipped default installs
// permission classes + interceptors on the lane, a destructive command is
// refused and the run ends as approval_timed_out (exit 4) unless
// session-scoped full access was explicitly recorded, and doctor reports the
// INSTALLED policy object rather than a literal. Faux provider only: zero
// network, zero paid tokens.

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runHeadlessPrompt } from '../../../apps/kubic/src/headless-run.js';
import { FakeExecutionEnv } from '../../exec/src/env.js';
import { createNodeFileBridge } from '../../exec/src/file-bridge.js';
import {
  attachSession,
  createSession,
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
import {
  enableFullAccess,
  FileApprovalStore,
  installedPolicyPosture,
  installSoloPolicy,
} from './approvals.js';
import { runDoctorCommand } from './doctor.js';
import { mapTerminusToExitCode } from './run-cli.js';

function tmpRoot(): string {
  return mkdtempSync(join(tmpdir(), 'kubic-86-run-'));
}

function modelsWith(
  steps: ReturnType<typeof fauxAssistantMessage>[],
): MutableModels {
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  faux.setResponses(steps);
  return models;
}

function destructiveThenDone(): MutableModels {
  return modelsWith([
    fauxAssistantMessage([fauxToolCall('bash', { command: 'rm -rf /tmp/x' })]),
    fauxAssistantMessage('done'),
  ]);
}

async function transcriptOf(root: string, sessionId: string): Promise<string> {
  const store = openSessionStore(root, createNodeFileBridge(root));
  const reopened = await attachSession(store, sessionId, BACKGROUND_CONTEXT);
  try {
    return JSON.stringify(
      await reopened.findEntries(undefined, BACKGROUND_CONTEXT),
    );
  } finally {
    await reopened.close(BACKGROUND_CONTEXT);
  }
}

describe('prod run path: destructive call (issue #86, criterion 2)', () => {
  it('suspends to approval_timed_out (exit 4) on the shipped default', async () => {
    const root = tmpRoot();
    const result = await runHeadlessPrompt(
      'clean the tmp dir',
      {},
      {
        sessionsRoot: root,
        models: destructiveThenDone(),
        env: new FakeExecutionEnv({}),
      },
    );
    expect(result.terminus).toBe('approval_timed_out');
    expect(mapTerminusToExitCode(result.terminus)).toBe(4);
    expect(result.error?.message).toMatch(/approval/i);
  });

  it('runs it when session-scoped full access was explicitly recorded', async () => {
    const root = tmpRoot();
    const store = openSessionStore(root, createNodeFileBridge(root));
    const created = await createSession(store, root, BACKGROUND_CONTEXT);
    const id = created.metadata.id;
    await created.close(BACKGROUND_CONTEXT);
    enableFullAccess(new FileApprovalStore(join(root, id)), 'test');

    const result = await runHeadlessPrompt(
      'clean the tmp dir',
      { sessionId: id },
      {
        sessionsRoot: root,
        models: destructiveThenDone(),
        env: new FakeExecutionEnv({}),
      },
    );
    expect(result.terminus).toBe('completed');
    expect(mapTerminusToExitCode(result.terminus)).toBe(0);
    // The refusal reason is nowhere in the transcript: the call really ran.
    expect(await transcriptOf(root, id)).not.toContain('no approval surface');
  });

  it('leaves an ordinary (non-destructive) command unapproved-path-free', async () => {
    const root = tmpRoot();
    const result = await runHeadlessPrompt(
      'say hi',
      {},
      {
        sessionsRoot: root,
        models: modelsWith([
          fauxAssistantMessage([fauxToolCall('bash', { command: 'echo hi' })]),
          fauxAssistantMessage('done'),
        ]),
        env: new FakeExecutionEnv({}),
      },
    );
    expect(result.terminus).toBe('completed');
  });
});

describe('prod run path: allowlist (issue #86, criterion 3)', () => {
  it('refuses a tool outside the allowlist at execute time, not merely silently', async () => {
    const root = tmpRoot();
    // shell:false removes bash from the class-derived allowlist.
    const installed = installSoloPolicy({
      workspace: '/',
      classes: {
        ...installedPolicyPosture({ workspace: '/' }).classes,
        shell: false,
      },
    });
    const result = await runHeadlessPrompt(
      'call bash',
      {},
      {
        sessionsRoot: root,
        models: modelsWith([
          fauxAssistantMessage([fauxToolCall('bash', { command: 'echo hi' })]),
          fauxAssistantMessage('done'),
        ]),
        env: new FakeExecutionEnv({}),
        policyClasses: installed.classes,
      },
    );
    expect(result.terminus).toBe('completed');
    const transcript = await transcriptOf(root, result.sessionId);
    // The lane refused the call and named it; the shell never ran.
    expect(transcript).toContain('is unavailable');
    expect(transcript).toContain('bash');
    expect(transcript).not.toContain('"stdout":"hi');
  });

  it('serves the same tool when the allowlist covers it (control)', async () => {
    const root = tmpRoot();
    const result = await runHeadlessPrompt(
      'call echo',
      {},
      {
        sessionsRoot: root,
        models: modelsWith([
          fauxAssistantMessage([fauxToolCall('bash', { command: 'echo hi' })]),
          fauxAssistantMessage('done'),
        ]),
        env: new FakeExecutionEnv({}),
      },
    );
    expect(result.terminus).toBe('completed');
    const transcript = await transcriptOf(root, result.sessionId);
    expect(transcript).not.toContain('is unavailable');
    expect(transcript).toContain('echo hi');
  });

  it('the default posture is deny-by-default on network and credentials', () => {
    // §40.3 / §59.1: the shipped default's restrictive tail is the point of
    // the issue. Pinned as an assertion, not prose: if someone loosens the
    // default to make a test pass, this fails.
    const posture = installedPolicyPosture({ workspace: '/tmp/x' });
    expect(posture.source).toBe('default');
    expect(posture.classes.network).toBe('none');
    expect(posture.classes.credentials).toBe('none');
    expect(posture.classes.filesystem).toBe('workspace-write');
    // Allowlisting is the tool-level half: the derived list is non-empty but
    // it is a CLOSED set — every name must come from the class derivation.
    expect(posture.allowlist).toContain('bash');
    expect(posture.allowlist).toContain('read');
    expect(posture.allowlist).not.toContain('*');
  });

  it('a network command is refused under the default (network=none)', async () => {
    const root = tmpRoot();
    const result = await runHeadlessPrompt(
      'fetch something',
      {},
      {
        sessionsRoot: root,
        models: modelsWith([
          fauxAssistantMessage([
            fauxToolCall('bash', { command: 'curl https://example.com' }),
          ]),
          fauxAssistantMessage('done'),
        ]),
        env: new FakeExecutionEnv({}),
      },
    );
    // The network guard blocks it; no surface can approve a network
    // capability either, so the run reports the refused approval (exit 4)
    // rather than claiming a success that reached the network. The refusal is
    // the toolResult — the call was never executed, so no curl output exists.
    const transcript = await transcriptOf(root, result.sessionId);
    const entries = JSON.parse(transcript) as {
      type?: string;
      message?: {
        role?: string;
        toolName?: string;
        isError?: boolean;
        content?: { type: string; text?: string }[];
      };
    }[];
    const toolResults = entries.filter(
      (entry) => entry.message?.role === 'toolResult',
    );
    expect(toolResults).toHaveLength(1);
    expect(toolResults[0]?.message?.toolName).toBe('bash');
    expect(toolResults[0]?.message?.isError).toBe(true);
    expect(toolResults[0]?.message?.content?.[0]?.text).toContain(
      'not approved',
    );
    expect(toolResults[0]?.message?.content?.[0]?.text).toContain(
      'no approval surface is installed',
    );
    expect(mapTerminusToExitCode(result.terminus)).toBe(4);
  });
});

describe('doctor reports the installed policy (issue #86, criteria 4-5)', () => {
  function doctorDeps(
    lines: string[],
    installed: () => ReturnType<typeof installedPolicyPosture>,
  ) {
    return {
      out: (line: string) => lines.push(line),
      probeProviders: () => [
        { id: 'faux', reachable: true, models: ['faux-1'], dialled: false },
      ],
      checkDeps: () => [{ id: 'node', ok: true, detail: 'test runtime' }],
      loadPolicy: () => ({ route: 'ask-user', autoApprove: [] }),
      installedPolicy: installed,
    };
  }

  it('prints the installed classes, guards, and source', async () => {
    const lines: string[] = [];
    const installed = installSoloPolicy({ workspace: '/fake' });
    const code = await runDoctorCommand(
      [],
      doctorDeps(lines, () => installed.posture),
    );
    expect(code).toBe(0);
    const printed = lines.join('\n');
    expect(printed).toContain('PASS policy:installed');
    expect(printed).toContain('filesystem=workspace-write');
    expect(printed).toContain('network=none');
    expect(printed).toContain('destructive-guard');
    expect(printed).toContain('source=default');
  });

  it('fails the matrix with policy-mismatch when the installed policy contradicts itself', async () => {
    const lines: string[] = [];
    const code = await runDoctorCommand(
      [],
      doctorDeps(lines, () => {
        throw new Error(
          'installed policy contradicts itself: shell disabled but bash',
        );
      }),
    );
    expect(code).toBe(1);
    const printed = lines.join('\n');
    expect(printed).toContain('FAIL policy:installed (policy-mismatch)');
    expect(printed).toContain('contradicts itself');
  });

  it('never claims reachability for a provider that was only listed', async () => {
    const lines: string[] = [];
    await runDoctorCommand(
      [],
      doctorDeps(
        lines,
        () => installSoloPolicy({ workspace: '/fake' }).posture,
      ),
    );
    const printed = lines.join('\n');
    expect(printed).toContain('PASS provider:faux');
    expect(printed).toContain('listed');
    expect(printed).toContain('not dialled');
    expect(printed).not.toMatch(/\breachable\b/i);
  });

  it('states plainly when a provider line came from a real dial', async () => {
    const lines: string[] = [];
    await runDoctorCommand([], {
      ...doctorDeps(
        lines,
        () => installSoloPolicy({ workspace: '/fake' }).posture,
      ),
      probeProviders: () => [
        { id: 'faux', reachable: true, models: ['faux-1'], dialled: true },
      ],
    });
    const printed = lines.join('\n');
    expect(printed).toContain('dialled');
    expect(printed).not.toContain('not dialled');
  });
});

describe('installed policy derivation (issue #86, §40.3 agreement)', () => {
  it('the printed posture and the installed lane policy are one object', () => {
    const input = { workspace: '/fake' };
    const installed = installSoloPolicy(input);
    expect(installed.posture).toEqual(installedPolicyPosture(input));
    expect(installed.classes).toEqual(installed.posture.classes);
    expect(installed.posture.allowlist.length).toBeGreaterThan(0);
  });

  it('refuses a contradictory pair by name instead of installing it', () => {
    // shell:false still yields a valid allowlist (bash simply absent), so the
    // derivation must NOT throw on the restrictive side — the contradiction
    // case is an allowlist that contradicts its classes, which
    // checkAgreement names. Pin the honest direction: refusal, never silence.
    const posture = installedPolicyPosture({
      workspace: '/fake',
      classes: {
        filesystem: 'none',
        shell: false,
        network: 'none',
        git: false,
        credentials: 'none',
      },
    });
    expect(posture.allowlist).toEqual([]);
    expect(posture.interceptors).toContain('approval');
  });
});
