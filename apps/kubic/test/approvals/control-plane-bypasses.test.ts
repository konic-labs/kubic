// Bash approval-detector bypasses and autoApprove semantics. Each block pins
// a bypass the detectors once missed. The classifiers are the PRODUCTION ones
// (defaultIsDestructive, isNetworkCommand, confinePath) wired like
// triggerContextFor, and the lane tests drive the real installPolicy —
// faux/no provider, zero network. Detection stays lexical: a variable-built
// path (`$D/roles/r.md` with D set elsewhere), a symlink, `sed -i`, a script
// file or an interpreter still reach `.kubic/` without raising — those
// documented limits are pinned in the "still-documented misses" block so a
// future fix is a conscious change.
// biome-ignore-all lint/suspicious/noTemplateCurlyInString: `${HOME}` here is bash syntax under test, not a template literal
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  confinePath,
  defaultIsDestructive,
  isNetworkCommand,
} from '@kubic/agent/lane/interceptors';
import {
  type ApprovalRequest,
  ApprovalService,
  controlPlaneRefusal,
  detectTriggers,
  enableFullAccess,
  FileApprovalStore,
  installPolicy,
  KUBIC_STATE_WRITE,
  NO_ANSWER_SURFACE_REASON,
  type TriggerContext,
  validatePolicy,
} from '@kubic/host/approvals';
import {
  effectiveConfigView,
  loadRuntimeConfig,
  renderEffectiveConfig,
} from '@kubic/host/config';
import type { DoctorDeps } from '@kubic/host/doctor';
import {
  policyEnforceabilityCheck,
  runDoctorCommand,
} from '@kubic/host/doctor';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { tempDir } from '../../../../test/temp-dir.js';

const WS = '/work';

const HOME = '/home/tester';

afterEach(() => {
  vi.unstubAllEnvs();
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

describe('control-plane detector: cd tracking', () => {
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

describe('control-plane detector: redirect forms', () => {
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
    expect(refusal('echo x &>> .kubic/audit/audit.jsonl')).toContain(
      'control-plane state',
    );
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

describe('control-plane detector: quote-split and escaped segments', () => {
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
      'refused: .kubic/journal/index.jsonl is Kubic control-plane state (.kubic/journal, .kubic/audit, .kubic/sessions) — agents may not write it',
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

describe('control-plane detector: rm and mv operands', () => {
  it('deleting or moving the journal is tampering: refused', () => {
    for (const command of [
      'rm .kubic/journal/index.jsonl',
      'rm -rf .kubic/journal',
      'rm -f -- .kubic/journal/index.jsonl',
      'mv .kubic/journal /tmp/j',
      'mv -f .kubic/journal/index.jsonl /tmp/j.jsonl',
      'cd .kubic && rm journal/index.jsonl',
      'echo a && rm .kubic/audit/audit.jsonl',
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

describe('control-plane detector: $HOME expands like ~', () => {
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
    const root = tempDir('kubic-approvals-bypass-home-');
    const workspace = tempDir('kubic-approvals-bypass-ws-');
    enableFullAccess(new FileApprovalStore(root), 'test');
    const policy = installPolicy({
      workspace,
      sessionDir: root,
      home: tempDir('kubic-approvals-bypass-h-'),
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

describe('still-documented misses stay misses (honest limits)', () => {
  it('a variable-built or symlinked path is not seen', () => {
    expect(triggers('D=.kubic; echo x > $D/roles/r.md')).not.toContain(
      KUBIC_STATE_WRITE,
    );
    expect(triggers('sed -i s/a/b/ .kubic/config.toml')).not.toContain(
      KUBIC_STATE_WRITE,
    );
  });
});

describe('autoApprove never answers an always-ask capability', () => {
  function workspaceWithState(): string {
    const workspace = tempDir('kubic-approvals-bypass-ws-');
    mkdirSync(join(workspace, '.kubic'), { recursive: true });
    return workspace;
  }

  it('headless: kubic-state-write in autoApprove refuses instantly with the no-surface reason', async () => {
    const workspace = workspaceWithState();
    const policy = installPolicy({
      workspace,
      autoApprove: [KUBIC_STATE_WRITE],
      // A long bound: the call must not wait it out.
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
    const policy = installPolicy({
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
    // The seat branch carries the full command; the autoApprove
    // branch must not send a bare summary.
    expect(seen[0]?.command).toBe('echo x > .kubic/config.toml');
  });

  it('other autoApprove entries still apply next to it, headless', async () => {
    const workspace = workspaceWithState();
    const policy = installPolicy({
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
    const code = (await runDoctorCommand({}, deps)).exitCode;
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
    const code = (await runDoctorCommand({}, deps)).exitCode;
    const line = lines.find((l) => l.includes('policy:approvals')) ?? '';
    expect(line).toContain('PASS');
    expect(line).toContain('1 auto-approved');
    expect(line).not.toContain('always asks');
    expect(code).toBe(0);
  });
});
