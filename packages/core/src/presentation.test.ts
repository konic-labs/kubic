import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, expectTypeOf, it } from 'vitest';
import type { KubicPresentationState, LaneSnapshot } from './presentation.js';
import {
  PRESENTATION_COMMANDS,
  PRESENTATION_STATE_FIELDS,
} from './presentation.js';

const SOURCE = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), 'presentation.ts'),
  'utf8',
);

describe('presentation contract', () => {
  it('state carries exactly the five fields', () => {
    expect(Object.keys(PRESENTATION_STATE_FIELDS).sort()).toEqual([
      'approvals',
      'connection',
      'lane',
      'session',
      'usage',
    ]);
    // Values are the closed-world marker, not just the keys: flipping any
    // field to false must fail.
    expect(PRESENTATION_STATE_FIELDS).toEqual({
      session: true,
      lane: true,
      approvals: true,
      usage: true,
      connection: true,
    });
  });

  it('command union is exactly the thirteen', () => {
    expect([...PRESENTATION_COMMANDS].sort()).toEqual([
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
    ]);
  });

  it('has no eval channel, raw stream, or harness escape', () => {
    for (const cmd of PRESENTATION_COMMANDS) {
      expect(cmd.startsWith('eval')).toBe(false);
      expect(cmd).not.toMatch(/raw|harness|manager/);
    }
    expect(SOURCE).toMatch(/[Nn]egative rule/);
  });

  it('imports nothing from host, agent, or exec', () => {
    expect(SOURCE).not.toMatch(/@kubic\/(host|agent|exec)/);
  });

  it('holds one session and one lane, not id-keyed collections', () => {
    // Type-level contract (checked by `tsc`): the state carries the single
    // lane the session runs, and no agent or lane map keyed by id.
    expectTypeOf<
      KubicPresentationState['lane']
    >().toEqualTypeOf<LaneSnapshot>();
    expectTypeOf<KubicPresentationState>().not.toHaveProperty('agents');
    expectTypeOf<KubicPresentationState>().not.toHaveProperty('lanes');
  });
});
