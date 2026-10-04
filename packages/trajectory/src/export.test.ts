import { describe, expect, it } from 'vitest';
import type { BuildTrajectoryInput } from './export.js';
import {
  buildTrajectoryExport,
  MAX_OBSERVATION_BYTES,
  TrajectoryExportError,
} from './export.js';
import {
  parseTrajectoryExport,
  SCHEMA_VERSION,
  TRAJECTORY_FAILURE_CODES,
  TRAJECTORY_FIELDS,
} from './schema.js';

function completeInput(
  overrides: Partial<BuildTrajectoryInput> = {},
): BuildTrajectoryInput {
  return {
    task: { taskId: 'task-1', objective: 'Fix the widget', role: 'writer' },
    identity: { sessionId: 'sess-1', agentId: 'agent-1', workerId: 'worker-1' },
    model: {
      provider: 'acme',
      model: 'm1',
      thinking: null,
      escalations: [],
    },
    prompt: { text: 'Fix the widget', constraints: [] },
    resources: { skills: [], promptTemplates: [] },
    transfer: null,
    actions: [],
    observations: [],
    state: { phase: 'done', snapshot: null },
    provenance: {
      sessionId: 'sess-1',
      agentId: 'agent-1',
      pid: 4242,
      generation: 3,
      worktree: '/repo/.kubic/wt/agent-1',
      model: 'acme/m1',
    },
    environment: {
      capturedFrom: 'used',
      cwd: '/repo/.kubic/wt/agent-1',
      env: {},
    },
    worktree: {
      path: '/repo/.kubic/wt/agent-1',
      baseRevision: 'abc123',
      branch: 'kubic/agent-1',
    },
    diff: { filesChanged: [], files: [] },
    approvals: [],
    timestamps: {
      startedAt: '2026-09-23T10:00:00.000Z',
      endedAt: '2026-09-23T10:01:00.000Z',
    },
    usage: {
      inputTokens: 10,
      outputTokens: 5,
      cachedTokens: 0,
      requests: 1,
      costUsd: 0.01,
      byModel: {},
    },
    result: {
      status: 'completed',
      summary: 'done',
      failureCategory: null,
      error: null,
    },
    ...overrides,
  };
}

describe('trajectory export fail-closed (issue #51)', () => {
  it('blocks export when provenance is missing (non-zero, machine-readable)', () => {
    const input = completeInput();
    const { provenance: _dropped, ...rest } = input;
    const err = (() => {
      try {
        buildTrajectoryExport(rest as BuildTrajectoryInput);
      } catch (e) {
        return e as TrajectoryExportError;
      }
      throw new Error('export succeeded without provenance — expected block');
    })();
    expect(err).toBeInstanceOf(TrajectoryExportError);
    expect(err.code).toBe('missing-provenance');
    expect(err.exitCode).not.toBe(0);
    expect(JSON.parse(JSON.stringify(err)).error.code).toBe(
      'missing-provenance',
    );
  });

  it('blocks export when the used-environment snapshot is missing', () => {
    const input = completeInput();
    const { environment: _dropped, ...rest } = input;
    try {
      buildTrajectoryExport(rest as BuildTrajectoryInput);
    } catch (e) {
      const err = e as TrajectoryExportError;
      expect(err).toBeInstanceOf(TrajectoryExportError);
      expect(err.code).toBe('missing-environment');
      expect(err.exitCode).not.toBe(0);
      return;
    }
    throw new Error('export succeeded without environment — expected block');
  });

  it('refuses an intended/configured env — only the USED snapshot is recorded', () => {
    const err = (() => {
      try {
        buildTrajectoryExport(
          completeInput({
            environment: {
              capturedFrom: 'intended',
              cwd: '/repo',
              env: {},
            } as unknown as BuildTrajectoryInput['environment'],
          }),
        );
      } catch (e) {
        return e as TrajectoryExportError;
      }
      throw new Error('export accepted an intended env — expected refusal');
    })();
    expect(err.code).toBe('untrusted-environment');
    expect(err.message).toMatch(/used/i);
  });
});

describe('trajectory golden fixture (issue #51, §46)', () => {
  it('emits every §46 field with the recorded values', () => {
    const exported = buildTrajectoryExport(
      completeInput({
        transfer: {
          taskId: 'task-1',
          worktree: '/repo/.kubic/wt/agent-1',
          grantRef: 'worktree:bash,read',
        },
        actions: [
          { seq: 1, tool: 'read', args: { path: 'src/a.ts' } },
          { seq: 2, tool: 'bash', args: { cmd: 'vitest run' } },
        ],
        observations: [{ seq: 1, actionSeq: 1, output: 'const a = 1;\n' }],
        approvals: [
          {
            approvalId: 'appr-1',
            capability: 'destructive-shell',
            verdict: 'approved',
            by: 'user',
          },
        ],
        diff: {
          filesChanged: ['src/a.ts'],
          files: [{ path: 'src/a.ts', hunks: ['@@ -1 +1 @@\n-a\n+b'] }],
        },
      }),
    );
    expect(Object.keys(exported).sort()).toEqual(
      Object.keys(TRAJECTORY_FIELDS).sort(),
    );
    expect(exported.schema_version).toBe(SCHEMA_VERSION);
    expect(exported.task.taskId).toBe('task-1');
    expect(exported.identity).toEqual({
      sessionId: 'sess-1',
      agentId: 'agent-1',
      workerId: 'worker-1',
      parentSessionId: null,
      role: 'writer',
    });
    // 1.1 (issue #329): every new field is present on a write, with
    // explicit null/[] meaning "not recorded" — never an invented value.
    expect(exported.state.operations).toEqual([]);
    expect(exported.state.memos).toEqual([]);
    expect(exported.result.tests).toEqual([]);
    expect(exported.result.artifacts).toEqual([]);
    expect(exported.approvals[0]).toEqual({
      approvalId: 'appr-1',
      capability: 'destructive-shell',
      verdict: 'approved',
      by: 'user',
      requested: null,
      justification: null,
    });
    expect(exported.model.provider).toBe('acme');
    expect(exported.model.escalations).toEqual([]);
    expect(exported.prompt.text).toBe('Fix the widget');
    expect(exported.resources).toEqual({ skills: [], promptTemplates: [] });
    expect(exported.transfer?.grantRef).toBe('worktree:bash,read');
    expect(exported.actions).toHaveLength(2);
    expect(exported.actions[1]).toEqual({
      seq: 2,
      tool: 'bash',
      args: { cmd: 'vitest run' },
    });
    expect(exported.observations[0]?.truncated).toBe(false);
    expect(exported.state.phase).toBe('done');
    expect(exported.provenance.pid).toBe(4242);
    expect(exported.provenance.generation).toBe(3);
    expect(exported.provenance.model).toBe('acme/m1');
    expect(exported.environment.capturedFrom).toBe('used');
    expect(exported.worktree.baseRevision).toBe('abc123');
    expect(exported.diff.filesChanged).toEqual(['src/a.ts']);
    expect(exported.approvals[0]?.verdict).toBe('approved');
    expect(exported.timestamps.durationMs).toBe(60_000);
    expect(exported.usage.costUsd).toBe(0.01);
    expect(exported.result.status).toBe('completed');
    expect(exported.eval).toEqual({ suite: null, caseId: null, labels: {} });
    // Golden output re-parses with no shim — this is the record
    // replay --diff-against (#52) and eval (#53) consume directly.
    const revived = parseTrajectoryExport(
      JSON.parse(JSON.stringify(exported)) as unknown,
    );
    expect(revived.diff.filesChanged).toEqual(['src/a.ts']);
    expect(revived.actions).toHaveLength(2);
    expect(revived.environment.env).toEqual({});
    expect(revived.eval.labels).toEqual({});
  });
});

describe('trajectory schema 1.1 (issue #329)', () => {
  it('carries the additive §46 fields and round-trips through the parser', () => {
    const exported = buildTrajectoryExport(
      completeInput({
        identity: {
          sessionId: 'sess-2',
          agentId: 'agent-2',
          workerId: null,
          parentSessionId: 'sess-1',
          role: 'reviewer',
        },
        model: {
          provider: 'acme',
          model: 'm2',
          thinking: 'high',
          escalations: [
            {
              reason: 'context overflow',
              at: '2026-10-04T10:00:30.000Z',
              fromModel: 'acme/m1',
              toModel: 'acme/m2',
              thinking: 'high',
            },
          ],
        },
        state: {
          phase: 'done',
          snapshot: { step: 2 },
          operations: [
            { id: 'op-1', kind: 'read' },
            { id: 'op-2', kind: 'edit' },
          ],
          memos: ['memo://a'],
        },
        approvals: [
          {
            approvalId: 'appr-2',
            capability: 'destructive-shell',
            verdict: 'denied',
            by: 'user',
            requested: 'rm -rf build (redacted)',
            justification: 'not needed for this task',
          },
        ],
        result: {
          status: 'failed',
          summary: 'gave up',
          failureCategory: 'model_refused',
          error: { kind: 'refusal', message: 'no' },
          tests: ['vitest:packages/trajectory'],
          artifacts: ['artifact://coverage/lcov.info'],
        },
      }),
    );
    expect(exported.schema_version).toBe(SCHEMA_VERSION);
    const revived = parseTrajectoryExport(
      JSON.parse(JSON.stringify(exported)) as unknown,
    );
    expect(revived.identity.parentSessionId).toBe('sess-1');
    expect(revived.identity.role).toBe('reviewer');
    expect(revived.model.escalations[0]).toEqual({
      reason: 'context overflow',
      at: '2026-10-04T10:00:30.000Z',
      fromModel: 'acme/m1',
      toModel: 'acme/m2',
      thinking: 'high',
    });
    expect(revived.state.operations).toEqual([
      { id: 'op-1', kind: 'read' },
      { id: 'op-2', kind: 'edit' },
    ]);
    expect(revived.state.memos).toEqual(['memo://a']);
    expect(revived.approvals[0]?.requested).toBe('rm -rf build (redacted)');
    expect(revived.approvals[0]?.justification).toBe(
      'not needed for this task',
    );
    expect(revived.result.tests).toEqual(['vitest:packages/trajectory']);
    expect(revived.result.artifacts).toEqual(['artifact://coverage/lcov.info']);
  });

  it('refuses an escalation without toModel', () => {
    const build = (): unknown =>
      buildTrajectoryExport(
        completeInput({
          model: {
            provider: 'acme',
            model: 'm1',
            thinking: null,
            escalations: [{ reason: 'risk', at: '2026-10-04T10:00:30.000Z' }],
          },
        }),
      );
    expect(build).toThrowError(TrajectoryExportError);
    expect(build).toThrowError(
      expect.objectContaining({ code: 'invalid-escalation' }),
    );
    expect(build).toThrowError(/model\.escalations\[0\]\.toModel is required/);
  });
});

describe('trajectory observations + failures + eval slot (issue #51)', () => {
  it('truncates long observations but keeps the byte count', () => {
    const big = 'x'.repeat(MAX_OBSERVATION_BYTES + 100);
    const exported = buildTrajectoryExport(
      completeInput({
        observations: [{ seq: 1, actionSeq: 1, output: big }],
      }),
    );
    const observation = exported.observations[0];
    expect(observation?.truncated).toBe(true);
    expect(observation?.bytesOriginal).toBe(MAX_OBSERVATION_BYTES + 100);
    expect(
      Buffer.byteLength(observation?.output ?? '', 'utf8'),
    ).toBeLessThanOrEqual(MAX_OBSERVATION_BYTES);
    // Truncated, not dropped: the kept output is the head of the original,
    // filled right up to the cap.
    expect(observation?.output).toBe(big.slice(0, MAX_OBSERVATION_BYTES));
  });

  it('keeps the §52 failure taxonomy in sync with the worker owner', () => {
    expect([...TRAJECTORY_FAILURE_CODES].sort()).toEqual(
      [
        'approval_denied',
        'approval_timed_out',
        'budget_exhausted',
        'context_overflow',
        'context_polluted',
        'model_failed',
        'model_refused',
        'process_crashed',
        'process_spawn_failed',
        'provider_auth',
        'provider_transient',
        'tool_failed',
        'tool_invalid_args',
        'tool_timeout',
        'tool_unavailable',
        'workspace_failed',
      ].sort(),
    );
  });

  it('requires a §52 category on every non-completed result', () => {
    try {
      buildTrajectoryExport(
        completeInput({
          result: {
            status: 'failed',
            summary: 'boom',
            failureCategory: null,
            error: { kind: 'tool', message: 'boom' },
          },
        }),
      );
    } catch (e) {
      expect((e as TrajectoryExportError).code).toBe(
        'missing-failure-category',
      );
      return;
    }
    throw new Error(
      'failed result without a category exported — expected block',
    );
  });

  it('records the §52 category on failures for replay/debug', () => {
    const exported = buildTrajectoryExport(
      completeInput({
        result: {
          status: 'budget_exhausted',
          summary: 'out of tokens',
          failureCategory: 'budget_exhausted',
          error: { kind: 'budget', message: 'out of tokens' },
        },
      }),
    );
    expect(exported.result.failureCategory).toBe('budget_exhausted');
  });

  it('rejects a completed result carrying an error', () => {
    try {
      buildTrajectoryExport(
        completeInput({
          result: {
            status: 'completed',
            summary: 'done?',
            failureCategory: null,
            error: { kind: 'tool', message: 'late error' },
          },
        }),
      );
    } catch (e) {
      expect((e as TrajectoryExportError).code).toBe('contradictory-result');
      return;
    }
    throw new Error('contradictory result exported — expected block');
  });

  it('carries the eval slot through for issue #53 with no shim', () => {
    const exported = buildTrajectoryExport(
      completeInput({
        eval: { suite: 'bench-1', caseId: 'case-7', labels: { lang: 'ts' } },
      }),
    );
    const revived = parseTrajectoryExport(
      JSON.parse(JSON.stringify(exported)) as unknown,
    );
    expect(revived.eval).toEqual({
      suite: 'bench-1',
      caseId: 'case-7',
      labels: { lang: 'ts' },
    });
  });
});

describe('trajectory review fixes (round 2)', () => {
  it('truncates multi-byte output on a character boundary — byte cap holds exactly, no U+FFFD', () => {
    const cjk = 'あ'.repeat(5000);
    expect(Buffer.byteLength(cjk, 'utf8')).toBe(15_000);
    const exported = buildTrajectoryExport(
      completeInput({
        observations: [{ seq: 1, actionSeq: 1, output: cjk }],
      }),
    );
    const observation = exported.observations[0];
    expect(observation?.truncated).toBe(true);
    expect(observation?.bytesOriginal).toBe(15_000);
    expect(
      Buffer.byteLength(observation?.output ?? '', 'utf8'),
    ).toBeLessThanOrEqual(MAX_OBSERVATION_BYTES);
    expect(observation?.output).not.toContain('�');
    // Cut on the last whole 3-byte character that fits, never shorter.
    const whole = Math.floor(MAX_OBSERVATION_BYTES / 3);
    expect(observation?.output).toBe(cjk.slice(0, whole));
  });

  it('rejects a completed result carrying a failureCategory', () => {
    try {
      buildTrajectoryExport(
        completeInput({
          result: {
            status: 'completed',
            summary: 'done?',
            failureCategory: 'tool_failed',
            error: null,
          },
        }),
      );
    } catch (e) {
      expect((e as TrajectoryExportError).code).toBe('contradictory-result');
      return;
    }
    throw new Error(
      'completed result with a failureCategory exported — expected block',
    );
  });

  it('rejects a malformed usage.byModel row', () => {
    try {
      buildTrajectoryExport(
        completeInput({
          usage: {
            inputTokens: 10,
            outputTokens: 5,
            cachedTokens: 0,
            requests: 1,
            costUsd: 0.01,
            byModel: {
              'acme/m1': {
                requests: 1,
                input: 10,
                output: -5,
                costTotal: 0.01,
              },
            },
          },
        }),
      );
    } catch (e) {
      expect((e as TrajectoryExportError).code).toBe('invalid-usage');
      return;
    }
    throw new Error('malformed byModel row exported — expected block');
  });

  it('passes a well-formed usage.byModel through', () => {
    const exported = buildTrajectoryExport(
      completeInput({
        usage: {
          inputTokens: 10,
          outputTokens: 5,
          cachedTokens: 0,
          requests: 1,
          costUsd: 0.01,
          byModel: {
            'acme/m1': { requests: 1, input: 10, output: 5, costTotal: 0.01 },
          },
        },
      }),
    );
    expect(exported.usage.byModel['acme/m1']).toEqual({
      requests: 1,
      input: 10,
      output: 5,
      costTotal: 0.01,
    });
  });

  it('defaults usage.byModel to an empty record when the caller omits it (issue #331)', () => {
    const exported = buildTrajectoryExport(
      completeInput({
        // A runtime caller that never built the per-model rollup: the
        // declared TrajectoryUsage contract still requires the field, so
        // the exporter must supply it rather than emit a record the
        // parser refuses.
        usage: {
          inputTokens: 10,
          outputTokens: 5,
          cachedTokens: 0,
          requests: 1,
          costUsd: 0.01,
        } as BuildTrajectoryInput['usage'],
      }),
    );
    expect(exported.usage.byModel).toEqual({});
    const revived = parseTrajectoryExport(
      JSON.parse(JSON.stringify(exported)) as unknown,
    );
    expect(revived.usage.byModel).toEqual({});
  });

  // Issue #359 replaces the old "records the used env VERBATIM" premise: the
  // spawn env DOES carry role grants (KUBIC_ROLE_*), so the exporter redacts
  // every secret-classified key with the classifier the spawn path uses. The
  // key stays (the run saw it); its value never leaves the process.
  it('redacts secret-classified env keys, keeping every key', () => {
    const env = {
      PATH: '/usr/bin',
      HOME: '/home/agent',
      SECRET_TOKEN: 's3cret-that-must-not-leak',
      KUBIC_ROLE_IMPLEMENTER_SESSION: 'grant-value',
      // Issue #402: the Anthropic federation block (pi-ai 0.99.2) is secret
      // even though its names match no suffix rule.
      ANTHROPIC_FEDERATION_RULE_ID: 'fdrl_123',
      ANTHROPIC_IDENTITY_TOKEN_FILE: '/run/secrets/identity-token',
    };
    const exported = buildTrajectoryExport(
      completeInput({
        environment: { capturedFrom: 'used', cwd: '/repo', env },
      }),
    );
    expect(exported.environment.env).toEqual({
      PATH: '/usr/bin',
      HOME: '/home/agent',
      SECRET_TOKEN: '<redacted>',
      KUBIC_ROLE_IMPLEMENTER_SESSION: '<redacted>',
      ANTHROPIC_FEDERATION_RULE_ID: '<redacted>',
      ANTHROPIC_IDENTITY_TOKEN_FILE: '<redacted>',
    });
    expect(JSON.stringify(exported)).not.toContain('s3cret-that-must-not-leak');
    expect(JSON.stringify(exported)).not.toContain('grant-value');
    expect(JSON.stringify(exported)).not.toContain('identity-token');
  });
});
