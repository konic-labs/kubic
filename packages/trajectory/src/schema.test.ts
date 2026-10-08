import { describe, expect, it } from 'vitest';
import type { BuildTrajectoryInput } from './export.js';
import { buildTrajectoryExport } from './export.js';
import {
  isTrajectoryFailureCode,
  parseTrajectoryExport,
  parseTrajectoryExportJSON,
  RESULT_STATUSES,
  SCHEMA_MAJOR,
  SCHEMA_VERSION,
  TRAJECTORY_CHANGELOG,
  TRAJECTORY_STABILITY,
  TrajectorySchemaError,
} from './schema.js';

// A full, valid record through the real builder: the structural tests below
// mutate one field of it, so they exercise the parser, not a hand-drawn shape.
function validInput(): BuildTrajectoryInput {
  return {
    task: { taskId: 'task-1', objective: 'Fix the widget', role: 'writer' },
    identity: { sessionId: 'sess-1', agentId: 'agent-1' },
    model: { provider: 'acme', model: 'm1', thinking: null, escalations: [] },
    prompt: { text: 'Fix the widget' },
    resources: { skills: [] },
    actions: [],
    observations: [],
    state: { phase: 'done' },
    provenance: {
      sessionId: 'sess-1',
      agentId: 'agent-1',
      pid: null,
      worktree: '/repo',
      model: 'acme/m1',
    },
    environment: {
      capturedFrom: 'used',
      cwd: '/repo',
      env: {},
    },
    worktree: {
      path: '/repo',
      baseRevision: 'abc123',
      branch: null,
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
  };
}

function validExport(): Record<string, unknown> {
  return JSON.parse(
    JSON.stringify(buildTrajectoryExport(validInput())),
  ) as Record<string, unknown>;
}

function parseError(input: unknown): TrajectorySchemaError {
  try {
    parseTrajectoryExport(input);
  } catch (error) {
    return error as TrajectorySchemaError;
  }
  throw new Error('parse accepted a malformed record — expected rejection');
}

describe('trajectory schema version', () => {
  it('publishes schema_version 1.0', () => {
    expect(SCHEMA_VERSION).toBe('1.0');
    expect(SCHEMA_MAJOR).toBe(1);
  });

  it('rejects an unknown major with a clear machine-readable error', () => {
    const err = parseError({ ...validExport(), schema_version: '2.0' });
    expect(err).toBeInstanceOf(TrajectorySchemaError);
    expect(err.code).toBe('unknown-major');
    expect(err.exitCode).not.toBe(0);
    expect(err.message).toMatch(/2.*major 1|major 1.*2/i);
  });

  it('publishes stability and a changelog with the single 1.0 entry', () => {
    expect(TRAJECTORY_STABILITY).toBe('stable');
    expect(TRAJECTORY_CHANGELOG.map((entry) => entry.version)).toEqual(['1.0']);
  });

  it('accepts a newer minor of the same major (tolerant, no shim)', () => {
    const parsed = parseTrajectoryExport({
      ...validExport(),
      schema_version: `${SCHEMA_MAJOR}.99`,
    });
    expect(parsed.schema_version).toBe(`${SCHEMA_MAJOR}.99`);
  });

  it('rejects a record missing a trajectory field as malformed', () => {
    expect(() =>
      parseTrajectoryExport({ schema_version: SCHEMA_VERSION }),
    ).toThrowError(TrajectorySchemaError);
    expect(() =>
      parseTrajectoryExport({ schema_version: SCHEMA_VERSION }),
    ).toThrowError(expect.objectContaining({ code: 'malformed' }));
  });

  it('rejects invalid JSON text as malformed', () => {
    expect(() => parseTrajectoryExportJSON('{nope')).toThrowError(
      TrajectorySchemaError,
    );
    expect(() => parseTrajectoryExportJSON('{nope')).toThrowError(
      expect.objectContaining({ code: 'malformed' }),
    );
  });
});

describe('trajectory structural validation', () => {
  it('rejects a non-object input with the JSON-object message', () => {
    for (const input of [null, 'x', 42, [], true]) {
      const err = parseError(input);
      expect(err).toBeInstanceOf(TrajectorySchemaError);
      expect(err.code).toBe('malformed');
    }
    expect(parseError(null).message).toBe('trajectory must be a JSON object');
  });

  it('rejects every malformed schema_version shape, naming the field', () => {
    for (const version of [undefined, null, 1, '', '1', '1.0.0', 'one.zero']) {
      const err = parseError({ ...validExport(), schema_version: version });
      expect(err.code, JSON.stringify(version)).toBe('malformed');
      expect(err.message, JSON.stringify(version)).toMatch(
        /trajectory\.schema_version/,
      );
    }
  });

  it('rejects a null or mistyped trajectory section by its JSON path', () => {
    const cases: Array<[Record<string, unknown>, RegExp]> = [
      [{ actions: null }, /trajectory\.actions must be an array \(got null\)/],
      [{ observations: 'x' }, /trajectory\.observations must be an array/],
      [{ approvals: {} }, /trajectory\.approvals must be an array/],
      [{ model: 'x' }, /trajectory\.model must be an object \(got string\)/],
      [{ result: null }, /trajectory\.result must be an object \(got null\)/],
      [{ task: null }, /trajectory\.task must be an object \(got null\)/],
      [{ usage: null }, /trajectory\.usage must be an object \(got null\)/],
      [{ eval: null }, /trajectory\.eval must be an object \(got null\)/],
    ];
    for (const [override, message] of cases) {
      const err = parseError({ ...validExport(), ...override });
      expect(err.code, JSON.stringify(override)).toBe('malformed');
      expect(err.message, JSON.stringify(override)).toMatch(message);
    }
  });

  it('rejects a missing or mistyped nested key by its JSON path', () => {
    const record = validExport();
    const cases: Array<[Record<string, unknown>, RegExp]> = [
      [
        { result: { ...(record.result as object), status: 'weird' } },
        /trajectory\.result\.status must be one of completed\|failed\|cancelled\|timeout\|turn_limit \(got "weird"\)/,
      ],
      [
        { result: { ...(record.result as object), status: undefined } },
        /trajectory\.result\.status must be a string \(got undefined\)/,
      ],
      [{ model: { provider: 'acme' } }, /trajectory\.model\.model is required/],
      [
        { identity: { sessionId: 'sess-1' } },
        /trajectory\.identity\.agentId is required/,
      ],
      [
        { usage: { ...(record.usage as object), inputTokens: '10' } },
        /trajectory\.usage\.inputTokens must be a number \(got string\)/,
      ],
      [
        { prompt: { text: 1 } },
        /trajectory\.prompt\.text must be a string \(got number\)/,
      ],
      [
        { diff: { ...(record.diff as object), filesChanged: ['a', 2] } },
        /trajectory\.diff\.filesChanged must be an array of strings/,
      ],
      [
        { worktree: { path: '/w', baseRevision: 'abc' } },
        /trajectory\.worktree\.branch is required/,
      ],
    ];
    for (const [override, message] of cases) {
      const err = parseError({ ...record, ...override });
      expect(err.code, JSON.stringify(override)).toBe('malformed');
      expect(err.message, JSON.stringify(override)).toMatch(message);
    }
  });

  it('refuses an environment that was not the used snapshot', () => {
    const record = validExport();
    const err = parseError({
      ...record,
      environment: {
        ...(record.environment as object),
        capturedFrom: 'intended',
      },
    });
    expect(err.code).toBe('malformed');
    expect(err.message).toMatch(
      /trajectory\.environment\.capturedFrom must be 'used' \(got "intended"\)/,
    );
  });

  it('accepts every published result status', () => {
    const record = validExport();
    for (const status of RESULT_STATUSES) {
      const parsed = parseTrajectoryExport({
        ...record,
        result: { ...(record.result as object), status },
      });
      expect(parsed.result.status).toBe(status);
    }
  });

  it('preserves unknown fields at the top level and inside a section', () => {
    const record = validExport();
    const parsed = parseTrajectoryExport({
      ...record,
      future_section: { kept: 1 },
      model: { ...(record.model as object), future_key: 'kept' },
    }) as unknown as Record<string, unknown> & {
      model: Record<string, unknown>;
    };
    expect(parsed.future_section).toEqual({ kept: 1 });
    expect(parsed.model.future_key).toBe('kept');
  });

  it('serializes a malformed error machine-readably with exitCode 3', () => {
    const err = new TrajectorySchemaError(
      'malformed',
      'trajectory.actions must be an array (got null)',
    );
    expect(err.exitCode).toBe(3);
    expect(err.toJSON()).toEqual({
      error: {
        code: 'malformed',
        message: 'trajectory.actions must be an array (got null)',
        exitCode: 3,
      },
    });
  });

  it('recognizes the failure codes and nothing else', () => {
    expect(isTrajectoryFailureCode('tool_timeout')).toBe(true);
    expect(isTrajectoryFailureCode('run_limit')).toBe(true);
    expect(isTrajectoryFailureCode('made_up_code')).toBe(false);
    expect(isTrajectoryFailureCode('completed')).toBe(false);
    expect(isTrajectoryFailureCode('')).toBe(false);
  });
});

describe('trajectory 1.0 sections', () => {
  it('exports only the 1.0 keys of each section', () => {
    const record = validExport();
    const keysOf = (section: string): string[] =>
      Object.keys(record[section] as Record<string, unknown>).sort();
    expect(keysOf('identity')).toEqual(['agentId', 'sessionId']);
    expect(keysOf('prompt')).toEqual(['text']);
    expect(keysOf('resources')).toEqual(['skills']);
    expect(keysOf('state')).toEqual(['phase']);
    expect(keysOf('provenance')).toEqual([
      'agentId',
      'model',
      'pid',
      'sessionId',
      'worktree',
    ]);
    expect(keysOf('result')).toEqual([
      'error',
      'failureCategory',
      'status',
      'summary',
    ]);
    expect(keysOf('eval')).toEqual(['labels']);
    expect(record).not.toHaveProperty('transfer');
  });

  it('type-checks every escalation and approval entry, naming the JSON path', () => {
    const record = validExport();
    const model = record.model as Record<string, unknown>;
    const escalation = {
      reason: 'r',
      at: '2026-09-23T10:00:30.000Z',
      fromModel: 'acme/m1',
      toModel: 'acme/m2',
      thinking: null,
    };
    const approval = {
      approvalId: 'a',
      capability: 'c',
      verdict: 'approved',
      by: null,
    };
    // One wrong-type case per required key of an escalation and an approval:
    // dropping an entry from the required tables would let its case pass.
    const cases: Array<[string, Record<string, unknown>, RegExp]> = [
      [
        'model.escalations[0].reason',
        { model: { ...model, escalations: [{ ...escalation, reason: 1 }] } },
        /trajectory\.model\.escalations\[0\]\.reason must be a string \(got number\)/,
      ],
      [
        'model.escalations[0].at',
        { model: { ...model, escalations: [{ ...escalation, at: null }] } },
        /trajectory\.model\.escalations\[0\]\.at must be a string \(got null\)/,
      ],
      [
        'model.escalations[0].fromModel',
        {
          model: { ...model, escalations: [{ ...escalation, fromModel: 1 }] },
        },
        /trajectory\.model\.escalations\[0\]\.fromModel must be a string or null \(got number\)/,
      ],
      [
        'model.escalations[0].toModel',
        { model: { ...model, escalations: [{ ...escalation, toModel: 1 }] } },
        /trajectory\.model\.escalations\[0\]\.toModel must be a string or null \(got number\)/,
      ],
      [
        'model.escalations[0].thinking',
        { model: { ...model, escalations: [{ ...escalation, thinking: 5 }] } },
        /trajectory\.model\.escalations\[0\]\.thinking must be a string or null \(got number\)/,
      ],
      [
        'model.escalations[0] (non-object)',
        { model: { ...model, escalations: [5] } },
        /trajectory\.model\.escalations\[0\] must be an object \(got number\)/,
      ],
      [
        'approvals[0].approvalId',
        { approvals: [{ ...approval, approvalId: 2 }] },
        /trajectory\.approvals\[0\]\.approvalId must be a string \(got number\)/,
      ],
      [
        'approvals[0].by',
        { approvals: [{ ...approval, by: 5 }] },
        /trajectory\.approvals\[0\]\.by must be a string or null \(got number\)/,
      ],
      [
        'approvals[0] (non-object)',
        { approvals: [5] },
        /trajectory\.approvals\[0\] must be an object \(got number\)/,
      ],
    ];
    for (const [label, override, message] of cases) {
      const err = parseError({ ...record, ...override });
      expect(err.code, label).toBe('malformed');
      expect(err.message, label).toMatch(message);
    }
  });

  it('reads an escalation an earlier build recorded with only its reason and time', () => {
    const record = validExport();
    const parsed = parseTrajectoryExport({
      ...record,
      model: {
        ...(record.model as object),
        escalations: [
          {
            reason: 'context overflow',
            at: '2026-10-04T10:00:30.000Z',
            future_key: 'kept',
          },
        ],
      },
    });
    expect(parsed.model.escalations).toEqual([
      {
        reason: 'context overflow',
        at: '2026-10-04T10:00:30.000Z',
        fromModel: null,
        toModel: null,
        thinking: null,
        future_key: 'kept',
      },
    ]);
  });

  // Eval parses an export that the CLI has already parsed. The first read fills
  // an absent endpoint with null, so the second read must accept that shape.
  it('parses a parsed export again, unchanged', () => {
    const record = validExport();
    const model = record.model as Record<string, unknown>;
    const once = parseTrajectoryExport({
      ...record,
      model: {
        ...model,
        escalations: [
          { reason: 'context overflow', at: '2026-10-04T10:00:30.000Z' },
        ],
      },
    });
    expect(parseTrajectoryExport(once)).toEqual(once);
    expect(parseTrajectoryExportJSON(JSON.stringify(once))).toEqual(once);
  });

  it('reads an export an earlier build wrote at schema 1.3, keeping the keys 1.0 no longer defines', () => {
    const record = validExport();
    const parsed = parseTrajectoryExport({
      ...record,
      schema_version: '1.3',
      identity: {
        ...(record.identity as object),
        workerId: null,
        role: 'writer',
      },
      prompt: { ...(record.prompt as object), constraints: [] },
      state: { phase: 'done', snapshot: {}, operations: [], memos: [] },
      provenance: { ...(record.provenance as object), generation: 0 },
      result: { ...(record.result as object), tests: [], artifacts: [] },
      eval: { suite: null, caseId: null, labels: {} },
    });
    expect(parsed.schema_version).toBe('1.3');
    expect(parsed.provenance).toMatchObject({ generation: 0 });
    expect(parsed.eval).toEqual({ suite: null, caseId: null, labels: {} });
  });
});
