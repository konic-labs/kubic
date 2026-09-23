// Orchestrator worktree messaging (issue #58; §59.1).
// RED first: worktrees separate writers only — never isolation or
// containment. Faux-only: pure strings, no I/O.
import { describe, expect, it } from 'vitest';
import { buildOrchestratorWorktreeNotice } from './orchestrator-notice.js';

describe('orchestrator worktree notice (issue #58)', () => {
  it('says writers-only: one worker process per worktree', () => {
    const text = buildOrchestratorWorktreeNotice().join('\n');
    expect(text).toMatch(/writers only/);
    expect(text).toMatch(/one worker/i);
    expect(text).toMatch(/worktree/);
  });

  it('denies isolation and containment instead of implying it', () => {
    const lines = buildOrchestratorWorktreeNotice();
    expect(lines.join('\n')).toMatch(/not isolation/);
    expect(lines.join('\n')).toMatch(/not containment|no containment/);
    for (const line of lines) {
      if (/\bisolat\w+|\bsandbox\b|\bcontainment\b/i.test(line)) {
        expect(line).toMatch(/no |not |never |without /i);
      }
    }
  });
});
