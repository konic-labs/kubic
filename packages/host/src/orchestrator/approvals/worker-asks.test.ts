// The worker-ask question renders the trigger name straight from the
// request envelope (issue #131 pins one snapshot): no capability-name
// switch, no hard-coded allowlist — a new capability must render without
// any change here. RED first: the envelope vocabulary refused the name
// until it grew `privilege-escalation`, so a worker raising the new
// capability could not even reach this surface.
import { describe, expect, it } from 'vitest';
import { buildOrchestratorRequest } from './request.js';
import { formatWorkerAskQuestion } from './worker-asks.js';

describe('worker ask question (issue #131)', () => {
  it('renders privilege-escalation with no special cases', () => {
    const request = buildOrchestratorRequest({
      trigger: 'privilege-escalation',
      toolName: 'bash',
      args: { command: 'sudo systemctl restart foo' },
      justification: 'restart the service after the deploy',
      sessionId: 'sess-1',
      agentId: 'agent-1',
      role: 'implementer',
      worktree: '/wt/agent-1',
      provenance: { parentSessionId: 'root-sess' },
    });
    expect(formatWorkerAskQuestion(request)).toBe(
      "worker 'agent-1' requests privilege-escalation (bash): restart the service after the deploy — approve?",
    );
  });
});
