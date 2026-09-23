// Manager lane slice 1 (issue #40): allowlist exactness, exec fail-closed,
// non-git --orchestrator refusal (exit 5 → solo). RED first.
import { describe, expect, it } from 'vitest';
import {
  assertManagerToolset,
  buildModeAuditEvent,
  buildModeStatusJson,
  buildOrchestratorRefusal,
  buildSessionModeRecord,
  checkManagerCall,
  createManagerCallSpy,
  EXEC_FORBIDDEN_TOOLS,
  formatModeIndicator,
  MANAGER_ALLOWLIST,
  MANAGER_EXIT_WORKSPACE_UNAVAILABLE,
  MANAGER_TRADE_DOC,
  parseOrchestratorToggle,
  resolveOrchestratorMode,
  runManagerStub,
  serializeOrchestratorToggle,
  setOrchestratorToggle,
  validateWorkspaceApply,
  validateWorkspaceDiff,
  validateWorkspaceMerge,
} from './manager.js';

describe('manager allowlist (issue #40)', () => {
  it('registers exactly the 10 §9.2 tools', () => {
    expect([...MANAGER_ALLOWLIST].sort()).toEqual(
      [
        'spawn_agent',
        'send_to_agent',
        'wait_for_agent',
        'cancel_agent',
        'inspect_agent',
        'collect_result',
        'workspace_diff',
        'workspace_apply',
        'workspace_merge',
        'ask_user',
      ].sort(),
    );
    expect(MANAGER_ALLOWLIST).toHaveLength(10);
  });

  it('asserts the active set equals the allowlist exactly', () => {
    expect(() => assertManagerToolset([...MANAGER_ALLOWLIST])).not.toThrow();
    expect(() => assertManagerToolset([...MANAGER_ALLOWLIST, 'bash'])).toThrow(
      /bash/,
    );
    expect(() => assertManagerToolset(['read'])).toThrow(/allowlist/);
  });

  it('names every exec tool as forbidden', () => {
    expect([...EXEC_FORBIDDEN_TOOLS].sort()).toEqual(
      ['bash', 'read', 'write', 'edit', 'grep', 'find', 'ls'].sort(),
    );
  });

  it('fails exec calls closed (unregistered, never prompt-gated)', () => {
    for (const tool of EXEC_FORBIDDEN_TOOLS) {
      expect(() => checkManagerCall(tool)).toThrow(/policy block/);
    }
    expect(() => checkManagerCall('spawn_agent')).not.toThrow();
  });
});

describe('non-git orchestrator refusal (issue #40)', () => {
  it('resolves --orchestrator flag over config and toggle', () => {
    expect(
      resolveOrchestratorMode({
        cliFlag: true,
        configValue: false,
        toggle: false,
      }),
    ).toBe('orchestrator');
    expect(
      resolveOrchestratorMode({
        cliFlag: false,
        configValue: true,
        toggle: false,
      }),
    ).toBe('orchestrator');
    expect(
      resolveOrchestratorMode({
        cliFlag: false,
        configValue: false,
        toggle: true,
      }),
    ).toBe('orchestrator');
    expect(
      resolveOrchestratorMode({
        cliFlag: false,
        configValue: false,
        toggle: false,
      }),
    ).toBe('solo');
  });

  it('refuses non-git --orchestrator with exit 5 pointing to solo', () => {
    const refusal = buildOrchestratorRefusal();
    expect(refusal.exitCode).toBe(MANAGER_EXIT_WORKSPACE_UNAVAILABLE);
    expect(refusal.exitCode).toBe(5);
    expect(refusal.message).toMatch(/solo/);
  });
});

describe('manager workspace contracts (issue #40)', () => {
  it('validates a workspace diff request', () => {
    expect(
      validateWorkspaceDiff({ worktree: '/repo/.kubic/wt/agent-1' }),
    ).toEqual({ valid: true, errors: [] });
    expect(validateWorkspaceDiff({ worktree: 'relative/path' }).valid).toBe(
      false,
    );
  });

  it('validates apply (patch required) and blocks inline authoring', () => {
    expect(
      validateWorkspaceApply({
        worktree: '/repo/.kubic/wt/agent-1',
        patch: 'diff --git a/f b/f',
      }).valid,
    ).toBe(true);
    expect(
      validateWorkspaceApply({ worktree: '/repo/.kubic/wt/a', patch: '' })
        .valid,
    ).toBe(false);
    expect(() =>
      validateWorkspaceApply({
        worktree: '/repo/.kubic/wt/a',
        patch: 'p',
        contents: 'authored text',
      }),
    ).toThrow(/policy block/);
  });

  it('validates merge (source required) and blocks inline authoring', () => {
    expect(
      validateWorkspaceMerge({
        worktree: '/repo/.kubic/wt/a',
        source: 'agent-1',
      }).valid,
    ).toBe(true);
    expect(
      validateWorkspaceMerge({ worktree: '/repo/.kubic/wt/a', source: '' })
        .valid,
    ).toBe(false);
    expect(() =>
      validateWorkspaceMerge({
        worktree: '/repo/.kubic/wt/a',
        source: 'agent-1',
        contents: 'authored text',
      }),
    ).toThrow(/policy block/);
  });
});

describe('orchestrator toggle, indicator, session, audit (issue #40)', () => {
  it('keeps the toggle session-scoped, persisted, and round-trippable', () => {
    const state = setOrchestratorToggle(
      { on: false, scope: 'session', persisted: true },
      true,
    );
    expect(state).toEqual({ on: true, scope: 'session', persisted: true });
    expect(parseOrchestratorToggle(serializeOrchestratorToggle(state))).toEqual(
      state,
    );
  });

  it('renders the mode indicator vocabulary', () => {
    expect(formatModeIndicator('orchestrator')).toBe('orchestrator');
    expect(formatModeIndicator('solo')).toBe('solo');
  });

  it('records mode in the session and surfaces it in status --json', () => {
    const record = buildSessionModeRecord('sess-1', 'orchestrator', 'cli');
    expect(record).toMatchObject({
      sessionId: 'sess-1',
      mode: 'orchestrator',
      scope: 'session',
      persisted: true,
    });
    expect(buildModeStatusJson('sess-1', 'orchestrator')).toMatchObject({
      sessionId: 'sess-1',
      mode: 'orchestrator',
    });
  });

  it('emits a mode audit event', () => {
    const event = buildModeAuditEvent({
      sessionId: 'sess-1',
      mode: 'orchestrator',
      source: 'toggle',
    });
    expect(event).toMatchObject({
      type: 'mode',
      sessionId: 'sess-1',
      mode: 'orchestrator',
      source: 'toggle',
    });
  });
});

describe('faux manager delegation (issue #40)', () => {
  it('runs a stub delegation with zero exec calls', () => {
    const spy = createManagerCallSpy();
    const done = runManagerStub(spy, [
      'spawn_agent',
      'send_to_agent',
      'wait_for_agent',
      'collect_result',
      'workspace_diff',
      'workspace_merge',
      'ask_user',
    ]);
    expect(done).toHaveLength(7);
    expect(spy.execCalls).toEqual([]);
  });
});

describe('manager trade doc (issue #40)', () => {
  it('ships a single-paragraph trade statement', () => {
    expect(typeof MANAGER_TRADE_DOC).toBe('string');
    expect(MANAGER_TRADE_DOC.trim().length).toBeGreaterThan(80);
    expect(MANAGER_TRADE_DOC).not.toMatch(/\n/);
  });
});
