import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, expectTypeOf, it } from 'vitest';
import type {
  AgentSummary,
  KubicPresentationState,
  LaneSnapshot,
  WorkerSummary,
} from './presentation.js';
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
    // Values are the closed-world marker, not just the keys: flipping any
    // field to false must fail (mutation: BooleanLiteral true→false).
    expect(PRESENTATION_STATE_FIELDS).toEqual({
      session: true,
      agents: true,
      lanes: true,
      workers: true,
      approvals: true,
      usage: true,
      connection: true,
    });
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
    // Type-level contract (checked by `tsc`): the replicated collections are
    // id-keyed maps, not arrays. Building a literal and reading it back would
    // only assert what the test itself wrote.
    expectTypeOf<KubicPresentationState['agents']>().toEqualTypeOf<
      ReadonlyMap<string, AgentSummary>
    >();
    expectTypeOf<KubicPresentationState['lanes']>().toEqualTypeOf<
      ReadonlyMap<string, LaneSnapshot>
    >();
    expectTypeOf<KubicPresentationState['workers']>().toEqualTypeOf<
      ReadonlyMap<string, WorkerSummary>
    >();
  });

  it('command guard accepts known and rejects unknown commands', () => {
    expect(isPresentationCommand('lane.abort')).toBe(true);
    expect(isPresentationCommand('eval.run')).toBe(false);
  });
});
