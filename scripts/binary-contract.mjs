// Shipped-artifact contract for the `kubic` binary (issue #101).
//
// scripts/build-contract.test.mjs asserts the *tree* (manifest, bin
// wrapper, tsconfig) — this script asserts the *built artifact*: after
// `npm run build`, the wrapper prints the exact version line, `doctor`
// fails provider-down with the §78 code 6 and the pinned reason, and a
// provider-less `run -p` exits 6 while still printing the four refs
// (session:/journal:/usage:/trajectory:), so the documented failure path
// is pinned end to end.
//
// Hermetic by construction: probes run with HOME pointing at a temp dir
// and a cwd holding no models.json, so no provider is ever configured
// and no network is touched. Usage: node scripts/binary-contract.mjs
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// The exact `kubic --version` line: 'kubic <version> (license: MIT)' —
// the same shape core's formatVersionLine emits, pinned here so a drift
// in either half fails the build contract, not a human's eyeball.
export const VERSION_SUFFIX = ' (license: MIT)';

// Build output the committed bin wrapper loads (bin/kubic.js).
export const DIST_ENTRY = 'dist/apps/kubic/src/main.js';

// §78 provider-failure pins: doctor's provider-down check line, and the
// headless run's provider message.
export const PROVIDER_DOWN_LINE =
  'FAIL limit:provider-availability (provider-down)';
export const RUN_PROVIDER_MESSAGE =
  'no models available: register a provider first';
export const RUN_PROVIDER_EXIT = 6;
export const DOCTOR_PROVIDER_EXIT = 6;

// The ref triple a headless run prints; every value must resolve to the
// run's own session id.
export const REF_KINDS = ['session', 'journal', 'usage', 'trajectory'];

// Internal control-flow marker, not an error: thrown on a contract violation
// so the finally-block scratch cleanup runs. Each problem is already printed
// by the caller, so the marker is swallowed at the top level.
const CONTRACT_VIOLATION = Symbol('contract-violation');

export function expectedVersionLine(version) {
  return `kubic ${version}${VERSION_SUFFIX}`;
}

function lines(stdout) {
  return stdout.split('\n').filter((line) => line.trim() !== '');
}

// The value of a `<kind>: <value>` line, or null when the line is absent.
function refValue(stdout, kind) {
  const prefix = `${kind}: `;
  for (const line of lines(stdout)) {
    if (line.startsWith(prefix)) return line.slice(prefix.length).trim();
  }
  return null;
}

function probeProblems(label, probe) {
  if (probe.error === undefined || probe.error === null) return [];
  const detail =
    probe.error instanceof Error ? probe.error.message : String(probe.error);
  return [`\`${label}\` could not run: ${detail}`];
}

// Runs the three probes through the injected runner and returns every
// contract violation. An empty `problems` array is the pass condition.
export function binaryContract({ distPresent, expectedLine, run }) {
  const problems = [];
  if (!distPresent) {
    problems.push(
      `missing build output ${DIST_ENTRY} — run \`npm run build\` first (the bin wrapper exits 1 without it)`,
    );
    return { problems };
  }

  const version = run(['--version']);
  const versionFailed = probeProblems('kubic --version', version);
  if (versionFailed.length > 0) {
    problems.push(...versionFailed);
  } else if (version.code !== 0) {
    problems.push(
      `\`kubic --version\` exited ${version.code} (expected 0): ${version.stderr.trim()}`,
    );
  } else {
    const printed = version.stdout.trimEnd();
    if (printed !== expectedLine) {
      problems.push(
        `\`kubic --version\` printed ${JSON.stringify(printed)} — expected exactly ${JSON.stringify(expectedLine)}`,
      );
    }
  }

  const doctor = run(['doctor']);
  const doctorFailed = probeProblems('kubic doctor', doctor);
  if (doctorFailed.length > 0) {
    problems.push(...doctorFailed);
  } else {
    if (doctor.code !== DOCTOR_PROVIDER_EXIT) {
      problems.push(
        `\`kubic doctor\` exited ${doctor.code} (expected ${DOCTOR_PROVIDER_EXIT} — provider-down on a runner with no provider, §78)`,
      );
    }
    const fails = lines(doctor.stdout).filter((line) =>
      line.startsWith('FAIL '),
    );
    // Deliberately pinned to exactly one FAIL: on a clean runner with no
    // provider the provider-down check is the only failure, so any second
    // FAIL means an unrelated check broke (e.g. a missing bundle) and the
    // job should stop on the doctor probe rather than on the provider line
    // alone. Do not relax this to `>= 1`.
    if (fails.length !== 1 || !fails[0].startsWith(PROVIDER_DOWN_LINE)) {
      problems.push(
        `\`kubic doctor\` printed ${fails.length} FAIL line(s) — expected exactly one, starting with ${JSON.stringify(PROVIDER_DOWN_LINE)}; saw ${JSON.stringify(fails)}`,
      );
    }
  }

  const headless = run(['run', '-p', 'hi']);
  const headlessFailed = probeProblems('kubic run -p', headless);
  if (headlessFailed.length > 0) {
    problems.push(...headlessFailed);
    return { problems };
  }
  if (headless.code !== RUN_PROVIDER_EXIT) {
    problems.push(
      `\`kubic run -p\` exited ${headless.code} (expected ${RUN_PROVIDER_EXIT} — no provider configured, §78)`,
    );
  }
  if (!headless.stdout.includes(RUN_PROVIDER_MESSAGE)) {
    problems.push(
      `\`kubic run -p\` did not print the provider failure ${JSON.stringify(RUN_PROVIDER_MESSAGE)}`,
    );
  }
  const session = refValue(headless.stdout, 'session');
  if (session === null) {
    problems.push('`kubic run -p` missing the `session:` ref');
  }
  for (const kind of REF_KINDS) {
    if (kind === 'session') continue;
    const value = refValue(headless.stdout, kind);
    if (value === null) {
      problems.push(`\`kubic run -p\` missing the \`${kind}:\` ref`);
    } else if (session !== null && value !== `${kind}:${session}`) {
      problems.push(
        `\`kubic run -p\` \`${kind}:\` ref ${JSON.stringify(value)} does not point at session ${session}`,
      );
    }
  }
  return { problems };
}

// Real probe runner: `node bin/kubic.js <args>` under a hermetic HOME
// and a cwd without models.json. spawnSync reports `status` (and leaves
// it null when a signal or the timeout killed the child) — normalise to
// the contract's `{code, stdout, stderr, error}` probe shape.
function realRunner(root, { cwd, home, timeoutMs = 60_000 }) {
  // Hermetic by construction, not by luck: the child gets a minimal env with
  // HOME pointing at the scratch dir, so nothing on the machine (provider
  // credentials, a models.json path, a KUBIC_* override) can reach the probes.
  const env = {
    PATH: process.env.PATH ?? '',
    HOME: home,
    TMPDIR: process.env.TMPDIR ?? '',
  };
  return (args) => {
    const result = spawnSync(
      process.execPath,
      [join(root, 'bin', 'kubic.js'), ...args],
      {
        cwd,
        env,
        encoding: 'utf8',
        timeout: timeoutMs,
      },
    );
    return {
      code: result.status,
      stdout: result.stdout ?? '',
      stderr: result.stderr ?? '',
      error:
        result.error ??
        (result.status === null
          ? new Error(`killed by signal ${result.signal}`)
          : null),
    };
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const root = join(dirname(fileURLToPath(import.meta.url)), '..');
  const scratch = mkdtempSync(join(tmpdir(), 'kubic-binary-contract-'));
  try {
    const cwd = join(scratch, 'cwd');
    const home = join(scratch, 'home');
    mkdirSync(cwd);
    mkdirSync(home);
    const manifest = JSON.parse(
      readFileSync(join(root, 'package.json'), 'utf8'),
    );
    const expectedLine = expectedVersionLine(manifest.version);
    const result = binaryContract({
      distPresent: existsSync(join(root, DIST_ENTRY)),
      expectedLine,
      run: realRunner(root, { cwd, home }),
    });
    if (result.problems.length > 0) {
      for (const problem of result.problems) {
        console.error(`binary contract: ${problem}`);
      }
      // Throwing (rather than process.exit) keeps the finally-block cleanup
      // running: a failing run must not leak its scratch dir. The problems
      // are already reported above, so the marker is swallowed below and
      // only the exit code survives.
      process.exitCode = 1;
      throw CONTRACT_VIOLATION;
    }
    console.log(
      `binary contract OK: ${expectedLine} (exit 0); doctor exit ${DOCTOR_PROVIDER_EXIT} ${JSON.stringify(PROVIDER_DOWN_LINE)}; provider-less run exit ${RUN_PROVIDER_EXIT} with session:/journal:/usage:/trajectory: refs`,
    );
  } catch (error) {
    // The violation marker carries no information the user has not already
    // seen (each problem was printed above): swallow it, keep the exit code.
    if (error !== CONTRACT_VIOLATION) throw error;
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}
