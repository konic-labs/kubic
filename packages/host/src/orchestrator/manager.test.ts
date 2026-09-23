// Manager lane slice 1 (issue #40): allowlist exactness, exec fail-closed,
// non-git --orchestrator refusal (exit 5 → solo). RED first.
import { describe, expect, it } from 'vitest';
import {
  EXEC_FORBIDDEN_TOOLS,
  MANAGER_ALLOWLIST,
  MANAGER_EXIT_WORKSPACE_UNAVAILABLE,
  assertManagerToolset,
  buildOrchestratorRefusal,
  checkManagerCall,
  resolveOrchestratorMode,
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
    expect(() =>
      assertManagerToolset([...MANAGER_ALLOWLIST]),
    ).not.toThrow();
    expect(() =>
      assertManagerToolset([...MANAGER_ALLOWLIST, 'bash']),
    ).toThrow(/bash/);
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
    expect(refusal.exitCode).toBe(
      MANAGER_EXIT_WORKSPACE_UNAVAILABLE,
    );
    expect(refusal.exitCode).toBe(5);
    expect(refusal.message).toMatch(/solo/);
  });
});
