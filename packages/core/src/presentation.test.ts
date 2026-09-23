import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { KubicPresentationState } from './presentation.js';
import {
  isPresentationCommand,
  PRESENTATION_COMMANDS,
  PRESENTATION_STATE_FIELDS,
} from './presentation.js';

const SOURCE = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), 'presentation.ts'),
  'utf8',
);

describe('presentation contract (issue #5, §66)', () => {
  it('state carries exactly the §66 seven fields', () => {
    expect(Object.keys(PRESENTATION_STATE_FIELDS).sort()).toEqual([
      'agents',
      'approvals',
      'connection',
      'lanes',
      'session',
      'usage',
      'workers',
    ]);
  });

  it('command union is exactly the §66 eighteen', () => {
    expect([...PRESENTATION_COMMANDS].sort()).toEqual([
      'agent.cancel',
      'agent.send',
      'agent.spawn',
      'approval.respond',
      'lane.abort',
      'lane.compact',
      'lane.followUp',
      'lane.prompt',
      'lane.resume',
      'lane.steer',
      'model.select',
      'session.attach',
      'session.detach',
      'session.fork',
      'session.navigate',
      'thinking.cycle',
      'worker.inspect',
      'worker.terminate',
    ]);
  });

  it('has no eval channel, raw stream, or harness escape', () => {
    for (const cmd of PRESENTATION_COMMANDS) {
      expect(cmd.startsWith('eval')).toBe(false);
      expect(cmd).not.toMatch(/raw|harness|manager/);
    }
    expect(SOURCE).toMatch(/[Nn]egative rule/);
  });

  it('imports nothing from host, worker, or exec', () => {
    expect(SOURCE).not.toMatch(/@kubic\/(host|worker|exec)/);
  });

  it('holds replicated snapshots in keyed maps', () => {
    const state: KubicPresentationState = {
      session: { sessionId: 's1' },
      agents: new Map([
        ['a1', { agentId: 'a1', role: 'implementer', status: 'running' }],
      ]),
      lanes: new Map([['l1', { laneId: 'l1' }]]),
      workers: new Map([['w1', { workerId: 'w1' }]]),
      approvals: [{ requestId: 'r1' }],
      usage: { inputTokens: 1, outputTokens: 2, costUsd: 0.01 },
      connection: { status: 'connected' },
    };
    expect(state.agents.get('a1')?.role).toBe('implementer');
    expect(state.lanes.size).toBe(1);
  });

  it('command guard accepts known and rejects unknown commands', () => {
    expect(isPresentationCommand('lane.abort')).toBe(true);
    expect(isPresentationCommand('eval.run')).toBe(false);
  });
});
