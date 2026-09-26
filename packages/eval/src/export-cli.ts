// `kubic export` command surface (issue #78): trajectory-export
// inspection plus RL dataset export (#51 + #54 libraries).
// Presentation only: argv in, exit code out. Trajectory files arrive
// through the injected readFile (I/O confinement — this package never
// touches node:fs); dataset records are built + validated with ./rl/*
// over the stable trajectory contract (major 1).
// One entry, two halves: without --type the trajectory export file is
// validated and described (provenance, model, result, usage); with
// --type a dataset record is built — single-trajectory types (sft,
// tooluse, coding) from --trajectory alone, pair/group types (dpo,
// preference, grpo) from --trajectory plus --against. Pair policy is
// preserved: an excluded (env-failure / cross-boundary) pair prints its
// exclusion tag with exit 0, never a training record.
// Exit codes: 0 exported/described, 1 build-or-validation failure,
// 2 usage/error (missing flags, unreadable/malformed files, refused
// provenance — never an emitted record).

import { answerHelp } from '../../core/src/cli-help.js';
import { type FlagSpec, parseFlagArgs } from '../../core/src/flags.js';
import {
  parseTrajectoryExportJSON,
  type TrajectoryExport,
  TrajectorySchemaError,
} from '../../trajectory/src/schema.js';
import { buildCodingRecord, validateCodingRecord } from './rl/coding.js';
import { buildDpoRecord, validateDpoRecord } from './rl/dpo.js';
import { buildGrpoGroup, validateGrpoGroup } from './rl/grpo.js';
import { canonicalJson } from './rl/manifest.js';
import {
  buildPreferencePair,
  validatePreferencePair,
} from './rl/preference.js';
import { buildSftRecord, validateSftRecord } from './rl/sft.js';
import { buildToolUseRecord, validateToolUseRecord } from './rl/tooluse.js';
import { RlProvenanceError } from './rl/types.js';

export const EXPORT_EXIT_OK = 0;
export const EXPORT_EXIT_FAILED = 1;
export const EXPORT_EXIT_USAGE = 2;

export interface ExportCliDeps {
  readFile: (path: string) => string;
  out: (line: string) => void;
}

export type ExportDatasetType =
  | 'sft'
  | 'dpo'
  | 'grpo'
  | 'preference'
  | 'tooluse'
  | 'coding';

const DATASET_TYPES: readonly ExportDatasetType[] = [
  'sft',
  'dpo',
  'grpo',
  'preference',
  'tooluse',
  'coding',
];

// Pair/group types consume two trajectory files (--trajectory + --against);
// single-trajectory types refuse a stray --against rather than ignoring it.
const NEEDS_AGAINST: ReadonlySet<ExportDatasetType> = new Set([
  'dpo',
  'grpo',
  'preference',
]);

export const USAGE_MESSAGE =
  'usage: kubic export --trajectory <file> [--type sft|dpo|grpo|preference|tooluse|coding] [--against <other.json>] [--json]';

interface ExportOptions {
  trajectory: string;
  type: ExportDatasetType | undefined;
  against: string | undefined;
  json: boolean;
}

function isDatasetType(value: string): value is ExportDatasetType {
  return (DATASET_TYPES as readonly string[]).includes(value);
}

// Issue #127: the shared parser's spec for this command's flags.
const EXPORT_FLAG_SPEC: readonly FlagSpec[] = [
  { name: '--trajectory', takes: 'value' },
  { name: '--type', takes: 'value' },
  { name: '--against', takes: 'value' },
  { name: '--json', takes: 'boolean' },
];

function parseArgs(args: string[]): ExportOptions | null {
  // Issue #127: the shared parser replaces the hand-rolled loop. Every
  // syntax problem keeps the pre-migration posture — null, which the
  // caller turns into the usage line and exit 2.
  const flags = parseFlagArgs(args, EXPORT_FLAG_SPEC);
  if (
    flags.missing.length > 0 ||
    flags.unknown.length > 0 ||
    flags.positional.length > 0
  ) {
    return null;
  }
  const trajectory = flags.values['--trajectory'] as string | undefined;
  if (trajectory === undefined) return null;
  const typeRaw = flags.values['--type'] as string | undefined;
  let type: ExportDatasetType | undefined;
  if (typeRaw !== undefined) {
    if (!isDatasetType(typeRaw)) return null;
    type = typeRaw;
  }
  const against = flags.values['--against'] as string | undefined;
  if (type !== undefined && NEEDS_AGAINST.has(type) && against === undefined) {
    return null;
  }
  if (type !== undefined && !NEEDS_AGAINST.has(type) && against !== undefined) {
    return null;
  }
  return { trajectory, type, against, json: flags.values['--json'] === true };
}

function loadExport(
  readFile: (path: string) => string,
  path: string,
): { exported: TrajectoryExport } | { code: string; message: string } {
  let raw: string;
  try {
    raw = readFile(path);
  } catch (error) {
    return {
      code: 'trajectory-unreadable',
      message: `cannot read trajectory ${JSON.stringify(path)}: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  try {
    return { exported: parseTrajectoryExportJSON(raw) };
  } catch (error) {
    if (error instanceof TrajectorySchemaError) {
      return { code: error.code, message: error.message };
    }
    return {
      code: 'trajectory-malformed',
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

function modelIdOf(exported: TrajectoryExport): string {
  return `${exported.model.provider}/${exported.model.model}`;
}

function describeText(exported: TrajectoryExport): string[] {
  const tokens = exported.usage.inputTokens + exported.usage.outputTokens;
  return [
    `schema: ${exported.schema_version}`,
    `task: ${exported.task.taskId} — ${exported.task.objective}`,
    `model: ${modelIdOf(exported)}`,
    `provenance: pid=${String(exported.provenance.pid)} generation=${exported.provenance.generation} worktree=${exported.provenance.worktree} model=${exported.provenance.model}`,
    `result: ${exported.result.status} — ${exported.result.summary}`,
    `usage: ${tokens} tokens $${exported.usage.costUsd} ${exported.usage.requests} request(s)`,
  ];
}

function describeJson(exported: TrajectoryExport): unknown {
  return {
    schema: exported.schema_version,
    task: exported.task,
    model: modelIdOf(exported),
    provenance: {
      proc: exported.provenance.pid,
      gen: exported.provenance.generation,
      worktree: exported.provenance.worktree,
      model: exported.provenance.model,
      base: exported.worktree.baseRevision,
    },
    result: {
      status: exported.result.status,
      summary: exported.result.summary,
    },
    usage: exported.usage,
  };
}

export async function runExportCommand(
  args: string[],
  deps: ExportCliDeps,
): Promise<number> {
  // `--help`/`-h` prints the usage line and exits 0 (issue #100).
  const help = answerHelp(args, deps.out, USAGE_MESSAGE);
  if (help !== null) return help;
  const parsed = parseArgs(args);
  if (parsed === null) {
    deps.out(USAGE_MESSAGE);
    return EXPORT_EXIT_USAGE;
  }
  const fail = (code: string, message: string): number => {
    if (parsed.json) {
      deps.out(
        JSON.stringify({
          ok: false,
          exitCode: EXPORT_EXIT_USAGE,
          error: { code, message },
        }),
      );
    } else {
      deps.out(`export error [${code}]: ${message}`);
    }
    return EXPORT_EXIT_USAGE;
  };
  const loaded = loadExport(deps.readFile, parsed.trajectory);
  if (!('exported' in loaded)) return fail(loaded.code, loaded.message);
  const exported = loaded.exported;

  // No --type: validate + describe the trajectory export itself.
  if (parsed.type === undefined) {
    if (parsed.json) {
      deps.out(
        JSON.stringify({
          ok: true,
          exitCode: EXPORT_EXIT_OK,
          trajectory: describeJson(exported),
        }),
      );
    } else {
      for (const line of describeText(exported)) deps.out(line);
    }
    return EXPORT_EXIT_OK;
  }

  const type = parsed.type;
  const emitRecord = (record: unknown): number => {
    if (parsed.json) {
      deps.out(
        JSON.stringify({
          ok: true,
          exitCode: EXPORT_EXIT_OK,
          type,
          record,
        }),
      );
    } else {
      deps.out(canonicalJson(record));
    }
    return EXPORT_EXIT_OK;
  };
  const emitExcluded = (excluded: unknown): number => {
    if (parsed.json) {
      deps.out(
        JSON.stringify({
          ok: true,
          exitCode: EXPORT_EXIT_OK,
          type,
          excluded,
        }),
      );
    } else {
      const tag = (excluded as { tag?: unknown }).tag;
      const reason = (excluded as { reason?: unknown }).reason;
      deps.out(`excluded: ${String(tag)} — ${String(reason)}`);
    }
    return EXPORT_EXIT_OK;
  };
  const emitInvalid = (errors: string[]): number => {
    const message = `record failed validation: ${errors.join('; ')}`;
    if (parsed.json) {
      deps.out(
        JSON.stringify({
          ok: false,
          exitCode: EXPORT_EXIT_FAILED,
          error: { code: 'invalid-record', message },
        }),
      );
    } else {
      deps.out(`export error [invalid-record]: ${message}`);
    }
    return EXPORT_EXIT_FAILED;
  };

  try {
    switch (type) {
      case 'sft': {
        const record = buildSftRecord(exported);
        const checked = validateSftRecord(record);
        if (!checked.valid) return emitInvalid(checked.errors);
        return emitRecord(record);
      }
      case 'tooluse': {
        const record = buildToolUseRecord(exported);
        const checked = validateToolUseRecord(record);
        if (!checked.valid) return emitInvalid(checked.errors);
        return emitRecord(record);
      }
      case 'coding': {
        const record = buildCodingRecord(exported);
        const checked = validateCodingRecord(record);
        if (!checked.valid) return emitInvalid(checked.errors);
        return emitRecord(record);
      }
      case 'dpo':
      case 'preference':
      case 'grpo': {
        const other = loadExport(deps.readFile, parsed.against as string);
        if (!('exported' in other)) return fail(other.code, other.message);
        if (type === 'grpo') {
          const group = buildGrpoGroup([exported, other.exported]);
          const checked = validateGrpoGroup(group);
          if (!checked.valid) return emitInvalid(checked.errors);
          return emitRecord(group);
        }
        if (type === 'dpo') {
          const built = buildDpoRecord(exported, other.exported);
          if (built.record === null) return emitExcluded(built.excluded);
          const checked = validateDpoRecord(built.record);
          if (!checked.valid) return emitInvalid(checked.errors);
          return emitRecord(built.record);
        }
        const built = buildPreferencePair(exported, other.exported);
        if (built.pair === null) return emitExcluded(built.excluded);
        const checked = validatePreferencePair(built.pair);
        if (!checked.valid) return emitInvalid(checked.errors);
        return emitRecord(built.pair);
      }
    }
  } catch (error) {
    if (error instanceof RlProvenanceError) {
      return fail('rl-refused', error.message);
    }
    const message = error instanceof Error ? error.message : String(error);
    if (parsed.json) {
      deps.out(
        JSON.stringify({
          ok: false,
          exitCode: EXPORT_EXIT_FAILED,
          error: { code: 'export-failed', message },
        }),
      );
    } else {
      deps.out(`export error: ${message}`);
    }
    return EXPORT_EXIT_FAILED;
  }
}
