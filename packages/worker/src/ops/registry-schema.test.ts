// Tool parameter schemas agree with the Kubic validators. The schema is what
// the model sees and what Pi validates before a call runs; the validator is
// authoritative inside Kubic. The two must accept the same keys: every
// validator-accepted fixture passes the schema, a missing required key fails
// both, and an unknown key fails both.
import { describe, expect, it } from 'vitest';
import { validateToolArguments } from '../pi-boundary.js';
import {
  OPERATION_PARAMETERS,
  OPERATIONS,
  type OperationName,
} from './registry.js';

interface Fixtures {
  // Every key the op accepts, all valid.
  full: Record<string, unknown>;
  required: readonly string[];
}

const FIXTURES: Record<OperationName, Fixtures> = {
  read: { full: { path: 'a.txt', offset: 2, limit: 5 }, required: ['path'] },
  ls: { full: { path: 'src' }, required: [] },
  find: {
    full: { root: 'src', nameContains: '.ts', type: 'file', maxResults: 5 },
    required: [],
  },
  grep: {
    full: { pattern: 'TODO', root: 'src', include: '.ts', maxMatches: 3 },
    required: ['pattern'],
  },
  write: {
    full: { path: 'a.txt', content: 'x\n' },
    required: ['path', 'content'],
  },
  edit: {
    full: { path: 'a.txt', oldText: 'a', newText: 'b', expectCount: 2 },
    required: ['path', 'oldText', 'newText'],
  },
  bash: { full: { command: 'echo hi', timeout: 1.5 }, required: ['command'] },
  git_status: { full: {}, required: [] },
  git_diff: {
    full: { staged: true, range: 'HEAD~1..HEAD', path: 'src' },
    required: [],
  },
  git_log: { full: { max: 5, path: 'src' }, required: [] },
  git_show: { full: { ref: 'HEAD' }, required: ['ref'] },
  git_stage: { full: { paths: ['a.txt', 'b.txt'] }, required: ['paths'] },
  git_commit: {
    full: { message: 'feat: x', amend: false },
    required: ['message'],
  },
  git_branch: { full: { create: 'topic' }, required: [] },
  git_checkpoint: {
    full: { message: 'before refactor' },
    required: ['message'],
  },
  git_merge: { full: { branch: 'feature' }, required: ['branch'] },
  git_conflict_status: { full: {}, required: [] },
  git_worktree_list: { full: {}, required: [] },
};

const NAMES = Object.keys(OPERATIONS) as OperationName[];

function schemaAccepts(name: OperationName, args: unknown): boolean {
  try {
    validateToolArguments(
      { name, description: '', parameters: OPERATION_PARAMETERS[name] },
      { type: 'toolCall', id: 't1', name, arguments: args as never },
    );
    return true;
  } catch {
    return false;
  }
}

function validatorAccepts(name: OperationName, args: unknown): boolean {
  try {
    OPERATIONS[name].validateArgs(args);
    return true;
  } catch {
    return false;
  }
}

describe('operation parameter schemas', () => {
  it('covers every registered operation', () => {
    expect(Object.keys(OPERATION_PARAMETERS).sort()).toEqual([...NAMES].sort());
    expect(Object.keys(FIXTURES).sort()).toEqual([...NAMES].sort());
  });

  it.each(NAMES)(
    '%s: schema keys equal the validator-accepted keys',
    (name) => {
      const schema = OPERATION_PARAMETERS[name] as {
        type?: string;
        properties?: Record<string, { description?: string }>;
        required?: string[];
        additionalProperties?: unknown;
      };
      expect(schema.type).toBe('object');
      expect(schema.additionalProperties).toBe(false);
      const { full, required } = FIXTURES[name];
      expect(Object.keys(schema.properties ?? {}).sort()).toEqual(
        Object.keys(full).sort(),
      );
      expect([...(schema.required ?? [])].sort()).toEqual([...required].sort());
      // Every argument tells the model what it is.
      for (const [key, property] of Object.entries(schema.properties ?? {})) {
        expect(property.description, `${name}.${key}`).toMatch(/\S/);
      }
    },
  );

  it.each(NAMES)(
    '%s: the validator-accepted full fixture passes both',
    (name) => {
      const { full } = FIXTURES[name];
      expect(validatorAccepts(name, full)).toBe(true);
      expect(schemaAccepts(name, full)).toBe(true);
    },
  );

  it.each(NAMES)('%s: the required-only fixture passes both', (name) => {
    const { full, required } = FIXTURES[name];
    const minimal = Object.fromEntries(
      Object.entries(full).filter(([key]) => required.includes(key)),
    );
    expect(validatorAccepts(name, minimal)).toBe(true);
    expect(schemaAccepts(name, minimal)).toBe(true);
  });

  it.each(NAMES)('%s: omitting any required key fails both', (name) => {
    const { full, required } = FIXTURES[name];
    for (const key of required) {
      const { [key]: _dropped, ...rest } = full;
      expect(validatorAccepts(name, rest), `validator without ${key}`).toBe(
        false,
      );
      expect(schemaAccepts(name, rest), `schema without ${key}`).toBe(false);
    }
  });

  it.each(NAMES)('%s: an unknown key fails both', (name) => {
    const args = { ...FIXTURES[name].full, file_path: 'guess.txt' };
    expect(validatorAccepts(name, args)).toBe(false);
    expect(schemaAccepts(name, args)).toBe(false);
  });
});
