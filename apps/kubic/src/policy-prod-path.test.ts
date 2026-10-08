// Prod `kubic run` policy path: the shipped default installs
// permission classes + interceptors on the lane, a destructive command is
// refused and the run ends as approval_denied (exit 4; a separate
// label from approval_timed_out, which is reserved for denials whose reason
// carries the timeout marker) unless session-scoped full access was
// explicitly recorded, and doctor reports the INSTALLED policy object rather
// than a literal. Faux provider only: zero network, zero paid tokens.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeExecutionEnv } from '../../../packages/exec/src/env.js';
import { createNodeFileBridge } from '../../../packages/exec/src/file-bridge.js';
import {
  enableFullAccess,
  FileApprovalStore,
  installedPolicyPosture,
  installSoloPolicy,
  NO_ANSWER_SURFACE_REASON,
} from '../../../packages/host/src/approvals.js';
import { runDoctorCommand } from '../../../packages/host/src/doctor.js';
import {
  buildRunEnvelope,
  mapTerminusToExitCode,
} from '../../../packages/host/src/run-cli.js';
import {
  attachSession,
  createSession,
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
import { runHeadlessPrompt } from './headless-run.js';

const roots: string[] = [];

function tmpRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'kubic-policy-run-'));
  roots.push(root);
  return root;
}

// The solo no-isolation notice is pinned by solo-notice-prod.test.ts; here it
// is only stderr noise, silenced through its documented opt-out.
beforeEach(() => {
  vi.stubEnv('KUBIC_NO_NOTICE', '1');
});

afterEach(() => {
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

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
    fauxToolUse([fauxToolCall('bash', { command: 'rm -rf /tmp/x' })]),
    fauxAssistantMessage('done'),
  ]);
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

describe('prod run path: destructive call', () => {
  it('refuses with approval_denied (exit 4) — a refusal is not a timeout', async () => {
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
    // The recorded reason names the missing surface and REFUSING — nothing
    // timed out. The status (the machine-readable half of) must say denied.
    expect(result.terminus).toBe('approval_denied');
    expect(mapTerminusToExitCode(result.terminus)).toBe(4);
    // The message is unchanged by the relabel: the same refusal sentence,
    // now under an honest status.
    expect(result.summary).toMatch(/^approval refused: /);
    expect(result.summary).toContain(NO_ANSWER_SURFACE_REASON);
    expect(result.summary).toContain('(bash)');
    expect(result.error?.message).toBe(result.summary);
    const envelope = buildRunEnvelope(
      result,
      mapTerminusToExitCode(result.terminus),
    );
    expect(envelope.status).toBe('approval_denied');
    expect(envelope.exitCode).toBe(4);
    expect(envelope.ok).toBe(false);
  });

  it('keeps approval_timed_out for a denial whose reason names the bound elapsing', async () => {
    const root = tmpRoot();
    // A seat is attached but cannot answer: the service's own bound is what
    // elapses, and the recorded reason says so — the timeout label stays
    // truthful, exit 4 unchanged (pinned in both directions).
    const installed = installSoloPolicy({
      workspace: '/fake',
      maxPendingMs: 1,
      answer: async () => undefined,
    });
    const result = await runHeadlessPrompt(
      'clean the tmp dir',
      {},
      {
        sessionsRoot: root,
        models: destructiveThenDone(),
        env: new FakeExecutionEnv({}),
        policy: installed,
      },
    );
    expect(result.terminus).toBe('approval_timed_out');
    expect(mapTerminusToExitCode(result.terminus)).toBe(4);
    expect(result.summary).toMatch(/timed out/);
    const envelope = buildRunEnvelope(
      result,
      mapTerminusToExitCode(result.terminus),
    );
    expect(envelope.status).toBe('approval_timed_out');
    expect(envelope.exitCode).toBe(4);
    expect(envelope.ok).toBe(false);
  });

  it('runs it when session-scoped full access was explicitly recorded', async () => {
    const root = tmpRoot();
    const store = openSessionStore(root, createNodeFileBridge(root));
    const created = await createSession(
      store,
      { cwd: root },
      BACKGROUND_CONTEXT,
    );
    const id = created.id;
    await created.release(BACKGROUND_CONTEXT);
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

  it('runs an ordinary (non-destructive) command without an approval refusal', async () => {
    const root = tmpRoot();
    const result = await runHeadlessPrompt(
      'say hi',
      {},
      {
        sessionsRoot: root,
        models: modelsWith([
          fauxToolUse([fauxToolCall('bash', { command: 'echo hi' })]),
          fauxAssistantMessage('done'),
        ]),
        env: new FakeExecutionEnv({}),
      },
    );
    expect(result.terminus).toBe('completed');
    const transcript = await transcriptOf(root, result.sessionId);
    expect(transcript).toContain('echo hi');
    expect(transcript).not.toContain('not approved');
  });
});

describe('prod run path: second-segment outside redirect', () => {
  it('refuses a later `> /etc/...` after an inside redirect with approval_denied (exit 4)', async () => {
    const root = tmpRoot();
    const result = await runHeadlessPrompt(
      'write two files',
      {},
      {
        sessionsRoot: root,
        models: modelsWith([
          fauxToolUse([
            fauxToolCall('bash', {
              command:
                'echo a > notes.txt && echo b > /etc/cron.d/kubic-cron-probe',
            }),
          ]),
          fauxAssistantMessage('done'),
        ]),
        env: new FakeExecutionEnv({}),
      },
    );
    expect(result.terminus).toBe('approval_denied');
    expect(mapTerminusToExitCode(result.terminus)).toBe(4);
    expect(result.summary).toContain('outside-write');
  });
});

describe('prod run path: allowlist', () => {
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
          fauxToolUse([fauxToolCall('bash', { command: 'echo hi' })]),
          fauxAssistantMessage('done'),
        ]),
        env: new FakeExecutionEnv({}),
        policyClasses: installed.classes,
      },
    );
    expect(result.terminus).toBe('completed');
    const transcript = await transcriptOf(root, result.sessionId);
    // The lane refused the call and named it; the shell never ran.
    // pi-durable's own refusal text for a call the agent does not offer.
    expect(transcript).toContain('is not available');
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
          fauxToolUse([fauxToolCall('bash', { command: 'echo hi' })]),
          fauxAssistantMessage('done'),
        ]),
        env: new FakeExecutionEnv({}),
      },
    );
    expect(result.terminus).toBe('completed');
    const transcript = await transcriptOf(root, result.sessionId);
    expect(transcript).not.toContain('is not available');
    expect(transcript).toContain('echo hi');
  });

  it('the default posture is deny-by-default on network and credentials', () => {
    // The shipped default's restrictive tail is the point of
    // the default posture. Pinned as an assertion, not prose: if someone loosens the
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
          fauxToolUse([
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
    const toolResults = entriesToTranscript(
      await readSessionEntries(
        (
          await attachSession(
            openSessionStore(root, createNodeFileBridge(root)),
            result.sessionId,
            BACKGROUND_CONTEXT,
          )
        ).storage,
        BACKGROUND_CONTEXT,
      ),
    ).filter((item) => item.kind === 'tool-result');
    expect(toolResults).toHaveLength(1);
    expect(toolResults[0]?.name).toBe('bash');
    expect(toolResults[0]?.isError).toBe(true);
    expect(toolResults[0]?.text).toContain('not approved');
    expect(toolResults[0]?.text).toContain('no approval surface is installed');
    expect(mapTerminusToExitCode(result.terminus)).toBe(4);
  });
});

describe('doctor reports the installed policy', () => {
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
    const code = (
      await runDoctorCommand(
        {},
        doctorDeps(lines, () => installed.posture),
      )
    ).exitCode;
    expect(code).toBe(0);
    const printed = lines.join('\n');
    expect(printed).toContain('PASS policy:installed');
    expect(printed).toContain('filesystem=workspace-write');
    expect(printed).toContain('network=none');
    expect(printed).toContain('destructive-guard');
    expect(printed).toContain('source=default');
  });

  it('names each unsupported level instead of printing it green', async () => {
    const lines: string[] = [];
    const installed = installSoloPolicy({
      workspace: '/fake',
      classes: {
        filesystem: 'full',
        shell: true,
        network: 'allowlist',
        git: 'full',
        credentials: 'allowlist',
      },
    });
    await runDoctorCommand(
      {},
      doctorDeps(lines, () => installed.posture),
    );
    const printed = lines.join('\n');
    expect(printed).toContain('WARN policy:installed (unsupported-level)');
    expect(printed).toContain("network 'allowlist' is unsupported");
    expect(printed).toContain("credentials 'allowlist' is unsupported");
    expect(printed).toContain("filesystem 'full' is unsupported");
    expect(printed).toContain("git 'full' is unsupported");
  });

  it('fails the matrix with policy-mismatch when the installed policy contradicts itself', async () => {
    const lines: string[] = [];
    const code = (
      await runDoctorCommand(
        {},
        doctorDeps(lines, () => {
          throw new Error(
            'installed policy contradicts itself: shell disabled but bash',
          );
        }),
      )
    ).exitCode;
    expect(code).toBe(1);
    const printed = lines.join('\n');
    expect(printed).toContain('FAIL policy:installed (policy-mismatch)');
    expect(printed).toContain('contradicts itself');
  });

  it('never claims reachability for a provider that was only listed', async () => {
    const lines: string[] = [];
    await runDoctorCommand(
      {},
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
    await runDoctorCommand(
      {},
      {
        ...doctorDeps(
          lines,
          () => installSoloPolicy({ workspace: '/fake' }).posture,
        ),
        probeProviders: () => [
          { id: 'faux', reachable: true, models: ['faux-1'], dialled: true },
        ],
      },
    );
    const printed = lines.join('\n');
    expect(printed).toContain('dialled');
    expect(printed).not.toContain('not dialled');
  });
});

describe('installed policy derivation', () => {
  it('the printed posture and the installed lane policy are one object', () => {
    const input = { workspace: '/fake' };
    const installed = installSoloPolicy(input);
    expect(installed.posture).toEqual(installedPolicyPosture(input));
    expect(installed.classes).toEqual(installed.posture.classes);
    expect(installed.posture.allowlist.length).toBeGreaterThan(0);
  });

  it('derives an empty allowlist from all-closed classes without refusing it', () => {
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
