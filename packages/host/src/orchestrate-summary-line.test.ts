// The worker summary line is untrusted model text drawn on the operator's
// terminal (issue #185; the sanitiser convention of the scheduler and the
// lane renderer): a prompt-injected worker whose summary carries ESC / CR /
// C1 controls could repaint or overwrite the report. Only inert text may
// reach the line.
import { describe, expect, it } from 'vitest';
import { buildAgentResult } from '../../worker/src/result.js';
import { workerSummaryLine } from './orchestrate-cli.js';

function resultWith(summary: string, role?: string) {
  return buildAgentResult({
    status: 'completed',
    summary,
    provenance: {
      workerId: 'w1',
      sessionId: 's-w1',
      pid: 1,
      generation: 1,
      worktree: '/repo/.kubic/wt/s/w1',
      model: 'faux/faux-1',
      ...(role === undefined ? {} : { role }),
    },
    metrics: { wallMs: 1, latencyMs: 0 },
  });
}

// biome-ignore lint/suspicious/noControlCharactersInRegex: asserting none survive.
const ANY_CONTROL = /[\u0000-\u001f\u007f-\u009f‪-‮⁦-⁩]/;

describe('workerSummaryLine (issue #185)', () => {
  it('keeps a plain summary exactly', () => {
    expect(
      workerSummaryLine('w1', resultWith('did the work', 'implementer')),
    ).toBe('w1 (implementer): did the work');
    expect(workerSummaryLine('w1', resultWith('did the work'))).toBe(
      'w1 (worker): did the work',
    );
  });

  it('strips ESC sequences: a summary cannot clear the screen or repaint colour', () => {
    const line = workerSummaryLine(
      'w1',
      resultWith('done\u001b[2J\u001b[31m all good\u001b[0m'),
    );
    expect(line).toBe('w1 (worker): done[2J[31m all good[0m');
    expect(ANY_CONTROL.test(line)).toBe(false);
  });

  it('strips a carriage return: the line cannot be overwritten from column 0', () => {
    const line = workerSummaryLine(
      'w1',
      resultWith('real summary\rFAKE: all merged'),
    );
    expect(line).toBe('w1 (worker): real summaryFAKE: all merged');
    expect(line).not.toContain('\r');
  });

  it('strips BEL, DEL, C1 (CSI U+009B, NEL U+0085) and bidi overrides', () => {
    const line = workerSummaryLine(
      'w1',
      resultWith('a\u0007b\u007fc\u009b31md\u0085e‮f⁦g'),
    );
    expect(line).toBe('w1 (worker): abc31mdefg');
    expect(ANY_CONTROL.test(line)).toBe(false);
  });

  it('still shows only the first line, and a CRLF line ending leaves no trace', () => {
    expect(
      workerSummaryLine('w1', resultWith('first line\r\nsecond line')),
    ).toBe('w1 (worker): first line');
  });

  it('counts the 200-character budget over what is drawn, not over the stripped controls', () => {
    const noisy = `${'x\u001b'.repeat(250)}`;
    const line = workerSummaryLine('w1', resultWith(noisy));
    expect(line).toBe(`w1 (worker): ${'x'.repeat(200)}…`);
    const exact = workerSummaryLine('w1', resultWith('y'.repeat(200)));
    expect(exact).toBe(`w1 (worker): ${'y'.repeat(200)}`);
  });

  it('sanitises the role too', () => {
    const line = workerSummaryLine(
      'w1',
      resultWith('ok', 'impl\u001b[2Jementer'),
    );
    expect(line).toBe('w1 (impl[2Jementer): ok');
  });
});
