// RL dataset batch export. A directory or glob of
// trajectory exports in, one JSONL of dataset records plus a manifest out.
//
// Pairing and grouping are automatic and policy-preserving: the existing
// builders decide eligibility (env failures, cross-boundary runs, missing
// preference signal, prompt/task mismatches) and every exclusion is counted
// by tag in the manifest — never silently dropped. Pairs are every
// pass×fail combination within one task+prompt; a GRPO group holds every
// candidate of that task+prompt, so it is not capped at two.
//
// Streaming: the first pass reads one trajectory at a time and keeps only
// its small index (path, task, prompt) plus the provenance summary; the
// second pass loads one group at a time and appends each record as it is
// built. Peak memory is one group, not the dataset.
import { join } from 'node:path';
import type { ExitCode } from '@kubic/core/cli/exit-codes';
import { formatJson } from '@kubic/core/cli/output';
import {
  parseTrajectoryExportJSON,
  type TrajectoryExport,
} from '@kubic/trajectory/schema';
import { buildCodingRecord } from './coding.js';
import { buildDpoRecord } from './dpo.js';
import { buildGrpoGroup } from './grpo.js';
import { canonicalJson } from './manifest.js';
import { buildPreferencePair } from './preference.js';
import { buildSftRecord } from './sft.js';
import { buildToolUseRecord } from './tooluse.js';
import { referenceVerifier } from './verifier.js';

const DATASET_SCHEMA = 'dataset/1';

export type ExportDatasetType =
  | 'sft'
  | 'dpo'
  | 'grpo'
  | 'preference'
  | 'tooluse'
  | 'coding';

export const DATASET_TYPES: readonly ExportDatasetType[] = [
  'sft',
  'dpo',
  'grpo',
  'preference',
  'tooluse',
  'coding',
];

// One record per trajectory, no pairing.
const SINGLE_RECORD_TYPES: ReadonlySet<ExportDatasetType> = new Set([
  'sft',
  'tooluse',
  'coding',
]);

export interface DatasetDirEntry {
  name: string;
  isDirectory: boolean;
}

// The I/O seam (exec FileBridge in prod): listing resolves the dataset
// operand, reading parses one trajectory, writing appends one JSONL line
// (or resets the file), and the manifest lands beside the JSONL.
export interface DatasetFs {
  listDir: (path: string) => DatasetDirEntry[];
  readFile: (path: string) => string;
  writeFile: (path: string, content: string) => void;
  appendFile: (path: string, content: string) => void;
}

export type DatasetErrorCode =
  | 'dataset-empty'
  | 'dataset-unsupported'
  | 'dataset-invalid';

export class DatasetError extends Error {
  readonly code: DatasetErrorCode;
  readonly exitCode: ExitCode;

  constructor(code: DatasetErrorCode, message: string, exitCode: ExitCode) {
    super(message);
    this.name = 'DatasetError';
    this.code = code;
    this.exitCode = exitCode;
  }

  toJSON(): { error: { code: string; message: string; exitCode: ExitCode } } {
    return {
      error: {
        code: this.code,
        message: this.message,
        exitCode: this.exitCode,
      },
    };
  }
}

interface DatasetExclusion {
  file: string;
  tag: string;
  reason: string;
}

export interface DatasetManifest {
  schema: typeof DATASET_SCHEMA;
  type: ExportDatasetType;
  dataset: string;
  out: string;
  manifest: string;
  files: number;
  records: number;
  // Exclusions by tag (env-failure-excluded, cross-boundary-excluded,
  // no-preference-signal-excluded, prompt-mismatch-excluded,
  // no-counterpart-excluded, singleton-excluded).
  excluded: Record<string, number>;
  exclusions: DatasetExclusion[];
  // Distinct provenance values across the dataset, sorted.
  provenance: {
    sessions: string[];
    worktrees: string[];
    models: string[];
  };
}

export interface DatasetExportOptions {
  type: ExportDatasetType;
  dataset: string;
  out: string;
  fs: DatasetFs;
}

function globToRegExp(pattern: string): RegExp {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '[^/]*')
    .replace(/\?/g, '[^/]');
  return new RegExp(`^${escaped}$`);
}

function tryList(fs: DatasetFs, path: string): DatasetDirEntry[] | null {
  try {
    return fs.listDir(path);
  } catch {
    return null;
  }
}

// The dataset operand is a directory (every `.json` it holds) or a glob
// (`*`/`?` in the basename). Files come back sorted so the JSONL and the
// manifest are byte-stable across runs.
/** @internal */
export function resolveDatasetFiles(pattern: string, fs: DatasetFs): string[] {
  const trimmed = pattern.replace(/\/+$/, '');
  const asDir = tryList(fs, trimmed === '' ? '/' : trimmed);
  if (asDir !== null) {
    return asDir
      .filter((entry) => !entry.isDirectory && entry.name.endsWith('.json'))
      .map((entry) => join(trimmed === '' ? '/' : trimmed, entry.name))
      .sort();
  }
  const slash = trimmed.lastIndexOf('/');
  const dir =
    slash === -1
      ? '.'
      : trimmed.slice(0, slash) === ''
        ? '/'
        : trimmed.slice(0, slash);
  const base = slash === -1 ? trimmed : trimmed.slice(slash + 1);
  const entries = tryList(fs, dir);
  if (entries === null) {
    throw new DatasetError(
      'dataset-empty',
      `dataset ${JSON.stringify(pattern)} is neither a directory nor a readable glob`,
      2,
    );
  }
  const matcher = globToRegExp(base);
  return entries
    .filter((entry) => !entry.isDirectory && matcher.test(entry.name))
    .map((entry) => join(dir, entry.name))
    .sort();
}

function singleRecord(
  type: ExportDatasetType,
  exported: TrajectoryExport,
): unknown {
  switch (type) {
    case 'sft':
      return buildSftRecord(exported);
    case 'tooluse':
      return buildToolUseRecord(exported);
    case 'coding':
      return buildCodingRecord(exported);
    default:
      throw new Error(`unreachable: ${type} is not a single-record type`);
  }
}

export function exportDataset(options: DatasetExportOptions): DatasetManifest {
  const { fs } = options;
  const files = resolveDatasetFiles(options.dataset, fs);
  if (files.length === 0) {
    throw new DatasetError(
      'dataset-empty',
      `no trajectory files match ${JSON.stringify(options.dataset)} — nothing to export`,
      2,
    );
  }
  const manifestPath = `${options.out}.manifest.json`;
  const sessions = new Set<string>();
  const worktrees = new Set<string>();
  const models = new Set<string>();
  const excluded: Record<string, number> = {};
  const exclusions: DatasetExclusion[] = [];
  let records = 0;

  // A rerun replaces the artifact; it never appends to a stale JSONL.
  fs.writeFile(options.out, '');

  const append = (record: unknown): void => {
    fs.appendFile(options.out, `${canonicalJson(record)}\n`);
    records += 1;
  };
  const exclude = (file: string, tag: string, reason: string): void => {
    excluded[tag] = (excluded[tag] ?? 0) + 1;
    exclusions.push({ file, tag, reason });
  };
  const load = (file: string): TrajectoryExport => {
    try {
      return parseTrajectoryExportJSON(fs.readFile(file));
    } catch (error) {
      throw new DatasetError(
        'dataset-invalid',
        `${file}: ${error instanceof Error ? error.message : String(error)}`,
        1,
      );
    }
  };
  const collect = (exported: TrajectoryExport): void => {
    sessions.add(exported.provenance.sessionId);
    worktrees.add(exported.provenance.worktree);
    models.add(exported.provenance.model);
  };
  const build = <T>(file: string, make: () => T): T => {
    try {
      return make();
    } catch (error) {
      throw new DatasetError(
        'dataset-invalid',
        `${file}: ${error instanceof Error ? error.message : String(error)}`,
        1,
      );
    }
  };

  const index: Array<{ file: string; taskId: string; prompt: string }> = [];
  for (const file of files) {
    const exported = load(file);
    collect(exported);
    if (SINGLE_RECORD_TYPES.has(options.type)) {
      append(build(file, () => singleRecord(options.type, exported)));
    } else {
      index.push({
        file,
        taskId: exported.task.taskId,
        prompt: exported.prompt.text,
      });
    }
  }

  if (!SINGLE_RECORD_TYPES.has(options.type)) {
    // Group by task + prompt: a pair or group ranks answers to ONE prompt, so
    // different prompts never mix. Group keys are processed in sorted order, so
    // the JSONL is deterministic.
    const groups = new Map<string, typeof index>();
    for (const entry of index) {
      const key = `${entry.taskId}\u0000${entry.prompt}`;
      const group = groups.get(key);
      if (group === undefined) groups.set(key, [entry]);
      else group.push(entry);
    }
    for (const key of [...groups.keys()].sort()) {
      const group = groups.get(key) as typeof index;
      // One group in memory at a time (streaming, bounded).
      const entries = group.map((entry) => ({
        ...entry,
        exported: load(entry.file),
      }));
      if (options.type === 'grpo') {
        if (entries.length < 2) {
          const first = entries[0] as (typeof entries)[number];
          exclude(
            first.file,
            'singleton-excluded',
            `task ${JSON.stringify(first.taskId)} has ${entries.length} candidate(s) — a group needs at least two`,
          );
          continue;
        }
        append(
          build(group[0]?.file ?? '', () =>
            buildGrpoGroup(entries.map((entry) => entry.exported)),
          ),
        );
        continue;
      }
      const passes = entries.filter(
        (entry) => referenceVerifier(entry.exported).verdict === 'pass',
      );
      const fails = entries.filter(
        (entry) => referenceVerifier(entry.exported).verdict === 'fail',
      );
      if (passes.length === 0 || fails.length === 0) {
        const first = entries[0] as (typeof entries)[number];
        exclude(
          first.file,
          'no-counterpart-excluded',
          `task ${JSON.stringify(first.taskId)} has ${passes.length} passing and ${fails.length} failing candidate(s) — a pair needs one of each`,
        );
        continue;
      }
      for (const pass of passes) {
        for (const fail of fails) {
          if (options.type === 'dpo') {
            const built = build(pass.file, () =>
              buildDpoRecord(pass.exported, fail.exported),
            );
            if (built.record === null) {
              const exclusion = built.excluded;
              if (exclusion !== null) {
                exclude(pass.file, exclusion.tag, exclusion.reason);
              }
            } else {
              append(built.record);
            }
          } else {
            const built = build(pass.file, () =>
              buildPreferencePair(pass.exported, fail.exported),
            );
            if (built.pair === null) {
              const exclusion = built.excluded;
              if (exclusion !== null) {
                exclude(pass.file, exclusion.tag, exclusion.reason);
              }
            } else {
              append(built.pair);
            }
          }
        }
      }
    }
  }

  const manifest: DatasetManifest = {
    schema: DATASET_SCHEMA,
    type: options.type,
    dataset: options.dataset,
    out: options.out,
    manifest: manifestPath,
    files: files.length,
    records,
    excluded,
    exclusions,
    provenance: {
      sessions: [...sessions].sort(),
      worktrees: [...worktrees].sort(),
      models: [...models].sort(),
    },
  };
  fs.writeFile(manifestPath, `${formatJson(manifest)}\n`);
  return manifest;
}
