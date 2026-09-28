// `kubic export` command surface (issue #78): trajectory-export
// inspection plus RL dataset export (#51 + #54 libraries).
// Presentation only: parsed options in (commander, apps/kubic/src/
// commands/analysis.ts), exit code out. Trajectory files arrive
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

import {
  EXIT_FAILED,
  EXIT_OK,
  EXIT_USAGE,
} from '../../core/src/cli/exit-codes.js';
import { type CliLogger, createLineLogger } from '../../core/src/cli/logger.js';
import { formatJson } from '../../core/src/cli/output.js';
import { type CliTheme, createCliTheme } from '../../core/src/cli/theme.js';
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

export const EXPORT_EXIT_OK = EXIT_OK;
export const EXPORT_EXIT_FAILED = EXIT_FAILED;
export const EXPORT_EXIT_USAGE = EXIT_USAGE;

export interface ExportCliDeps {
  readFile: (path: string) => string;
  // stdout: the description / record, or the one `--json` envelope.
  out: (line: string) => void;
  // stderr: diagnostics — usage refusals and, off --json, failures as
  // `error: [code] message` (core/cli/logger).
  err: (line: string) => void;
  // Colours the diagnostic prefixes; absent means plain.
  theme?: CliTheme;
  // Colour of the stderr diagnostics, from stderr's own TTY state (never
  // stdout's); absent means plain.
  errTheme?: CliTheme;
}

// The parsed `kubic export` options (commander's `opts()`); `trajectory`
// is a required option there, still checked here for direct callers.
export interface ExportCommandOptions {
  readonly trajectory?: string;
  readonly type?: string;
  readonly against?: string;
  readonly json?: boolean;
}

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

// Pair/group types consume two trajectory files (--trajectory + --against);
// single-trajectory types refuse a stray --against rather than ignoring it.
const NEEDS_AGAINST: ReadonlySet<ExportDatasetType> = new Set([
  'dpo',
  'grpo',
  'preference',
]);

interface ExportOptions {
  trajectory: string;
  type: ExportDatasetType | undefined;
  against: string | undefined;
  json: boolean;
}

function isDatasetType(value: string): value is ExportDatasetType {
  return (DATASET_TYPES as readonly string[]).includes(value);
}

// Semantic validation (the type vocabulary and the --against pairing): a
// usage message on failure, the normalized options otherwise.
function normalize(options: ExportCommandOptions): ExportOptions | string {
  const trajectory = options.trajectory;
  if (trajectory === undefined) {
    return "required option '--trajectory <file>' not specified";
  }
  let type: ExportDatasetType | undefined;
  if (options.type !== undefined) {
    if (!isDatasetType(options.type)) {
      return `unknown --type (want ${DATASET_TYPES.join('|')})`;
    }
    type = options.type;
  }
  const against = options.against;
  if (type !== undefined && NEEDS_AGAINST.has(type) && against === undefined) {
    return `--type ${type} needs --against <other.json>`;
  }
  if (
    against !== undefined &&
    (type === undefined || !NEEDS_AGAINST.has(type))
  ) {
    return `--against applies only to --type ${[...NEEDS_AGAINST].join('|')}`;
  }
  return { trajectory, type, against, json: options.json === true };
}

const PLAIN = createCliTheme('none');

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
  options: ExportCommandOptions,
  deps: ExportCliDeps,
): Promise<number> {
  const log: CliLogger = createLineLogger(deps.err, {
    theme: options.json === true ? PLAIN : (deps.errTheme ?? PLAIN),
  });
  const parsed = normalize(options);
  if (typeof parsed === 'string') {
    log.error(parsed);
    return EXPORT_EXIT_USAGE;
  }
  const fail = (code: string, message: string): number => {
    if (parsed.json) {
      deps.out(
        formatJson({
          ok: false,
          exitCode: EXPORT_EXIT_USAGE,
          error: { code, message },
        }),
      );
    } else {
      log.error(`[${code}] ${message}`);
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
        formatJson({
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
        formatJson({
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
        formatJson({
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
        formatJson({
          ok: false,
          exitCode: EXPORT_EXIT_FAILED,
          error: { code: 'invalid-record', message },
        }),
      );
    } else {
      log.error(`[invalid-record] ${message}`);
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
        formatJson({
          ok: false,
          exitCode: EXPORT_EXIT_FAILED,
          error: { code: 'export-failed', message },
        }),
      );
    } else {
      log.error(message);
    }
    return EXPORT_EXIT_FAILED;
  }
}
