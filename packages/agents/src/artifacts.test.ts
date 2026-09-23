import { describe, expect, it } from 'vitest';
import type { DebuggerHandoff, TaskArtifact } from './artifacts.js';
import {
  ARTIFACT_FIELDS,
  assertPromptCarriesNoTranscript,
  buildChildPrompt,
  buildDebuggerHandoff,
  checkSpawnIsolation,
  estimateHandoffTokens,
  freshDebuggerPrompt,
  renderArtifactTranscript,
  sanitizeArtifact,
  TOKEN_ECONOMICS_NOTE,
  toTrajectoryRecord,
  toTranscriptEntry,
  validateArtifact,
} from './artifacts.js';

function validArtifact(overrides: Partial<TaskArtifact> = {}): TaskArtifact {
  return {
    artifactId: 'a1',
    summary: 'Implementer result for the widget',
    fileRefs: ['src/widget.ts', 'src/widget.test.ts'],
    findings: ['root cause was a missing null guard'],
    tests: [{ name: 'widget renders', passed: false, output: 'null guard' }],
    decisions: ['chose null guard over optional chaining'],
    diffRefs: ['diff-1'],
    ...overrides,
  };
}

describe('TaskArtifact schema (issue #32, §25)', () => {
  it('field list matches §25 exactly', () => {
    expect(Object.keys(ARTIFACT_FIELDS).sort()).toEqual([
      'artifactId',
      'decisions',
      'diffRefs',
      'fileRefs',
      'findings',
      'summary',
      'tests',
    ]);
  });

  it('accepts a fully-populated artifact', () => {
    expect(validateArtifact(validArtifact()).valid).toBe(true);
  });

  it('rejects file refs carrying contents (paths only)', () => {
    const result = validateArtifact(
      validArtifact({ fileRefs: ['src/a.ts\nconst x = 1;'] }),
    );
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.errors.join(' ')).toMatch(/paths only/);
  });

  it('rejects credential-shaped values fail-closed', () => {
    const result = validateArtifact(
      validArtifact({ findings: ['used api_key=live-secret-123'] }),
    );
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.errors.join(' ')).toMatch(/credential/);
  });
});

describe('spawn isolation deny-list (§25)', () => {
  it('rejects parent transcript, credentials, and hidden state', () => {
    for (const smuggled of [
      { transcript: [] },
      { parentTranscript: '...' },
      { unrelatedOutput: '...' },
      { credentials: { token: 'x' } },
      { hiddenState: {} },
    ]) {
      const result = checkSpawnIsolation({ taskId: 't1', ...smuggled });
      expect(result.isolated).toBe(false);
    }
  });

  it('passes a bounded spawn object', () => {
    expect(checkSpawnIsolation({ taskId: 't1' }).isolated).toBe(true);
  });

  it('zero parent-transcript tokens by construction (prompt assertion)', () => {
    const parentTranscript =
      'PARENT-SECRET-HISTORY: the parent discussed the Q3 roadmap at length';
    const prompt = buildChildPrompt({
      objective: 'Fix the widget',
      constraints: ['no network'],
      relevantFiles: ['src/widget.ts'],
    });
    const check = assertPromptCarriesNoTranscript(prompt, parentTranscript);
    expect(check.leaked).toBe(false);
    expect(check.parentTokens).toBe(0);
  });
});

describe('artifact renderers (transcript + trajectory)', () => {
  it('renders a transcript entry carrying the summary and refs', () => {
    const entry = toTranscriptEntry(validArtifact());
    expect(entry.kind).toBe('artifact');
    expect(entry.text).toContain('Implementer result');
    expect(entry.text).toContain('src/widget.ts');
  });

  it('renders a JSON trajectory record with refs, never contents', () => {
    const record = toTrajectoryRecord(validArtifact());
    expect(record.kind).toBe('artifact');
    expect(JSON.stringify(record)).toContain('src/widget.ts');
    expect(renderArtifactTranscript(validArtifact())).toContain('diff-1');
  });

  it('sanitizeArtifact redacts credential-shaped text', () => {
    const redacted = sanitizeArtifact(
      validArtifact({ findings: ['token=abc123 leaked here'] }),
    );
    expect(redacted.findings[0]).toContain('[REDACTED]');
    expect(redacted.findings[0]).not.toContain('abc123');
  });
});

describe('implementer→debugger handoff e2e', () => {
  function debuggerHandoff(): DebuggerHandoff {
    const built = buildDebuggerHandoff({
      summary: 'widget tests red',
      filesChanged: ['src/widget.ts'],
      failingTests: [{ name: 'widget renders', output: 'null guard' }],
      diffRef: 'diff-1',
      worktree: '/tmp/wt-1',
      constraints: ['no network'],
      artifactIds: ['a1'],
      workerId: 'worker-1',
    });
    if (!built.valid) throw new Error(built.errors.join('; '));
    return built.handoff;
  }

  it('resumes in a fresh debugger session from failing test + diff + constraints', () => {
    const prompt = freshDebuggerPrompt(debuggerHandoff());
    expect(prompt).toContain('widget renders');
    expect(prompt).toContain('diff-1');
    expect(prompt).toContain('no network');
    expect(prompt).toContain('debugger');
  });

  it('fresh debugger prompt carries no transcript', () => {
    const prompt = freshDebuggerPrompt(debuggerHandoff());
    const check = assertPromptCarriesNoTranscript(
      prompt,
      'PARENT-SECRET-HISTORY that must never travel',
    );
    expect(check.leaked).toBe(false);
  });

  it('handoff token estimate stays bounded with a token-economics note', () => {
    const estimate = estimateHandoffTokens(debuggerHandoff());
    expect(estimate.approxTokens).toBeLessThan(2000);
    expect(TOKEN_ECONOMICS_NOTE).toMatch(/transcript/);
  });
});
