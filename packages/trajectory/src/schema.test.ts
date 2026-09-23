import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  parseTrajectoryExport,
  parseTrajectoryExportJSON,
  SCHEMA_MAJOR,
  SCHEMA_VERSION,
  TRAJECTORY_CHANGELOG,
  TRAJECTORY_STABILITY,
  TrajectorySchemaError,
} from './schema.js';

describe('trajectory schema version (issue #51)', () => {
  it('publishes schema_version 1.0', () => {
    expect(SCHEMA_VERSION).toBe('1.0');
    expect(SCHEMA_MAJOR).toBe(1);
  });

  it('rejects an unknown major with a clear machine-readable error', () => {
    const err = (() => {
      try {
        parseTrajectoryExport({ schema_version: '2.0' });
      } catch (e) {
        return e as TrajectorySchemaError;
      }
      throw new Error('parse accepted major 2 — expected rejection');
    })();
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
    const sections: Record<string, null> = {};
    for (const key of [
      'task',
      'identity',
      'model',
      'prompt',
      'resources',
      'transfer',
      'actions',
      'observations',
      'state',
      'provenance',
      'environment',
      'worktree',
      'diff',
      'approvals',
      'timestamps',
      'usage',
      'result',
      'eval',
    ]) {
      sections[key] = null;
    }
    const parsed = parseTrajectoryExport({
      ...sections,
      schema_version: `${SCHEMA_MAJOR}.99`,
    });
    expect(parsed.schema_version).toBe(`${SCHEMA_MAJOR}.99`);
  });

  it('rejects a record missing a §46 field as malformed', () => {
    expect(() =>
      parseTrajectoryExport({ schema_version: SCHEMA_VERSION }),
    ).toThrowError(TrajectorySchemaError);
  });

  it('rejects invalid JSON text as malformed', () => {
    expect(() => parseTrajectoryExportJSON('{nope')).toThrowError(
      TrajectorySchemaError,
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
