// Manager lane slice 1 (issue #40): allowlist exactness, exec fail-closed,
// non-git --orchestrator refusal (exit 5 → solo). RED first.
import { describe, expect, it } from 'vitest';
import {
  assertManagerToolset,
  buildManagerPlan,
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
  ManagerPolicyBlockedError,
  ManagerToolsetError,
  parseOrchestratorToggle,
  planStepFor,
  recordManagerLaneCall,
  registerManagerLane,
  resolveOrchestratorMode,
  runManagerStub,
  serializeOrchestratorToggle,
  setOrchestratorToggle,
  validateWorkspaceApply,
  validateWorkspaceDiff,
} from './manager.js';

describe('manager allowlist (issue #40)', () => {
  it('registers exactly the §9.2/§43.1 tools', () => {
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
        // §70 (issue #188): the reviewer verdict routes the merge call.
        'review_verdict',
        'ask_user',
        // §43.1: read-only git inspection for the manager, separate from its
        // merge capability (issue #205).
        'git_status',
        'git_diff',
        'git_log',
      ].sort(),
    );
    expect(MANAGER_ALLOWLIST).toHaveLength(14);
  });

  it('accepts the three read-only git tools and refuses every mutating one (issue #205)', () => {
    for (const tool of ['git_status', 'git_diff', 'git_log']) {
      expect(() => assertManagerToolset([...MANAGER_ALLOWLIST])).not.toThrow();
      expect(() => checkManagerCall(tool)).not.toThrow();
    }
    // §43.1 is inspection only: a lane carrying any writer git tool refuses
    // to start, naming it — the mutating tools are never in the allowlist.
    for (const tool of [
      'git_commit',
      'git_stage',
      'git_branch',
      'git_checkpoint',
      'git_push',
    ]) {
      expect(() => registerManagerLane([...MANAGER_ALLOWLIST, tool])).toThrow(
        new RegExp(tool),
      );
      expect(() => registerManagerLane([...MANAGER_ALLOWLIST, tool])).toThrow(
        ManagerToolsetError,
      );
      expect(() => checkManagerCall(tool)).toThrow(ManagerPolicyBlockedError);
    }
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

  it('names malformed JSON as ManagerToolsetError, folding in the parse message (issue #132)', () => {
    // Invalid JSON (a bare string, truncated model output) is the equally
    // likely sibling of a wrong shape: it must classify as the SAME named
    // error, with the parse message folded in — a raw SyntaxError escaping
    // here surfaces as an unclassified harness fault instead.
    let caught: unknown;
    try {
      parseOrchestratorToggle('{"on": ');
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ManagerToolsetError);
    expect((caught as Error).name).toBe('ManagerToolsetError');
    expect((caught as Error).message).toMatch(/not JSON/);
    // A valid-JSON-wrong-shape payload keeps the message it always had.
    expect(() => parseOrchestratorToggle('{"on": "yes"}')).toThrow(
      'invalid orchestrator toggle payload',
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
    const plan = [
      'spawn_agent',
      'send_to_agent',
      'wait_for_agent',
      'collect_result',
      'workspace_diff',
      'workspace_merge',
      'ask_user',
    ];
    const done = runManagerStub(spy, plan);
    expect(done).toEqual(plan);
    expect(spy.calls).toEqual(plan);
    expect(spy.execCalls).toEqual([]);
  });

  it('stops a stub delegation at the first exec call, before recording it', () => {
    const spy = createManagerCallSpy();
    expect(() =>
      runManagerStub(spy, ['spawn_agent', 'bash', 'collect_result']),
    ).toThrow(ManagerPolicyBlockedError);
    expect(spy.calls).toEqual(['spawn_agent']);
    expect(spy.execCalls).toEqual([]);
  });
});

describe('manager lane registration (issue #103)', () => {
  it('registers exactly the allowlist and hands the live toolset back', () => {
    const lane = registerManagerLane(MANAGER_ALLOWLIST);
    expect([...lane.tools].sort()).toEqual([...MANAGER_ALLOWLIST].sort());
    // The registration is what assertManagerToolset must accept: the
    // allowlist set the lane actually runs with.
    expect(() => assertManagerToolset(lane.tools)).not.toThrow();
  });

  it('registers the canonical allowlist when no toolset is supplied', () => {
    const lane = registerManagerLane();
    expect(lane.tools).toEqual([...MANAGER_ALLOWLIST]);
    expect(lane.allowlist).toEqual([...MANAGER_ALLOWLIST]);
  });

  it('refuses to start a lane carrying an exec tool, naming it', () => {
    for (const tool of EXEC_FORBIDDEN_TOOLS) {
      expect(() => registerManagerLane([...MANAGER_ALLOWLIST, tool])).toThrow(
        new RegExp(tool),
      );
    }
    expect(() => registerManagerLane([...MANAGER_ALLOWLIST, 'bash'])).toThrow(
      ManagerToolsetError,
    );
    // A refusal is not a warning: the named error carries the allowlist rule.
    expect(() => registerManagerLane([...MANAGER_ALLOWLIST, 'bash'])).toThrow(
      /must equal the allowlist exactly/,
    );
  });

  it('records allowlisted lane calls and refuses exec names fail-closed', () => {
    const spy = createManagerCallSpy();
    recordManagerLaneCall(spy, 'spawn_agent');
    recordManagerLaneCall(spy, 'wait_for_agent');
    recordManagerLaneCall(spy, 'collect_result');
    expect(spy.calls).toEqual([
      'spawn_agent',
      'wait_for_agent',
      'collect_result',
    ]);
    expect(spy.execCalls).toEqual([]);
    for (const tool of EXEC_FORBIDDEN_TOOLS) {
      expect(() => recordManagerLaneCall(spy, tool)).toThrow(
        ManagerPolicyBlockedError,
      );
    }
    // The refused calls never reach the trace.
    expect(spy.calls).toEqual([
      'spawn_agent',
      'wait_for_agent',
      'collect_result',
    ]);
    expect(spy.execCalls).toEqual([]);
  });
});

describe('manager plan → per-worker prompts (issue #103)', () => {
  it('authors one plan step per worker, in agent order', () => {
    const plan = buildManagerPlan('apply the change', ['alpha', 'beta']);
    expect(plan.map((step) => step.agentId)).toEqual(['alpha', 'beta']);
    expect(plan.map((step) => step.step)).toEqual([1, 2]);
  });

  it('gives every worker a prompt that differs and cites its plan step', () => {
    const plan = buildManagerPlan('apply the change', ['alpha', 'beta']);
    const [alpha, beta] = plan;
    expect(alpha?.prompt).not.toBe(beta?.prompt);
    expect(alpha?.prompt).toContain('step 1 of 2');
    expect(beta?.prompt).toContain('step 2 of 2');
    expect(alpha?.prompt).toContain("agent 'alpha'");
    expect(beta?.prompt).toContain("agent 'beta'");
    // The objective travels with every step so the worker knows the goal…
    expect(alpha?.prompt).toContain('apply the change');
    // …but no worker prompt is the -p text verbatim.
    for (const step of plan) expect(step.prompt).not.toBe('apply the change');
  });

  it('is deterministic: the same objective and agents replay the same plan', () => {
    expect(buildManagerPlan('apply the change', ['alpha', 'beta'])).toEqual(
      buildManagerPlan('apply the change', ['alpha', 'beta']),
    );
  });

  it('finds a worker step by agent id and reports a missing one', () => {
    const plan = buildManagerPlan('apply the change', ['alpha']);
    expect(planStepFor(plan, 'alpha')?.step).toBe(1);
    expect(planStepFor(plan, 'ghost')).toBeUndefined();
  });
});
