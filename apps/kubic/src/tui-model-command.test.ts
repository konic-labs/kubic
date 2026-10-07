// The `/model` parser of the interactive loop. The
// submit path routes on these three outcomes, so what counts as a command —
// and what is still a prompt for the lane — is pinned here, not inferred
// from the prod test.
import { describe, expect, it } from 'vitest';
import type { TuiApp } from '../../../packages/tui/src/tui-app.js';
import { BACKGROUND_CONTEXT } from '../../../packages/worker/src/pi-boundary.js';
import {
  parseEscalateCommand,
  parseModelCommand,
  parseThinkingCommand,
  type TuiLaneLoop,
  TuiTurnRunner,
} from './tui-run.js';

describe('parseModelCommand', () => {
  it('reads the report and switch forms', () => {
    expect(parseModelCommand('/model')).toEqual({ kind: 'pick' });
    expect(parseModelCommand('/model   ')).toEqual({ kind: 'pick' });
    expect(parseModelCommand('/model alt/m1')).toEqual({
      kind: 'switch',
      selection: { provider: 'alt', id: 'm1' },
    });
  });

  it('refuses a malformed argument by name', () => {
    expect(parseModelCommand('/model nope')).toEqual({
      kind: 'invalid',
      message: '--model must be \'provider/id\' (got "nope")',
    });
  });

  it('leaves prompts — including /model lookalikes — to the lane', () => {
    expect(parseModelCommand('hello')).toBeUndefined();
    expect(parseModelCommand('/models')).toBeUndefined();
    expect(parseModelCommand('/model=alt/m1')).toBeUndefined();
  });
});

describe('TuiTurnRunner model switch', () => {
  it('refuses a switch when the boot has no live lane', async () => {
    const loop = {
      context: BACKGROUND_CONTEXT,
    } as unknown as TuiLaneLoop;
    const runner = new TuiTurnRunner(
      {
        setModel: () => {},
        // The runner seeds its presentation projector from the
        // app, so a stub app must answer the seed.
        presentationSeed: () => ({
          sessionId: 's',
          model: 'faux/faux-1',
          approvalsSkipped: false,
        }),
      } as unknown as TuiApp,
      loop,
      'faux/big',
    );
    expect(runner.modelRef).toBe('faux/big');
    await expect(
      runner.switchModel({ provider: 'alt', id: 'm1' }),
    ).rejects.toThrow('this session has no live lane to switch');
  });
});

describe('parseEscalateCommand', () => {
  it('reads the switch form with an optional reason', () => {
    expect(parseEscalateCommand('/escalate local/b')).toEqual({
      kind: 'switch',
      selection: { provider: 'local', id: 'b' },
      reason: undefined,
    });
    expect(parseEscalateCommand('/escalate acme/big for speed')).toEqual({
      kind: 'switch',
      selection: { provider: 'acme', id: 'big' },
      reason: 'for speed',
    });
  });

  it('refuses a bare command and a malformed ref by name', () => {
    expect(parseEscalateCommand('/escalate')).toEqual({
      kind: 'invalid',
      message: 'usage: /escalate <provider/id> [reason]',
    });
    expect(parseEscalateCommand('/escalate nope')).toEqual({
      kind: 'invalid',
      message: expect.stringContaining('provider/id'),
    });
  });

  it('leaves prompts — including /escalate lookalikes — to the lane', () => {
    expect(parseEscalateCommand('hello')).toBeUndefined();
    expect(parseEscalateCommand('/escalates')).toBeUndefined();
    expect(parseEscalateCommand('/escalate=local/b')).toBeUndefined();
  });
});

describe('parseThinkingCommand', () => {
  it('reads the report and switch forms', () => {
    expect(parseThinkingCommand('/thinking')).toEqual({ kind: 'pick' });
    expect(parseThinkingCommand('/thinking   ')).toEqual({ kind: 'pick' });
    expect(parseThinkingCommand('/thinking high')).toEqual({
      kind: 'switch',
      level: 'high',
    });
  });

  it('refuses an unknown level by name, with the vocabulary', () => {
    expect(parseThinkingCommand('/thinking bogus')).toEqual({
      kind: 'invalid',
      message:
        "unknown thinking level 'bogus' (levels: off, minimal, low, medium, high, xhigh, max)",
    });
  });

  it('leaves prompts — including /thinking lookalikes — to the lane', () => {
    expect(parseThinkingCommand('hello')).toBeUndefined();
    expect(parseThinkingCommand('/thinkings')).toBeUndefined();
    expect(parseThinkingCommand('/thinking=high')).toBeUndefined();
  });
});
