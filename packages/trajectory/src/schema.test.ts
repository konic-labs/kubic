import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
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

// A full, valid record through the real builder (issue #331): the
// minor-tolerance and structural tests below mutate one field of it, so
// they exercise the parser, not a hand-drawn shape.
function validInput(): BuildTrajectoryInput {
  return {
    task: { taskId: 'task-1', objective: 'Fix the widget', role: 'writer' },
    identity: { sessionId: 'sess-1', agentId: 'agent-1', workerId: null },
    model: { provider: 'acme', model: 'm1', thinking: null, escalations: [] },
    prompt: { text: 'Fix the widget', constraints: [] },
    resources: { skills: [], promptTemplates: [] },
    transfer: null,
    actions: [],
    observations: [],
    state: { phase: 'done', snapshot: null },
    provenance: {
      sessionId: 'sess-1',
      agentId: 'agent-1',
      pid: null,
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

describe('trajectory schema version (issue #51)', () => {
  it('publishes schema_version 1.1', () => {
    expect(SCHEMA_VERSION).toBe('1.1');
    expect(SCHEMA_MAJOR).toBe(1);
  });

  it('rejects an unknown major with a clear machine-readable error', () => {
    const err = parseError({ ...validExport(), schema_version: '2.0' });
    expect(err).toBeInstanceOf(TrajectorySchemaError);
    expect(err.code).toBe('unknown-major');
    expect(err.exitCode).not.toBe(0);
    expect(err.message).toMatch(/2.*major 1|major 1.*2/i);
  });

  it('publishes stability and a changelog headed by the current version', () => {
    expect(TRAJECTORY_STABILITY).toBe('stable');
    expect(TRAJECTORY_CHANGELOG.length).toBeGreaterThan(0);
    expect(TRAJECTORY_CHANGELOG[0]?.version).toBe(SCHEMA_VERSION);
  });

  it('accepts a newer minor of the same major (tolerant, no shim)', () => {
    const parsed = parseTrajectoryExport({
      ...validExport(),
      schema_version: `${SCHEMA_MAJOR}.99`,
    });
    expect(parsed.schema_version).toBe(`${SCHEMA_MAJOR}.99`);
  });

  it('rejects a record missing a §46 field as malformed', () => {
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

  it('publishes CONTRACT.md naming the current schema version', () => {
    const contract = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), '..', 'CONTRACT.md'),
      'utf8',
    );
    expect(contract).toContain(SCHEMA_VERSION);
    expect(contract).toContain('stable');
  });
});

describe('trajectory structural validation (issue #331)', () => {
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

  it('rejects a null or mistyped §46 section by its JSON path', () => {
    const cases: Array<[Record<string, unknown>, RegExp]> = [
      [{ actions: null }, /trajectory\.actions must be an array \(got null\)/],
      [{ observations: 'x' }, /trajectory\.observations must be an array/],
      [{ approvals: {} }, /trajectory\.approvals must be an array/],
      [{ model: 'x' }, /trajectory\.model must be an object \(got string\)/],
      [{ result: null }, /trajectory\.result must be an object \(got null\)/],
      [{ task: null }, /trajectory\.task must be an object \(got null\)/],
      [{ usage: null }, /trajectory\.usage must be an object \(got null\)/],
      [
        { transfer: 'x' },
        /trajectory\.transfer must be an object or null \(got string\)/,
      ],
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
        /trajectory\.result\.status must be one of completed\|failed\|cancelled\|timeout\|budget_exhausted\|spawn_failed \(got "weird"\)/,
      ],
      [
        { result: { ...(record.result as object), status: undefined } },
        /trajectory\.result\.status must be a string \(got undefined\)/,
      ],
      [{ model: { provider: 'acme' } }, /trajectory\.model\.model is required/],
      [
        { usage: { ...(record.usage as object), inputTokens: '10' } },
        /trajectory\.usage\.inputTokens must be a number \(got string\)/,
      ],
      [
        { prompt: { text: 1, constraints: [] } },
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

  it('recognizes the §52 failure codes and nothing else', () => {
    expect(isTrajectoryFailureCode('tool_timeout')).toBe(true);
    expect(isTrajectoryFailureCode('budget_exhausted')).toBe(true);
    expect(isTrajectoryFailureCode('completed')).toBe(false);
    expect(isTrajectoryFailureCode('')).toBe(false);
  });
});

describe('trajectory schema 1.1 (issue #329)', () => {
  it('parses a 1.0 record without any 1.1 field (compat)', () => {
    const record = validExport();
    const identity = { ...(record.identity as Record<string, unknown>) };
    delete identity.parentSessionId;
    delete identity.role;
    const state = { ...(record.state as Record<string, unknown>) };
    delete state.operations;
    delete state.memos;
    const result = { ...(record.result as Record<string, unknown>) };
    delete result.tests;
    delete result.artifacts;
    const parsed = parseTrajectoryExport({
      ...record,
      schema_version: '1.0',
      identity,
      state,
      result,
    });
    expect(parsed.schema_version).toBe('1.0');
    expect(parsed.identity.parentSessionId).toBeUndefined();
    expect(parsed.identity.role).toBeUndefined();
    expect(parsed.state.operations).toBeUndefined();
    expect(parsed.state.memos).toBeUndefined();
    expect(parsed.result.tests).toBeUndefined();
    expect(parsed.result.artifacts).toBeUndefined();
  });

  it('type-checks the 1.1 fields when present, naming the JSON path', () => {
    const record = validExport();
    const cases: Array<[Record<string, unknown>, RegExp]> = [
      [
        { identity: { ...(record.identity as object), parentSessionId: 5 } },
        /trajectory\.identity\.parentSessionId must be a string or null/,
      ],
      [
        { identity: { ...(record.identity as object), role: null } },
        /trajectory\.identity\.role must be a string \(got null\)/,
      ],
      [
        { state: { ...(record.state as object), memos: ['a', 2] } },
        /trajectory\.state\.memos must be an array of strings/,
      ],
      [
        { result: { ...(record.result as object), tests: 'x' } },
        /trajectory\.result\.tests must be an array of strings/,
      ],
      [
        {
          model: {
            ...(record.model as object),
            escalations: [{ reason: 'r', at: 't', toModel: 1 }],
          },
        },
        /trajectory\.model\.escalations\[0\]\.toModel must be a string/,
      ],
      [
        {
          approvals: [
            {
              approvalId: 'a',
              capability: 'c',
              verdict: 'approved',
              by: null,
              justification: 5,
            },
          ],
        },
        /trajectory\.approvals\[0\]\.justification must be a string or null/,
      ],
      [
        {
          state: { ...(record.state as object), operations: [{ id: 'op-1' }] },
        },
        /trajectory\.state\.operations\[0\]\.kind is required/,
      ],
    ];
    for (const [override, message] of cases) {
      const err = parseError({ ...record, ...override });
      expect(err.code, JSON.stringify(override)).toBe('malformed');
      expect(err.message, JSON.stringify(override)).toMatch(message);
    }
  });
});
