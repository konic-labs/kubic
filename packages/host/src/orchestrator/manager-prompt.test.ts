// The manager prompt's shipped rules (issue #188, §70): the review loop
// and the staffing skip ride the prompt itself — on a live run no script
// sequences the workers, so the prompt must state the sequencing rule and
// the trivial-objective skip. Pure, so no lane boots here.
import { describe, expect, it } from 'vitest';
import { assembleManagerPrompt } from './manager-lane.js';

describe('manager prompt rules (issue #188)', () => {
  it('advertises exactly the offered toolset, never more', () => {
    const prompt = assembleManagerPrompt(['spawn_agent', 'ask_user']);
    // The tools LINE is the offer (§40.3): exact, nothing smuggled in.
    const toolsLine = prompt
      .split('\n')
      .find((line) => line.startsWith('tools: '));
    expect(toolsLine).toBe('tools: spawn_agent, ask_user');
  });

  it('states the review loop: failing tests route debugger, then the tester re-runs', () => {
    const prompt = assembleManagerPrompt(['spawn_agent']);
    expect(prompt).toContain('review loop:');
    expect(prompt).toMatch(/tester.*fail.*debugger/i);
    expect(prompt).toMatch(/tester re-runs/);
    expect(prompt).toMatch(/bounded, one escalation/);
    expect(prompt).toMatch(/review_verdict/);
  });

  it('skips planner and reviewer for trivial or read-only objectives', () => {
    const prompt = assembleManagerPrompt(['spawn_agent']);
    expect(prompt).toContain('staffing:');
    expect(prompt).toMatch(/skip planner and reviewer/i);
  });
});
