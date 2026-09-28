// The §54 delegation DAG is projected by the orchestrator (issue #95).
// §54 says orchestrator mode "is not limited to parent/child" and that "the
// agent tree view must render a DAG, not assume a tree". The shipped run
// fans one manager out to N workers, which is exactly that shape, so the
// graph module it was designed for (packages/agents/src/graph.ts, #49) must
// be reachable from the run and the DAG must actually be rendered — an
// unreachable graph module was the defect #95 measured. RED first.
import { describe, expect, it } from 'vitest';
import type {
  OrchestrateCommandDeps,
  OrchestrateWorktree,
  OrchestratorRunState,
} from './orchestrate-cli.js';
import {
  delegationGraphLines,
  runOrchestrateCommand,
} from './orchestrate-cli.js';
import type { MergedHunk } from './orchestrator/merge/attribution.js';

function depsFor(lines: string[]): OrchestrateCommandDeps {
  const hunks: MergedHunk[] = [{ path: 'a.txt', hunk: '@@ -0,0 +1 @@ +a' }];
  return {
    out: (line: string) => lines.push(line),
    err: (line: string) => lines.push(line),
    now: () => 1700000000000,
    isGitRepo: () => true,
    ensureWorktree: (agentId: string): OrchestrateWorktree => ({
      path: `/repo/.kubic/wt/${agentId}`,
      branch: `kubic/${agentId}`,
    }),
    createWorkerSession: (input) => ({ sessionId: input.workerSessionId }),
    runWorker: () => hunks,
    mergeBranch: () => undefined,
    reapWorker: () => undefined,
    requestApproval: () => true,
    saveState: (_state: OrchestratorRunState) => undefined,
  };
}

describe('delegation DAG (issue #95, §54)', () => {
  it('projects manager → worker edges as the §54 DAG projection', () => {
    const store = delegationGraphLines('orch-1', ['alpha', 'beta']);
    // Real session ids: the orchestrator session is the manager node and
    // each worker's node is the session its child attaches to.
    expect(store).toContain('node orch-1');
    expect(store).toContain('node orch-1-alpha');
    expect(store).toContain('node orch-1-beta');
    expect(store).toContain('edge orch-1 -> orch-1-alpha [delegated]');
    expect(store).toContain('edge orch-1 -> orch-1-beta [delegated]');
    // Refs only, never a transcript (§25.2/§69 token economics): the
    // rendered lines carry no edge payload at all.
    expect(store.join('\n')).not.toMatch(/transcript|contents/);
  });

  it('renders the run DAG in the JSON envelope and the text output', async () => {
    const lines: string[] = [];
    const code = await runOrchestrateCommand(
      {
        prompt: 'do the thing',
        agents: ['alpha', 'beta'],
        yes: true,
        json: true,
      },
      depsFor(lines),
    );
    expect(code).toBe(0);
    const envelope = JSON.parse(lines[lines.length - 1] as string) as {
      graph?: string[];
    };
    expect(envelope.graph).toBeDefined();
    const graph = envelope.graph ?? [];
    expect(
      graph.some((line) => /edge .+ -> .+-alpha \[delegated\]/.test(line)),
    ).toBe(true);
    expect(
      graph.some((line) => /edge .+ -> .+-beta \[delegated\]/.test(line)),
    ).toBe(true);

    const textLines: string[] = [];
    const textCode = await runOrchestrateCommand(
      { prompt: 'do the thing', agents: ['alpha', 'beta'], yes: true },
      depsFor(textLines),
    );
    expect(textCode).toBe(0);
    expect(textLines.join('\n')).toMatch(
      /dag: edge .+ -> .+-alpha \[delegated\]/,
    );
  });
});
