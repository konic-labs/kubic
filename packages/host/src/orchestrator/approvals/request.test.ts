// Orchestrator approval request envelope (issue #48; §41.1, §63).
// RED first: envelope carries trigger, required justification, and
// session/agent/role/worktree/provenance — no defaults, no silent fields.
import { describe, expect, it } from 'vitest';
import {
  buildOrchestratorRequest,
  ORCHESTRATOR_TRIGGERS,
  validateOrchestratorRequest,
} from './request.js';

function base() {
  return {
    trigger: 'network',
    toolName: 'bash',
    args: { command: 'curl https://example.com' },
    justification: 'need release tarball for the task',
    sessionId: 'sess-1',
    agentId: 'agent-1',
    role: 'implementer',
    worktree: '/wt/agent-1',
    provenance: { parentSessionId: 'root-sess', taskId: 'task-1' },
  };
}

describe('orchestrator request envelope (issue #48)', () => {
  it('covers the §41.1 trigger set', () => {
    expect([...ORCHESTRATOR_TRIGGERS].sort()).toEqual(
      [
        'budget-overrun',
        'credentials',
        'deploy',
        'destructive-shell',
        'git-push',
        'install',
        'network',
        'outside-write',
        'privilege-escalation',
        'spawn-agents',
      ].sort(),
    );
  });

  it('builds a stable key across restarts (same op, same key)', () => {
    const a = buildOrchestratorRequest(base());
    const b = buildOrchestratorRequest(base());
    expect(a.key).toBe(b.key);
    expect(a.key).toMatch(/^[0-9a-f]{16}$/);
  });

  it('keys differ across worktrees for the same command', () => {
    const a = buildOrchestratorRequest(base());
    const b = buildOrchestratorRequest({
      ...base(),
      worktree: '/wt/agent-2',
    });
    expect(a.key).not.toBe(b.key);
  });

  it('requires justification (§63) — empty or missing is refused', () => {
    expect(() =>
      validateOrchestratorRequest({ ...base(), justification: '' }),
    ).toThrow(/justification/);
    expect(() =>
      validateOrchestratorRequest({ ...base(), justification: '  ' }),
    ).toThrow(/justification/);
    const { justification, ...rest } = base();
    void justification;
    expect(() => validateOrchestratorRequest(rest)).toThrow(/justification/);
  });

  it('requires session/agent/role/worktree/provenance identity', () => {
    expect(() =>
      validateOrchestratorRequest({ ...base(), sessionId: '' }),
    ).toThrow(/sessionId/);
    expect(() =>
      validateOrchestratorRequest({ ...base(), agentId: '' }),
    ).toThrow(/agentId/);
    expect(() => validateOrchestratorRequest({ ...base(), role: '' })).toThrow(
      /role/,
    );
    expect(() =>
      validateOrchestratorRequest({ ...base(), worktree: 'rel' }),
    ).toThrow(/worktree/);
  });

  it('refuses unknown triggers fail-closed', () => {
    expect(() =>
      validateOrchestratorRequest({ ...base(), trigger: 'teleport' }),
    ).toThrow(/trigger/);
  });
});
