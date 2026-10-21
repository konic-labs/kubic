// A suite from a file: a team's own task, the fixture it starts from and the
// gate commands that decide the verdict, so models are compared on the
// team's work before they join `allowed_models`. The file is TOML, parsed by
// the composition root; this module validates what it holds, refusing an
// unknown key or a missing part by name.
//
//   task = "Add a GET /health endpoint answering {\"ok\": true}."
//   fixture = "fixtures/server"     # a directory beside the file, copied in
//   [gates]
//   tests = "npm test"

type SuiteGates = Partial<
  Record<'tests' | 'build' | 'lint' | 'typecheck', string>
>;

export interface FileSuite {
  readonly id: string;
  readonly path: string;
  readonly title: string;
  readonly task: string;
  // The scripted task the testing provider runs instead (it cannot read
  // prose), for a deterministic run in CI.
  readonly fauxTask?: string;
  // A directory, relative to the suite file, copied into the workspace.
  readonly fixture?: string;
  // Files the workspace starts with (relative path → content).
  readonly files: Readonly<Record<string, string>>;
  readonly gates: SuiteGates;
  readonly timeoutMs?: number;
}

class SuiteFileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SuiteFileError';
  }
}

const KEYS = new Set([
  'id',
  'title',
  'task',
  'fauxTask',
  'fixture',
  'files',
  'gates',
  'timeoutMs',
]);
const GATES = ['tests', 'build', 'lint', 'typecheck'] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function text(value: unknown, what: string, path: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new SuiteFileError(
      `suite ${path}: ${what} must be a non-empty string`,
    );
  }
  return value;
}

function gatesOf(value: unknown, path: string): SuiteGates {
  if (!isRecord(value)) {
    throw new SuiteFileError(
      `suite ${path}: [gates] names at least one of ${GATES.join(', ')}`,
    );
  }
  const unknown = Object.keys(value).filter(
    (key) => !(GATES as readonly string[]).includes(key),
  );
  if (unknown.length > 0) {
    throw new SuiteFileError(
      `suite ${path}: [gates] has unknown key(s) ${unknown.join(', ')} (one of ${GATES.join(', ')})`,
    );
  }
  const gates: SuiteGates = {};
  for (const gate of GATES) {
    if (value[gate] !== undefined) {
      gates[gate] = text(value[gate], `gates.${gate}`, path);
    }
  }
  if (Object.keys(gates).length === 0) {
    throw new SuiteFileError(
      `suite ${path}: [gates] names at least one of ${GATES.join(', ')}`,
    );
  }
  return gates;
}

function filesOf(value: unknown, path: string): Record<string, string> {
  if (value === undefined) return {};
  if (!isRecord(value)) {
    throw new SuiteFileError(`suite ${path}: [files] maps paths to contents`);
  }
  const files: Record<string, string> = {};
  for (const [name, content] of Object.entries(value)) {
    if (
      typeof content !== 'string' ||
      name === '' ||
      name.startsWith('/') ||
      name.split('/').includes('..')
    ) {
      throw new SuiteFileError(
        `suite ${path}: files.${JSON.stringify(name)} must be a relative path inside the workspace with string content`,
      );
    }
    files[name] = content;
  }
  return files;
}

/** The suite a parsed suite file (`record`, read from `path`) describes. */
export function suiteFromRecord(
  record: Record<string, unknown>,
  path: string,
  fallbackId: string,
): FileSuite {
  const unknown = Object.keys(record).filter((key) => !KEYS.has(key));
  if (unknown.length > 0) {
    throw new SuiteFileError(
      `suite ${path}: unknown key(s) ${unknown.join(', ')}`,
    );
  }
  const timeoutMs = record.timeoutMs;
  if (
    timeoutMs !== undefined &&
    (typeof timeoutMs !== 'number' ||
      !Number.isInteger(timeoutMs) ||
      timeoutMs <= 0)
  ) {
    throw new SuiteFileError(
      `suite ${path}: timeoutMs must be a positive integer of milliseconds`,
    );
  }
  const id = record.id === undefined ? fallbackId : text(record.id, 'id', path);
  return {
    id,
    path,
    title: record.title === undefined ? id : text(record.title, 'title', path),
    task: text(record.task, 'task', path),
    ...(record.fauxTask === undefined
      ? {}
      : { fauxTask: text(record.fauxTask, 'fauxTask', path) }),
    ...(record.fixture === undefined
      ? {}
      : { fixture: text(record.fixture, 'fixture', path) }),
    files: filesOf(record.files, path),
    gates: gatesOf(record.gates, path),
    ...(typeof timeoutMs === 'number' ? { timeoutMs } : {}),
  };
}
