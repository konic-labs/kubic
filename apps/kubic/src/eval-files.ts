// `kubic benchmark --suite-file`: the suites read from TOML files (or every
// `*.toml` of a directory), their fixture directories read in, and each
// suite run in a fresh temporary workspace through the real lane, scored
// from the trajectory it writes like a built-in suite. A suite file inside a
// project's `.kubic/` is project configuration: an untrusted project's is
// refused, the way its config, models.json and skills are.

import {
  basename,
  dirname,
  extname,
  join,
  relative,
  resolve,
  sep,
} from 'node:path';
import type { MutableModels } from '@kubic/agent/pi-boundary';
import type { EvalOptions } from '@kubic/eval/cli';
import { EvalRunnerError, type SuiteRunOutcome } from '@kubic/eval/runner';
import { type FileSuite, suiteFromRecord } from '@kubic/eval/suite-files';
import { createNodeFileBridge } from '@kubic/exec/file-bridge';
import { parseTomlDocument } from '@kubic/host/config';
import type { CliConfigResult } from './config/load.js';
import { projectTrustFor } from './config/load.js';
import { runFixture } from './eval-prod.js';

const MAX_FIXTURE_FILES = 2_000;
const MAX_FIXTURE_BYTES = 20 * 1024 * 1024;
const SKIPPED_DIRS = new Set(['.git', 'node_modules']);

type Bridge = ReturnType<typeof createNodeFileBridge>;

// The project a suite file belongs to: the directory holding the `.kubic/`
// it sits in, unless that is the home directory's (the global tree).
function projectOf(path: string, home: string): string | undefined {
  const parts = path.split(sep);
  const at = parts.lastIndexOf('.kubic');
  if (at <= 0) return undefined;
  const root = parts.slice(0, at).join(sep) || sep;
  return resolve(root) === resolve(home) ? undefined : root;
}

function suitePaths(bridge: Bridge, path: string): string[] {
  const info = bridge.fileInfo(path);
  if (!info.isDirectory) return [path];
  return bridge
    .listDir(path)
    .filter((entry) => !entry.isDirectory && extname(entry.name) === '.toml')
    .map((entry) => join(path, entry.name))
    .sort();
}

// The fixture directory's files, relative path → text; a binary file or an
// oversized fixture is refused by name.
function fixtureFiles(bridge: Bridge, dir: string): Record<string, string> {
  const files: Record<string, string> = {};
  let bytes = 0;
  const walk = (current: string): void => {
    for (const entry of bridge.listDir(current)) {
      if (entry.isSymbolicLink) continue;
      if (entry.isDirectory) {
        if (!SKIPPED_DIRS.has(entry.name)) walk(join(current, entry.name));
        continue;
      }
      const absolute = join(current, entry.name);
      const text = bridge.readTextFile(absolute);
      if (text.includes('\u0000')) {
        throw new EvalRunnerError(
          'suite-file-invalid',
          `fixture file ${absolute} is binary: a fixture holds text files`,
        );
      }
      bytes += Buffer.byteLength(text, 'utf8');
      if (
        Object.keys(files).length >= MAX_FIXTURE_FILES ||
        bytes > MAX_FIXTURE_BYTES
      ) {
        throw new EvalRunnerError(
          'suite-file-invalid',
          `fixture ${dir} is over ${MAX_FIXTURE_FILES} files or ${MAX_FIXTURE_BYTES / 1024 / 1024} MiB`,
        );
      }
      files[relative(dir, absolute).split(sep).join('/')] = text;
    }
  };
  walk(dir);
  return files;
}

/** The suites `paths` name, trust checked; refuses by name. */
export function loadSuiteFiles(
  paths: readonly string[],
  cliConfig: CliConfigResult,
  cwd: string = process.cwd(),
): FileSuite[] {
  const bridge = createNodeFileBridge('/');
  const trusted = projectTrustFor(cliConfig);
  const suites: FileSuite[] = [];
  for (const given of paths) {
    const absolute = resolve(cwd, given);
    if (!bridge.exists(absolute)) {
      throw new EvalRunnerError(
        'suite-file-invalid',
        `suite file ${given} does not exist`,
      );
    }
    for (const path of suitePaths(bridge, absolute)) {
      const project = projectOf(path, cliConfig.trust.home);
      if (project !== undefined && !trusted(project)) {
        throw new EvalRunnerError(
          'suite-file-untrusted',
          `suite file ${path} belongs to the untrusted project ${project}: its gates are commands the project chose — run 'kubic trust' to accept it, or set KUBIC_TRUST_PROJECT=1 for this invocation`,
        );
      }
      let suite: FileSuite;
      try {
        suite = suiteFromRecord(
          parseTomlDocument(bridge.readTextFile(path)),
          path,
          basename(path, '.toml'),
        );
      } catch (error) {
        throw new EvalRunnerError(
          'suite-file-invalid',
          error instanceof Error ? error.message : String(error),
        );
      }
      const fixture =
        suite.fixture === undefined
          ? {}
          : fixtureFiles(bridge, resolve(dirname(path), suite.fixture));
      suites.push({ ...suite, files: { ...fixture, ...suite.files } });
    }
  }
  const ids = suites.map((suite) => suite.id);
  const repeated = ids.find((id, index) => ids.indexOf(id) !== index);
  if (repeated !== undefined) {
    throw new EvalRunnerError(
      'suite-file-invalid',
      `two suite files are named ${JSON.stringify(repeated)}: give one an id`,
    );
  }
  return suites;
}

/** Runs one file suite on `model` in a fresh temporary workspace. */
export function createFileSuiteRunner(
  options: EvalOptions,
  cliConfig: CliConfigResult,
  catalog?: MutableModels,
): (suite: FileSuite, model: string) => Promise<SuiteRunOutcome> {
  return async (suite, model) => {
    const bridge = createNodeFileBridge('/');
    const dir = bridge.createTempDir('kubic-eval-suite-');
    try {
      return await runFixture(
        {
          id: suite.id,
          fixture: {
            task: suite.task,
            fauxPrompt: suite.fauxTask ?? suite.task,
            files: { ...suite.files },
            verify: suite.gates,
            ...(suite.timeoutMs === undefined
              ? {}
              : { timeoutMs: suite.timeoutMs }),
          },
        },
        dir,
        { ...options, model },
        cliConfig,
        undefined,
        catalog,
      );
    } finally {
      bridge.remove(dir, true, true);
    }
  };
}
