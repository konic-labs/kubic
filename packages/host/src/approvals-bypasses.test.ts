// Bash approval-detector bypasses and autoApprove semantics found by the
// post-ship re-audit of #324, #355, #357 and #230. Each block below was
// written RED first against the shipped detectors, then fixed. The
// classifiers are the PRODUCTION ones (defaultIsDestructive, isNetworkCommand,
// confinePath) wired like triggerContextFor, and the lane tests drive the real
// installSoloPolicy — faux/no provider, zero network.
// Detection stays lexical: a variable-built path (`$D/roles/r.md` with D set
// elsewhere), a symlink, `sed -i`, a script file or an interpreter still
// reach `.kubic/` without raising — those documented limits are pinned in the
// "still-documented misses" block so a future fix is a conscious change.
// biome-ignore-all lint/suspicious/noTemplateCurlyInString: `${HOME}` here is bash syntax under test, not a template literal
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runHeadlessPrompt } from '../../../apps/kubic/src/headless-run.js';
import { NodeExecutionEnv } from '../../exec/src/env.js';
import {
  confinePath,
  defaultIsDestructive,
  isNetworkCommand,
} from '../../worker/src/lane/interceptors.js';
import {
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
  type MutableModels,
} from '../../worker/src/pi-boundary.js';
import {
  type ApprovalRequest,
  ApprovalService,
  controlPlaneRefusal,
  detectTriggers,
  enableFullAccess,
  FileApprovalStore,
  installSoloPolicy,
  KUBIC_STATE_WRITE,
  NO_ANSWER_SURFACE_REASON,
  type TriggerContext,
  validatePolicy,
} from './approvals.js';
import {
  effectiveConfigView,
  loadRuntimeConfig,
  renderEffectiveConfig,
} from './config/runtime.js';
import type { DoctorDeps } from './doctor.js';
import { runDoctorCommand } from './doctor.js';
import { policyEnforceabilityCheck } from './limits/doctor-limits.js';

const WS = '/work';
const HOME = '/home/tester';

const made: string[] = [];

function mkTmp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  made.push(dir);
  return dir;
}

afterEach(() => {
  vi.unstubAllEnvs();
  for (const dir of made.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

function ctx(overrides: Partial<TriggerContext> = {}): TriggerContext {
  return {
    workspace: WS,
    network: 'none',
    isDestructive: defaultIsDestructive,
    isNetworkCommand,
    isOutsideWorkspace: (path: string) => confinePath(WS, path).rewritten,
    home: HOME,
    controlPlane: { home: HOME },
    ...overrides,
  };
}

function triggers(command: string, overrides: Partial<TriggerContext> = {}) {
  return detectTriggers('bash', { command }, ctx(overrides));
}

function refusal(command: string): string | undefined {
  return controlPlaneRefusal('bash', { command }, WS, { home: HOME });
}

describe('control-plane detector: cd tracking (issue #324)', () => {
  it.each([
    [
      'cd into .kubic/roles then redirect',
      'cd .kubic/roles && echo pwned > r.md',
    ],
    ['pushd into .kubic/roles', 'pushd .kubic/roles && echo pwned > r.md'],
    [
      'absolute cd into the state dir',
      'cd /work/.kubic && echo x > config.toml',
    ],
    [
      'cd with a quoted, quote-split argument',
      'cd ".kubic"/roles && echo x > r.md',
    ],
    ['a brace group', '{ cd .kubic; echo x > config.toml; }'],
    ['a tee target after cd', 'cd .kubic && echo x | tee config.toml'],
    ['a cp destination after cd', 'cd .kubic && cp /tmp/a config.toml'],
    ['an fd-prefixed redirect after cd', 'cd .kubic && echo x 2> config.toml'],
    [
      'cd .. climbing back into .kubic',
      'cd src && cd ../.kubic && echo x > config.toml',
    ],
  ])('%s raises kubic-state-write', (_name, command) => {
    expect(triggers(command)).toContain(KUBIC_STATE_WRITE);
  });

  it('a cd into the journal makes a plain redirect a refusal, naming the resolved path', () => {
    const message = refusal('cd .kubic/journal && echo x > index.jsonl');
    expect(message).toContain('/work/.kubic/journal/index.jsonl');
    expect(message).toContain('control-plane state');
  });

  it('reads and flags inside the state dir are not writes (fd duplications, rm flags)', () => {
    for (const command of [
      'cd .kubic && cat config.toml 2>&1',
      'cd .kubic && cat config.toml >&2',
      'cd .kubic && cat config.toml >&-',
      'cd .kubic && rm -f ../src/a.ts',
      'cd .kubic && rm -rf -- ../build',
    ]) {
      expect(triggers(command), command).not.toContain(KUBIC_STATE_WRITE);
    }
  });

  it('the state dir is left again by a later cd: only the cwd at the redirect counts', () => {
    expect(
      triggers('cd .kubic/roles && cd ../.. && echo x > r.md'),
    ).not.toContain(KUBIC_STATE_WRITE);
    expect(
      triggers('cd .kubic && cd .. && echo x > config.toml'),
    ).not.toContain(KUBIC_STATE_WRITE);
    expect(triggers('cd src && echo x > r.md')).not.toContain(
      KUBIC_STATE_WRITE,
    );
  });

  it('a redirect BEFORE the cd is resolved against the workspace, not the later cd', () => {
    expect(triggers('echo x > config.toml && cd .kubic')).not.toContain(
      KUBIC_STATE_WRITE,
    );
  });

  it('a home-relative cd resolves against the home directory, not fail-open', () => {
    expect(triggers('cd ~/.kubic && echo x > config.toml')).toContain(
      KUBIC_STATE_WRITE,
    );
    expect(triggers('cd $HOME/.kubic && echo x > config.toml')).toContain(
      KUBIC_STATE_WRITE,
    );
    expect(triggers('cd ${HOME}/.kubic && echo x > config.toml')).toContain(
      KUBIC_STATE_WRITE,
    );
    expect(triggers('cd ~ && echo x > .kubic/config.toml')).toContain(
      KUBIC_STATE_WRITE,
    );
    expect(triggers('cd ~ && echo x > notes.md')).not.toContain(
      KUBIC_STATE_WRITE,
    );
  });

  it('an unknown cd leaves a relative target with a .kubic segment fail-closed', () => {
    expect(triggers('cd $X && echo x > .kubic/config.toml')).toContain(
      KUBIC_STATE_WRITE,
    );
    expect(triggers('cd $X && echo x > a/.KUBIC/roles/r.md')).toContain(
      KUBIC_STATE_WRITE,
    );
    expect(triggers('cd $X && echo x > notes.md')).not.toContain(
      KUBIC_STATE_WRITE,
    );
    // The journal is refused outright even from an unknown cwd: an agent has
    // no business in ANY .kubic/journal, so fail-closed costs nothing.
    expect(refusal('cd $X && echo x > .kubic/journal/index.jsonl')).toContain(
      'control-plane state',
    );
  });
});

describe('control-plane detector: redirect forms (issue #324)', () => {
  it.each([
    ['>&', 'echo x >& .kubic/roles/r.md'],
    ['>& without a space', 'echo x >&.kubic/roles/r.md'],
    ['2>&', 'echo x 2>& .kubic/roles/r.md'],
    ['&>', 'echo x &> .kubic/roles/r.md'],
    ['&>>', 'echo x &>> .kubic/roles/r.md'],
    ['>|', 'echo x >| .kubic/roles/r.md'],
    ['>>', 'echo x >> .kubic/roles/r.md'],
  ])('%s into .kubic raises kubic-state-write', (_form, command) => {
    expect(triggers(command)).toContain(KUBIC_STATE_WRITE);
  });

  it('a >& into the journal is refused like any other redirect', () => {
    expect(refusal('echo x >& .kubic/journal/index.jsonl')).toContain(
      'control-plane state',
    );
    expect(
      refusal('echo x &>> .kubic/orchestrator/approvals/audit.jsonl'),
    ).toContain('control-plane state');
  });

  it('fd duplications are not file targets', () => {
    for (const command of [
      'make 2>&1',
      'make >&2',
      'make >&-',
      'make 2>&1 | tee build.log',
      'make >&2 && echo done > notes.md',
    ]) {
      expect(triggers(command)).not.toContain(KUBIC_STATE_WRITE);
    }
  });

  it('a >& target that is not an fd names a file, digit-prefixed names included', () => {
    expect(triggers('make >&2x')).not.toContain(KUBIC_STATE_WRITE);
    expect(triggers('make >&2x/../.kubic/config.toml')).toContain(
      KUBIC_STATE_WRITE,
    );
  });
});

describe('control-plane detector: quote-split and escaped segments (issue #324)', () => {
  it.each([
    ['quoted first segment', 'echo x > ".kubic"/roles/r.md'],
    ['single-quoted first segment', "echo x > '.kubic'/roles/r.md"],
    ['quote inside the segment', 'echo x > .k"ub"ic/roles/r.md'],
    ['quoted middle segment', 'echo x > .kubic/"roles"/r.md'],
    ['backslash-escaped dot', 'echo x > \\.kubic/roles/r.md'],
    ['backslash inside the segment', 'echo x > .kubic/ro\\les/r.md'],
    ['fully quoted (already handled)', 'echo x > ".kubic/roles/r.md"'],
    ['quote-split tee target', 'echo x | tee ".kubic"/config.toml'],
    ['quote-split cp destination', 'cp /tmp/a ".kubic"/config.toml'],
  ])('%s raises kubic-state-write', (_name, command) => {
    expect(triggers(command)).toContain(KUBIC_STATE_WRITE);
  });

  it('a quote-split journal path is refused', () => {
    expect(refusal('echo x > ".kubic"/journal/index.jsonl')).toBe(
      'refused: .kubic/journal/index.jsonl is Kubic control-plane state (.kubic/journal, .kubic/orchestrator, .kubic/sessions) — agents may not write it',
    );
    expect(refusal("echo x > .kub'ic'/sessions/s.jsonl")).toContain(
      'control-plane state',
    );
  });

  it('a quote-split path that is not the state dir stays quiet', () => {
    expect(triggers('echo x > ".notkubic"/roles/r.md')).not.toContain(
      KUBIC_STATE_WRITE,
    );
    expect(triggers('echo x > "src"/r.md')).not.toContain(KUBIC_STATE_WRITE);
  });
});

describe('control-plane detector: rm and mv operands (issue #324)', () => {
  it('deleting or moving the journal is tampering: refused', () => {
    for (const command of [
      'rm .kubic/journal/index.jsonl',
      'rm -rf .kubic/journal',
      'rm -f -- .kubic/journal/index.jsonl',
      'mv .kubic/journal /tmp/j',
      'mv -f .kubic/journal/index.jsonl /tmp/j.jsonl',
      'cd .kubic && rm journal/index.jsonl',
      'echo a && rm .kubic/orchestrator/approvals/audit.jsonl',
      'rm ".kubic"/journal/index.jsonl',
    ]) {
      expect(refusal(command), command).toContain('control-plane state');
    }
  });

  it('removing or moving other control-plane state asks', () => {
    for (const command of [
      'rm .kubic/roles/r.md',
      'rm -rf .kubic',
      'mv .kubic/config.toml /tmp/config.toml',
      'mv .kubic/roles/a.md .kubic/roles/b.md',
    ]) {
      expect(triggers(command), command).toContain(KUBIC_STATE_WRITE);
      expect(refusal(command), command).toBeUndefined();
    }
  });

  it('operands outside the control plane, and reads by cp, stay quiet', () => {
    for (const command of [
      'rm src/a.ts',
      'rm -rf build',
      'mv a.ts b.ts',
      'cp .kubic/config.toml backup.toml',
      'rm --force notes.md',
    ]) {
      expect(triggers(command), command).not.toContain(KUBIC_STATE_WRITE);
    }
  });
});

describe('control-plane detector: $HOME expands like ~ (issue #324)', () => {
  it.each([
    ['$HOME', 'echo x > $HOME/.kubic/config.toml'],
    ['${HOME}', 'echo x > ${HOME}/.kubic/config.toml'],
    ['~', 'echo x > ~/.kubic/config.toml'],
    ['quoted $HOME', 'echo x > "$HOME/.kubic/config.toml"'],
    ['tee $HOME', 'echo x | tee $HOME/.kubic/config.toml'],
    ['cp to ${HOME}', 'cp /tmp/a ${HOME}/.kubic/config.toml'],
  ])(
    '%s into ~/.kubic raises kubic-state-write and outside-write',
    (_name, command) => {
      const found = triggers(command);
      expect(found).toContain(KUBIC_STATE_WRITE);
      expect(found).toContain('outside-write');
    },
  );

  it('a home-relative target after a cd is still the home directory', () => {
    expect(triggers('cd src && echo x > $HOME/.kubic/config.toml')).toContain(
      KUBIC_STATE_WRITE,
    );
    expect(triggers('cd src && echo x > ~/.kubic/config.toml')).toContain(
      KUBIC_STATE_WRITE,
    );
    expect(triggers('cd .kubic && echo x > $HOME/notes.md')).not.toContain(
      KUBIC_STATE_WRITE,
    );
    expect(triggers('cd src && echo x > /work/.kubic/config.toml')).toContain(
      KUBIC_STATE_WRITE,
    );
  });

  it('the refused subtrees under $HOME are refused', () => {
    expect(refusal('echo x > $HOME/.kubic/journal/index.jsonl')).toContain(
      'control-plane state',
    );
    expect(refusal('echo x > ${HOME}/.kubic/sessions/s.jsonl')).toContain(
      'control-plane state',
    );
  });

  it('other variables and paths that merely start with the letters do not match', () => {
    expect(triggers('echo x > $HOMEDIR/.kubic/config.toml')).not.toContain(
      KUBIC_STATE_WRITE,
    );
    expect(triggers('echo x > $HOME2/.kubic/config.toml')).not.toContain(
      KUBIC_STATE_WRITE,
    );
    expect(triggers('echo x > ${HOMES}/.kubic/config.toml')).not.toContain(
      KUBIC_STATE_WRITE,
    );
    expect(triggers('echo x > $HOME/notes.md')).not.toContain(
      KUBIC_STATE_WRITE,
    );
  });

  it('a variable merely containing $HOME, or a user home, is not the home directory', () => {
    // Only distinguishable when the injected home IS a state dir.
    const stateHome = { controlPlane: { home: '/work/.kubic' } };
    expect(
      triggers('cd $HOMEDIR && echo x > config.toml', stateHome),
    ).not.toContain(KUBIC_STATE_WRITE);
    expect(
      triggers('cd ~other && echo x > config.toml', stateHome),
    ).not.toContain(KUBIC_STATE_WRITE);
    expect(triggers('cd $HOME && echo x > config.toml', stateHome)).toContain(
      KUBIC_STATE_WRITE,
    );
    expect(triggers('echo x > a$HOME/.kubic/config.toml')).not.toContain(
      KUBIC_STATE_WRITE,
    );
    expect(triggers('echo x > a~/.kubic/config.toml')).not.toContain(
      KUBIC_STATE_WRITE,
    );
  });

  it('the home root itself is not the state dir, and uses the injected home', () => {
    expect(triggers('echo x > $HOME')).not.toContain(KUBIC_STATE_WRITE);
    expect(
      triggers('echo x > $HOME/.kubic/config.toml', {
        controlPlane: { home: '/elsewhere' },
      }),
    ).toContain(KUBIC_STATE_WRITE);
  });

  it('full access does not auto-approve an $HOME write into ~/.kubic', async () => {
    const root = mkTmp('kubic-324-home-');
    const workspace = mkTmp('kubic-324-ws-');
    enableFullAccess(new FileApprovalStore(root), 'test');
    const policy = installSoloPolicy({
      workspace,
      sessionDir: root,
      home: mkTmp('kubic-324-h-'),
    });
    const verdict = await policy.ask({
      toolName: 'bash',
      args: { command: 'echo x > $HOME/.kubic/config.toml' },
      toolCallId: 't1',
    });
    expect(verdict).toMatchObject({ approved: false });
    expect(JSON.stringify(verdict)).toContain(KUBIC_STATE_WRITE);
  });
});

describe('still-documented misses stay misses (honest limits, issue #324)', () => {
  it('a variable-built or symlinked path is not seen', () => {
    expect(triggers('D=.kubic; echo x > $D/roles/r.md')).not.toContain(
      KUBIC_STATE_WRITE,
    );
    expect(triggers('sed -i s/a/b/ .kubic/config.toml')).not.toContain(
      KUBIC_STATE_WRITE,
    );
  });
});

describe('autoApprove never answers an always-ask capability (issue #230, #324)', () => {
  function workspaceWithState(): string {
    const workspace = mkTmp('kubic-230-ws-');
    mkdirSync(join(workspace, '.kubic'), { recursive: true });
    return workspace;
  }

  it('headless: kubic-state-write in autoApprove refuses instantly with the no-surface reason', async () => {
    const workspace = workspaceWithState();
    const policy = installSoloPolicy({
      workspace,
      autoApprove: [KUBIC_STATE_WRITE],
      // A long bound: the pre-fix path waited it out (the 60 s stall).
      maxPendingMs: 30_000,
    });
    const started = Date.now();
    const verdict = await policy.ask({
      toolName: 'write',
      args: { path: '.kubic/config.toml', content: 'x' },
      toolCallId: 't1',
    });
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(verdict).toEqual({
      approved: false,
      reason: `${NO_ANSWER_SURFACE_REASON} (capability: ${KUBIC_STATE_WRITE})`,
    });
    expect(policy.denials()).toEqual([
      {
        capability: KUBIC_STATE_WRITE,
        toolName: 'write',
        reason: `${NO_ANSWER_SURFACE_REASON} (capability: ${KUBIC_STATE_WRITE})`,
      },
    ]);
  });

  it('a seat is asked with the full request display, exactly like an empty autoApprove', async () => {
    const workspace = workspaceWithState();
    const seen: ApprovalRequest[] = [];
    const policy = installSoloPolicy({
      workspace,
      autoApprove: [KUBIC_STATE_WRITE],
      answer: async (request) => {
        seen.push(request);
        return { approved: true, by: 'user' };
      },
    });
    const verdict = await policy.ask({
      toolName: 'bash',
      args: { command: 'echo x > .kubic/config.toml' },
      toolCallId: 't1',
    });
    expect(verdict).toEqual({ approved: true, challenged: true });
    expect(seen).toHaveLength(1);
    expect(seen[0]?.capability).toBe(KUBIC_STATE_WRITE);
    // The seat branch carries the full command (issue #316); the autoApprove
    // branch it used to take sent a bare summary.
    expect(seen[0]?.command).toBe('echo x > .kubic/config.toml');
  });

  it('other autoApprove entries still apply next to it, headless', async () => {
    const workspace = workspaceWithState();
    const policy = installSoloPolicy({
      workspace,
      autoApprove: [KUBIC_STATE_WRITE, 'install'],
      maxPendingMs: 30_000,
    });
    const install = await policy.ask({
      toolName: 'bash',
      args: { command: 'npm install left-pad' },
      toolCallId: 't1',
    });
    expect(install).toEqual({ approved: true, challenged: true });
    const state = await policy.ask({
      toolName: 'bash',
      args: { command: 'npm install left-pad && echo x > .kubic/config.toml' },
      toolCallId: 't2',
    });
    expect(state).toMatchObject({ approved: false });
    expect(JSON.stringify(state)).toContain(KUBIC_STATE_WRITE);
  });

  it('the service alone still never auto-approves it (existing contract)', async () => {
    const service = new ApprovalService({
      policy: validatePolicy({
        autoApprove: [KUBIC_STATE_WRITE],
        maxPendingMs: 5,
      }),
    });
    const verdict = await service.request({
      key: 'k',
      capability: KUBIC_STATE_WRITE,
      toolName: 'write',
      summary: 's',
    });
    expect(verdict.approved).toBe(false);
  });

  function doctorLines(autoApprove: string[], route = 'ask-user') {
    const lines: string[] = [];
    const deps: DoctorDeps = {
      out: (line: string) => lines.push(line),
      probeProviders: () => [
        { id: 'local', reachable: true, models: ['llama3'] },
      ],
      checkDeps: () => [{ id: 'node', ok: true, detail: 'v22.19.0' }],
      loadPolicy: () => ({ route, autoApprove }),
    };
    return { lines, deps };
  }

  it('doctor warns by name on the policy:approvals line and counts only effective entries', async () => {
    const { lines, deps } = doctorLines([KUBIC_STATE_WRITE]);
    const code = await runDoctorCommand({}, deps);
    const line = lines.find((l) => l.includes('policy:approvals')) ?? '';
    expect(line).toContain('WARN');
    expect(line).toContain('kubic-state-write always asks');
    expect(line).toContain('0 auto-approved');
    expect(line).not.toContain('1 auto-approved');
    // A warning informs; it never flips the exit code (no new exit codes).
    expect(code).toBe(0);
  });

  it('doctor counts the effective entries next to an ignored one', async () => {
    const { lines, deps } = doctorLines(['network', KUBIC_STATE_WRITE]);
    await runDoctorCommand({}, deps);
    const line = lines.find((l) => l.includes('policy:approvals')) ?? '';
    expect(line).toContain('WARN');
    expect(line).toContain('1 auto-approved');
  });

  it('kubic config prints the same honest count and names the ignored entry', () => {
    const files = new Map([
      [
        '/repo/.kubic/config.toml',
        '[approvals]\nautoApprove = ["network", "kubic-state-write"]\n',
      ],
    ]);
    const runtime = loadRuntimeConfig({
      bridge: {
        exists: (path: string) => files.has(path),
        readTextFile: (path: string) => files.get(path) ?? '',
      },
      home: '/home/u',
      cwd: '/repo',
      projectTrusted: true,
    });
    const text = renderEffectiveConfig(effectiveConfigView(runtime)).join('\n');
    expect(text).toContain(
      'approvals: route=ask-user (project), 1 auto-approved (kubic-state-write always asks — ignored), maxPendingMs=60000',
    );
    files.set(
      '/repo/.kubic/config.toml',
      '[approvals]\nautoApprove = ["network"]\n',
    );
    const plain = renderEffectiveConfig(
      effectiveConfigView(
        loadRuntimeConfig({
          bridge: {
            exists: (path: string) => files.has(path),
            readTextFile: (path: string) => files.get(path) ?? '',
          },
          home: '/home/u',
          cwd: '/repo',
          projectTrusted: true,
        }),
      ),
    ).join('\n');
    expect(plain).toContain(
      'approvals: route=ask-user (project), 1 auto-approved, maxPendingMs=60000',
    );
    expect(plain).not.toContain('always asks');
  });

  it('policy:enforceability counts only the effective entries too', () => {
    expect(
      policyEnforceabilityCheck({
        route: 'ask-user',
        autoApprove: [KUBIC_STATE_WRITE],
      }).detail,
    ).toBe(
      'route=ask-user, 0 auto-approved — policy offers routing, not enforcement',
    );
    expect(
      policyEnforceabilityCheck({
        route: 'ask-user',
        autoApprove: ['network', KUBIC_STATE_WRITE, KUBIC_STATE_WRITE],
      }).detail,
    ).toBe(
      'route=ask-user, 1 auto-approved — policy offers routing, not enforcement',
    );
    expect(
      policyEnforceabilityCheck({ route: 'ask-user', autoApprove: ['network'] })
        .detail,
    ).toBe(
      'route=ask-user, 1 auto-approved — policy offers routing, not enforcement',
    );
  });

  it('doctor still passes a policy with no always-ask entry', async () => {
    const { lines, deps } = doctorLines(['network']);
    const code = await runDoctorCommand({}, deps);
    const line = lines.find((l) => l.includes('policy:approvals')) ?? '';
    expect(line).toContain('PASS');
    expect(line).toContain('1 auto-approved');
    expect(line).not.toContain('always asks');
    expect(code).toBe(0);
  });
});

describe('route=deny beats autoApprove on the lane (issue #230)', () => {
  it('denies an autoApprove capability the doctor says can never apply', async () => {
    const workspace = mkTmp('kubic-230-deny-');
    const policy = installSoloPolicy({
      workspace,
      route: 'deny',
      autoApprove: ['install'],
    });
    const verdict = await policy.ask({
      toolName: 'bash',
      args: { command: 'npm install left-pad' },
      toolCallId: 't1',
    });
    expect(verdict).toEqual({
      approved: false,
      reason: 'denied by policy route (capability: install)',
    });
    expect(policy.denials()).toEqual([
      {
        capability: 'install',
        toolName: 'bash',
        reason: 'denied by policy route (capability: install)',
      },
    ]);
  });

  it('denies a capability that no autoApprove entry names, without consulting a seat', async () => {
    const workspace = mkTmp('kubic-230-deny-seat-');
    let asked = 0;
    const policy = installSoloPolicy({
      workspace,
      route: 'deny',
      autoApprove: ['network'],
      answer: async () => {
        asked += 1;
        return { approved: true, by: 'user' };
      },
    });
    const verdict = await policy.ask({
      toolName: 'bash',
      args: { command: 'npm install left-pad' },
      toolCallId: 't1',
    });
    expect(verdict).toEqual({
      approved: false,
      reason: 'denied by policy route (capability: install)',
    });
    expect(asked).toBe(0);
  });

  it('headless with no autoApprove entry at all: the route is named, not the missing surface', async () => {
    const workspace = mkTmp('kubic-230-deny-headless-');
    const policy = installSoloPolicy({ workspace, route: 'deny' });
    const verdict = await policy.ask({
      toolName: 'bash',
      args: { command: 'npm install left-pad' },
      toolCallId: 't1',
    });
    expect(verdict).toEqual({
      approved: false,
      reason: 'denied by policy route (capability: install)',
    });
  });

  it('with route=ask-user the same autoApprove entry is approved (the control)', async () => {
    const workspace = mkTmp('kubic-230-ask-');
    const policy = installSoloPolicy({
      workspace,
      route: 'ask-user',
      autoApprove: ['install'],
    });
    const verdict = await policy.ask({
      toolName: 'bash',
      args: { command: 'npm install left-pad' },
      toolCallId: 't1',
    });
    expect(verdict).toEqual({ approved: true, challenged: true });
  });

  it('the service agrees: route=deny wins over autoApprove', async () => {
    const service = new ApprovalService({
      policy: validatePolicy({ route: 'deny', autoApprove: ['network'] }),
    });
    const verdict = await service.request({
      key: 'k',
      capability: 'network',
      toolName: 'bash',
      summary: 's',
    });
    expect(verdict).toEqual({
      approved: false,
      reason: 'denied by policy route (capability: network)',
    });
  });
});

describe('git-push detector is linear-time (issue #357)', () => {
  const PUSH_TIMEOUT_MS = 250;

  // The destructive matcher is stubbed out: it belongs to the worker and is
  // not what this block times — the git scan is.
  function timed(command: string): { found: string[]; ms: number } {
    const started = performance.now();
    const found = triggers(command, { isDestructive: () => false });
    return { found, ms: performance.now() - started };
  }

  it('200 repeated long global options classify as git-push in well under a second', () => {
    const chain = '--namespace '.repeat(200);
    const { found, ms } = timed(`git ${chain}push origin main`);
    expect(found).toContain('git-push');
    expect(ms).toBeLessThan(PUSH_TIMEOUT_MS);
  });

  it('a long chain that never reaches push fails fast too (the old backtracking case)', () => {
    const chain = '--namespace '.repeat(200);
    const { found, ms } = timed(`git ${chain}pull origin main`);
    expect(found).not.toContain('git-push');
    expect(ms).toBeLessThan(PUSH_TIMEOUT_MS);
  });

  it('the other alternation members and mixed chains stay linear', () => {
    for (const option of [
      '--git-dir',
      '--work-tree',
      '--exec-path',
      '--config-env',
      '-c',
      '-C',
      '--git-dir x',
      '-c a=b',
      '--no-pager',
    ]) {
      const { found, ms } = timed(`git ${`${option} `.repeat(200)}status`);
      expect(found, option).not.toContain('git-push');
      expect(ms, option).toBeLessThan(PUSH_TIMEOUT_MS);
    }
    const mixed = timed(
      `git ${'--namespace -c a=b --git-dir=x '.repeat(80)}remote add o u`,
    );
    expect(mixed.found).toContain('git-push');
    expect(mixed.ms).toBeLessThan(PUSH_TIMEOUT_MS);
  });

  it('many git words each opening a chain stay linear overall', () => {
    const command = 'git --namespace '.repeat(2000);
    const { found, ms } = timed(`${command}x`);
    expect(found).not.toContain('git-push');
    expect(ms).toBeLessThan(PUSH_TIMEOUT_MS);
    const end = timed(`${command}push`);
    expect(end.found).toContain('git-push');
    expect(end.ms).toBeLessThan(PUSH_TIMEOUT_MS);
  });

  it('an unterminated quote run cannot make the tokenizer quadratic', () => {
    // An odd quote count leaves one quote with no closer (an ordinary
    // character); `-C` takes the first quoted word, the second is neither an
    // option nor the verb, so the run ends without a push.
    const { found, ms } = timed(`git -C ${'" '.repeat(2001)}push`);
    expect(found).not.toContain('git-push');
    expect(ms).toBeLessThan(PUSH_TIMEOUT_MS);
  });

  // Reference oracle: the regex the detector shipped with. It is exponential
  // only on long chains, so a seeded sweep of short token sequences pins that
  // the linear rewrite recognises EXACTLY the same commands.
  const OLD_GLOBALS = String.raw`(?:\s+(?:-[cC]\s+\S+|--(?:git-dir|work-tree|namespace|exec-path|config-env)(?:=\S+|\s+\S+)|--[a-z][a-z-]*|-[pP]))*`;
  const OLD_PUSH = new RegExp(
    String.raw`(^|[|;&\s(])git${OLD_GLOBALS}\s+push\b`,
    'i',
  );
  const OLD_REMOTE = new RegExp(
    String.raw`(^|[|;&\s(])git${OLD_GLOBALS}\s+remote\s+(add|set-url|remove|rename)\b`,
    'i',
  );

  it('recognises exactly what the original regex recognised (seeded differential)', () => {
    const vocabulary = [
      'push',
      'push-x',
      'pushd',
      'remote',
      'add',
      'set-url',
      'show',
      'remove',
      'rename',
      '-c',
      '-C',
      '-p',
      '-P',
      '-x',
      '--namespace',
      '--namespace=a',
      '--namespace=',
      '--git-dir',
      '--git-dir=a',
      '--work-tree',
      '--exec-path',
      '--config-env',
      '--config-env=k=v',
      '--no-pager',
      '--Bare',
      '--foo=bar',
      'a',
      'k=v',
      'GIT',
    ];
    let seed = 0x2f6e2b1;
    const next = (bound: number): number => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return seed % bound;
    };
    let recognised = 0;
    for (let run = 0; run < 4000; run += 1) {
      const length = 1 + next(7);
      const words = ['git'];
      for (let index = 0; index < length; index += 1) {
        words.push(vocabulary[next(vocabulary.length)] ?? 'a');
      }
      const command = words.join(' ');
      const expected = OLD_PUSH.test(command) || OLD_REMOTE.test(command);
      if (expected) recognised += 1;
      expect(triggers(command).includes('git-push'), command).toBe(expected);
    }
    // The sweep must exercise both outcomes, or it proves nothing.
    expect(recognised).toBeGreaterThan(100);
    expect(recognised).toBeLessThan(3900);
  });
});

describe('git-push trigger boundary (issue #357)', () => {
  it.each([
    ['an absolute path to git', '/usr/bin/git push origin main'],
    ['a relative path to git', './node_modules/.bin/git push'],
    ['a backslash-escaped git', '\\git push origin main'],
    ['a quoted option argument', 'git -C "my dir" push'],
    ['a single-quoted option argument', "git -C 'my dir' push origin main"],
    ['a quoted -c value', 'git -c "user.name=A B" push'],
    ['a quoted long-option value', 'git --work-tree "a b" push'],
    ['bash -c', "bash -c 'git push'"],
    ['sh -c', 'sh -c "git push origin main"'],
    ['a backtick substitution', 'echo `git push`'],
    ['a $() substitution', 'echo $(git push)'],
    ['a subshell', '(git push)'],
    ['env wrapper with an absolute git', 'env -i /usr/bin/git push'],
    ['a plain push (regression)', 'git push'],
    ['a chained push (regression)', 'ls; git push'],
    ['a global option (regression)', 'git -C . push'],
    ['uppercase (regression)', 'GIT PUSH'],
    [
      'a quoted string naming the push (documented over-trigger)',
      'echo "git push later"',
    ],
  ])('%s raises git-push', (_name, command) => {
    expect(triggers(command)).toContain('git-push');
  });

  it.each([
    ['a command merely ending in git', 'mygit push'],
    ['digit', 'digit push'],
    ['a longer word', 'gitk push'],
    ['a hyphenated tool', 'git-lfs push'],
    ['a path ending in mygit', '/usr/bin/mygit push'],
    ['a quoted mygit', "bash -c 'mygit push'"],
    ['a quoted digit', 'echo "digit push"'],
    ['another verb', 'git pull origin main'],
    ['another verb after a quoted option', 'git -C "my dir" pull'],
    ['a verb that only starts with push', 'git pushd'],
    ['a global option that eats the verb', 'git -c push'],
    ['a word-glued suffix', 'git pushed origin'],
    ['the verb glued to git', 'gitpush origin'],
  ])('%s does not raise git-push', (_name, command) => {
    expect(triggers(command)).not.toContain('git-push');
  });

  it.each([
    ['/usr/bin/git remote add o u'],
    ['git -C "my dir" remote set-url o u'],
    ["bash -c 'git remote remove o'"],
    ['\\git remote rename a b'],
  ])('%s raises git-push (remote mutation)', (command) => {
    expect(triggers(command)).toContain('git-push');
  });

  it.each([
    ['git remote -v'],
    ['git remote show origin'],
    ['git -C "my dir" remote'],
    ['mygit remote add o u'],
    ['git remotes add o u'],
  ])('%s does not raise git-push', (command) => {
    expect(triggers(command)).not.toContain('git-push');
  });
});

describe('outside-write targets are read as the shell reads them (issue #355)', () => {
  it.each([
    ['a double-quoted dot-dot segment', 'echo x > ".."/x'],
    ['a single-quoted dot-dot segment', "echo x > '..'/x"],
    ['a quote inside the segment', 'echo x > .."/x"'],
    ['a backslash-escaped first dot', 'echo x > \\../x'],
    ['a backslash before the slash', 'echo x > ..\\/x'],
    ['a quote-split tee target', 'echo x | tee ".."/x'],
    ['a quote-split cp destination', 'cp a ".."/x'],
    ['a quote-split mv destination', "mv a '..'/x"],
    ['a trailing-quoted target (regression)', 'echo x > ../"x"'],
    ['a fully quoted target (regression)', 'echo x > "../x"'],
    ['a quote-split absolute path', 'echo x > "/e"tc/x'],
    [
      'a sibling that only shares the workspace prefix',
      'echo x > "/wo"rk-evil/x',
    ],
    ['a quoted expansion', 'echo x > "$HOME"/x'],
  ])('%s raises outside-write', (_name, command) => {
    expect(triggers(command)).toContain('outside-write');
  });

  it.each([
    ['a quoted inside segment', 'echo x > "sub"/x'],
    ['an escaped letter', 'echo x > "s\\ub"/x'],
    ['a quote-split path into the workspace', 'echo x > "/wo"rk/x'],
    ['a quoted dot segment', 'echo x > "."/x'],
    ['a quoted inside tee target', 'echo x | tee "sub"/x'],
    ['a quoted dot-dot that stays inside', 'echo x > "sub"/".."/x'],
  ])('%s stays inside', (_name, command) => {
    expect(triggers(command)).not.toContain('outside-write');
  });
});

describe('cd tracking recognises shell compound forms (issue #355)', () => {
  it.each([
    ['a brace group', '{ cd /tmp; echo x > kubic-355-z; }'],
    ['then', 'if true; then cd /tmp; echo x > z; fi'],
    ['then on its own line', 'if true\nthen\n cd /tmp\n echo x > z\nfi'],
    ['do', 'for d in a; do cd /tmp; echo x > z; done'],
    ['else', 'if false; then :; else cd /tmp; echo x > z; fi'],
    ['elif', 'if false; then :; elif true; then cd /tmp; echo x > z; fi'],
    [
      'an elif condition',
      'if false; then :; elif cd /tmp; then echo x > z; fi',
    ],
    ['a negation', '! cd /tmp && echo x > z'],
    ['command', 'command cd /tmp && echo x > z'],
    ['builtin', 'builtin cd /tmp && echo x > z'],
    ['an if condition', 'if cd /tmp; then echo x > z; fi'],
    ['a negated if condition', 'if ! cd /tmp; then :; fi; echo x > z'],
    ['a while condition', 'while cd /tmp; do echo x > z; break; done'],
    ['an until condition', 'until cd /tmp; do :; done; echo x > z'],
    ['pushd in a brace group', '{ pushd /tmp; echo x > z; }'],
    ['a subshell (regression)', '(cd /tmp; echo x > z)'],
    ['a plain chain (regression)', 'cd /tmp && echo x > z'],
  ])('%s moves the cwd for later relative targets', (_name, command) => {
    expect(triggers(command)).toContain('outside-write');
  });

  it.each([
    ['an inside cd in a brace group', '{ cd sub; echo x > z; }'],
    ['an inside cd after then', 'if true; then cd sub; echo x > z; fi'],
    ['a word ending in cd', 'mycd /tmp; echo x > z'],
    ['a word ending in then', 'thencd /tmp; echo x > z'],
    ['a word ending in do', 'todo cd /tmp; echo x > z'],
    ['a longer command word', 'cdx /tmp; echo x > z'],
    ['a parameter named cd', 'echo ${cd}; echo x > z'],
    [
      'a cd argument named like a flag word',
      'cd sub && command ls && echo x > z',
    ],
  ])('%s leaves relative targets inside', (_name, command) => {
    expect(triggers(command)).not.toContain('outside-write');
  });

  it('the cwd change is ordered: a redirect before the cd is still inside', () => {
    expect(triggers('{ echo x > z; cd /tmp; }')).not.toContain('outside-write');
  });
});

// The auditor's reproductions, end to end through `kubic run`'s headless
// path (faux provider, zero network): before the fixes each of these bash
// calls exited 0 with no ask.
function modelsWith(
  steps: ReturnType<typeof fauxAssistantMessage>[],
): MutableModels {
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  faux.setResponses(steps);
  return models;
}

async function runBash(command: string, workspace: string) {
  return runHeadlessPrompt(
    'run it',
    {},
    {
      sessionsRoot: mkTmp('kubic-bypass-sessions-'),
      models: modelsWith([
        fauxAssistantMessage([fauxToolCall('bash', { command })]),
        fauxAssistantMessage('done'),
      ]),
      env: new NodeExecutionEnv(workspace),
    },
  );
}

describe('prod run path: the re-audit bypasses are challenged (issues #324, #355, #357)', () => {
  it('cd into .kubic/roles then a plain redirect is denied, named, and writes nothing', async () => {
    const workspace = mkTmp('kubic-bypass-ws-');
    mkdirSync(join(workspace, '.kubic', 'roles'), { recursive: true });
    const result = await runBash(
      'cd .kubic/roles && echo pwned > r.md',
      workspace,
    );
    expect(result.terminus).toBe('approval_denied');
    expect(result.summary).toContain(KUBIC_STATE_WRITE);
    expect(existsSync(join(workspace, '.kubic', 'roles', 'r.md'))).toBe(false);
  });

  it('a brace-group cd to an outside directory is an outside-write ask, not a silent write', async () => {
    const workspace = mkTmp('kubic-bypass-ws-');
    const outside = mkTmp('kubic-bypass-out-');
    const result = await runBash(
      `{ cd ${outside}; echo x > kubic-355-z; }`,
      workspace,
    );
    expect(result.terminus).toBe('approval_denied');
    expect(result.summary).toContain('outside-write');
    expect(existsSync(join(outside, 'kubic-355-z'))).toBe(false);
  });

  it('an absolute-path git push is challenged before it runs', async () => {
    const workspace = mkTmp('kubic-bypass-ws-');
    const result = await runBash('/usr/bin/git push origin main', workspace);
    expect(result.terminus).toBe('approval_denied');
    expect(result.summary).toContain('git-push');
  });

  it('a 200-repeat option chain no longer stalls the run (it took 14 s at 34 repeats)', async () => {
    const workspace = mkTmp('kubic-bypass-ws-');
    const started = Date.now();
    const result = await runBash(
      `echo git ${'--namespace '.repeat(200)}`,
      workspace,
    );
    expect(result.terminus).toBe('completed');
    expect(Date.now() - started).toBeLessThan(10_000);
  });
});
