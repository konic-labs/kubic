// Shipped-artifact contract for the `kubic` binary (issues #101, #128).
//
// scripts/build-contract.test.mjs asserts the *tree* (manifest, bin
// wrapper, tsconfig) — this script asserts the *built artifact*: after
// `npm run build`, the wrapper prints the exact version line, `doctor`
// fails provider-down with the §78 code 6 and the pinned reason, and a
// provider-less `run -p` exits 6 while still printing the four refs
// (session:/journal:/usage:/trajectory:), so the documented failure path
// is pinned end to end. Issue #128 adds the front-door contract: root
// `--help`/`-h` print the listing and exit 0 while the bare invocation
// off a TTY keeps exit 1 (same line; on an interactive terminal it opens
// the TUI, §78/§80 — the probes run over pipes, so never a TTY), a stubbed old runtime hits the launcher's
// named Node guard before any dist import, and an injected command
// failure (reached only through its contract-only env gate) surfaces as
// one `error: <message>` line (full stack only under KUBIC_DEBUG=1).
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
  writeFileSync,
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

// The root dispatcher's usage line (issue #128): one string serves
// `kubic --help` / `kubic -h` (exit 0 — help is success, §78) and the
// bare invocation off a TTY (exit 1 — POSIX usage-on-no-args; a bare
// `kubic` on an interactive terminal opens the TUI instead, §78/§80). Pinned literally so
// a command-list drift fails here instead of shipping stale help.
export const ROOT_USAGE_LINE =
  'usage: kubic <sessions | git | models | diff | undo | log | status | run | orchestrate | clean | tui | doctor | config | workers | eval | benchmark | replay | export | cost | perf | policy | audit>';

// The launcher's named Node-requirement line (issue #128), printed to
// stderr when a runtime below 22.19 runs bin/kubic.js. `runningVersion`
// is process.versions.node as the launcher saw it.
export function nodeGuardLine(runningVersion) {
  return `kubic: node >= 22.19 required (running ${runningVersion}) — see the README install section`;
}

// The failure seam `kubic __crash-probe` throws inside main()
// (apps/kubic/src/main.ts, issue #128): a plain Error so the top-level
// catch-all's operator-facing shape is asserted against the real binary.
export const CRASH_PROBE_MESSAGE = 'injected probe failure';

// Env gate for the failure seam (issue #128): main.ts only throws when this
// is '1', so the seam is internal-only — a bare `kubic __crash-probe` is an
// unknown command. Named like NODE_STUB_ENV: contract-only, never
// user-facing.
export const CRASH_PROBE_ENV = '__KUBIC_CONTRACT_CRASH_PROBE';

// Env var the `--import` preload reads to stub process.versions.node: an
// old runtime cannot run in CI, so the launcher's guard is exercised by
// rewriting the version the wrapper sees, before its first statement.
export const NODE_STUB_ENV = '__KUBIC_CONTRACT_NODE_STUB';

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

// Runs the probes through the injected runner and returns every contract
// violation. An empty `problems` array is the pass condition. The runner
// takes `(args, opts?)`; `opts` carries the hermetic overrides the real
// spawn supports (a stubbed `process.versions.node`, extra child env) and
// is ignored by direct probes.
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

  // Issue #128: help at the root is success, and the bare invocation keeps
  // the POSIX usage-on-no-args posture — one line, two exit codes. The
  // probes spawn over pipes (non-TTY), which is exactly the scripted case
  // that must keep exit 1; the TTY → TUI branch is pinned in dispatch.test.
  for (const [label, probe] of [
    ['kubic --help', run(['--help'])],
    ['kubic -h', run(['-h'])],
  ]) {
    const failed = probeProblems(label, probe);
    if (failed.length > 0) {
      problems.push(...failed);
      continue;
    }
    if (probe.code !== 0) {
      problems.push(
        `\`${label}\` exited ${probe.code} (expected 0 — help is success, §78)`,
      );
      continue;
    }
    const printed = probe.stdout.trimEnd();
    if (printed !== ROOT_USAGE_LINE) {
      problems.push(
        `\`${label}\` printed ${JSON.stringify(printed)} — expected exactly ${JSON.stringify(ROOT_USAGE_LINE)}`,
      );
    }
  }

  const bare = run([]);
  const bareFailed = probeProblems('kubic (no command)', bare);
  if (bareFailed.length > 0) {
    problems.push(...bareFailed);
  } else {
    if (bare.code !== 1) {
      problems.push(
        `\`kubic\` with no command exited ${bare.code} (expected 1 — off a TTY, usage-on-no-args is the documented POSIX posture)`,
      );
    }
    const printed = bare.stdout.trimEnd();
    if (printed !== ROOT_USAGE_LINE) {
      problems.push(
        `\`kubic\` with no command printed ${JSON.stringify(printed)} — expected the identical \`kubic --help\` line ${JSON.stringify(ROOT_USAGE_LINE)}`,
      );
    }
  }

  // Issue #128: the launcher's Node guard, driven through a stubbed
  // process.versions.node (the `--import` preload) so the real bin/kubic.js
  // ordering is exercised without an old runtime. Below the floor: the
  // refusal is the ONLY output, on stderr, exit 1 — and it happens before
  // any dist import (a missing build must not mask it).
  for (const stub of ['21.9.0', '22.18.0']) {
    const probe = run(['--version'], { nodeStub: stub });
    const failed = probeProblems(`kubic --version (node ${stub})`, probe);
    if (failed.length > 0) {
      problems.push(...failed);
      continue;
    }
    if (probe.code !== 1) {
      problems.push(
        `\`kubic --version\` under a stubbed node ${stub} exited ${probe.code} (expected 1 — named Node guard, not a raw stack)`,
      );
      continue;
    }
    const printed = probe.stderr.trimEnd();
    const expected = nodeGuardLine(stub);
    if (printed !== expected) {
      problems.push(
        `\`kubic --version\` under a stubbed node ${stub} printed ${JSON.stringify(printed)} to stderr — expected exactly ${JSON.stringify(expected)}`,
      );
    }
    if (probe.stdout !== '') {
      problems.push(
        `\`kubic --version\` under a stubbed node ${stub} wrote ${JSON.stringify(probe.stdout)} to stdout — the guard refusal is stderr-only`,
      );
    }
  }

  // At the exact floor the guard must not fire: the wrapper proceeds to the
  // version path as usual (still zero stderr).
  const boundary = run(['--version'], { nodeStub: '22.19.0' });
  const boundaryFailed = probeProblems(
    'kubic --version (node 22.19.0)',
    boundary,
  );
  if (boundaryFailed.length > 0) {
    problems.push(...boundaryFailed);
  } else if (boundary.code !== 0) {
    problems.push(
      `\`kubic --version\` at the exact floor (stubbed node 22.19.0) exited ${boundary.code} (expected 0 — the guard must not fire at >= 22.19): ${boundary.stderr.trim()}`,
    );
  } else if (boundary.stdout.trimEnd() !== expectedLine) {
    problems.push(
      `\`kubic --version\` at the exact floor (stubbed node 22.19.0) printed ${JSON.stringify(boundary.stdout.trimEnd())} — expected the version line ${JSON.stringify(expectedLine)}, not the guard refusal`,
    );
  } else if (boundary.stderr !== '') {
    problems.push(
      `\`kubic --version\` at the exact floor (stubbed node 22.19.0) wrote ${JSON.stringify(boundary.stderr)} to stderr — the guard must stay silent when it passes`,
    );
  }

  // Issue #128: an unexpected command failure is one `error: <message>`
  // line on stderr, exit 1, no stack. The full stack is opt-in via
  // KUBIC_DEBUG=1 — and even then the named line stays. The seam is gated
  // on CRASH_PROBE_ENV; the ungated probe below proves a bare
  // `kubic __crash-probe` cannot reach it.
  const crash = run(['__crash-probe'], { env: { [CRASH_PROBE_ENV]: '1' } });
  const crashFailed = probeProblems('kubic __crash-probe', crash);
  if (crashFailed.length > 0) {
    problems.push(...crashFailed);
  } else {
    if (crash.code !== 1) {
      problems.push(
        `\`kubic __crash-probe\` exited ${crash.code} (expected 1 — unexpected failures exit 1)`,
      );
    }
    const printed = crash.stderr.trimEnd();
    const expected = `error: ${CRASH_PROBE_MESSAGE}`;
    if (printed !== expected) {
      problems.push(
        `\`kubic __crash-probe\` stderr was ${JSON.stringify(printed)} — expected exactly ${JSON.stringify(expected)} (one named line, no stack)`,
      );
    }
    if (crash.stdout.trimEnd() !== '') {
      problems.push(
        `\`kubic __crash-probe\` wrote ${JSON.stringify(crash.stdout)} to stdout — failures are stderr-only`,
      );
    }
  }

  const debugCrash = run(['__crash-probe'], {
    env: { [CRASH_PROBE_ENV]: '1', KUBIC_DEBUG: '1' },
  });
  const debugCrashFailed = probeProblems(
    'kubic __crash-probe (KUBIC_DEBUG=1)',
    debugCrash,
  );
  if (debugCrashFailed.length > 0) {
    problems.push(...debugCrashFailed);
  } else {
    if (debugCrash.code !== 1) {
      problems.push(
        `\`kubic __crash-probe\` with KUBIC_DEBUG=1 exited ${debugCrash.code} (expected 1 — the opt-in changes the output, never the exit)`,
      );
    }
    const stderr = debugCrash.stderr.trimEnd();
    if (!stderr.includes(`error: ${CRASH_PROBE_MESSAGE}`)) {
      problems.push(
        `\`kubic __crash-probe\` with KUBIC_DEBUG=1 lost the \`error: <message>\` line (stderr was ${JSON.stringify(stderr)})`,
      );
    }
    if (!/\n\s+at /.test(stderr)) {
      problems.push(
        `\`kubic __crash-probe\` with KUBIC_DEBUG=1 must include the full stack — no \` at \` frame seen in ${JSON.stringify(stderr)}`,
      );
    }
  }

  // The seam is internal-only (issue #128): without the contract's own env
  // gate, `kubic __crash-probe` is just an unknown command — the root usage
  // line, exit 1, nothing on stderr — never an injected crash.
  const ungated = run(['__crash-probe']);
  const ungatedFailed = probeProblems('kubic __crash-probe (ungated)', ungated);
  if (ungatedFailed.length > 0) {
    problems.push(...ungatedFailed);
  } else {
    if (ungated.code !== 1) {
      problems.push(
        `\`kubic __crash-probe\` without the env gate exited ${ungated.code} (expected 1 — unknown command)`,
      );
    }
    if (ungated.stdout.trimEnd() !== ROOT_USAGE_LINE) {
      problems.push(
        `\`kubic __crash-probe\` without the env gate printed ${JSON.stringify(ungated.stdout.trimEnd())} — expected the root usage line (the seam must stay internal-only)`,
      );
    }
    if (ungated.stderr !== '') {
      problems.push(
        `\`kubic __crash-probe\` without the env gate wrote ${JSON.stringify(ungated.stderr)} to stderr — expected silence`,
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
//
// `opts.nodeStub` (issue #128) prepends `--import <stubPath>` and hands the
// version to the preload through NODE_STUB_ENV, so the launcher's guard
// sees the stubbed runtime; `opts.env` adds probe-scoped child env
// (e.g. KUBIC_DEBUG=1). Neither leaks into probes that did not ask.
function realRunner(root, { cwd, home, timeoutMs = 60_000, stubPath }) {
  // Hermetic by construction, not by luck: the child gets a minimal env with
  // HOME pointing at the scratch dir, so nothing on the machine (provider
  // credentials, a models.json path, a KUBIC_* override) can reach the probes.
  return (args, opts = {}) => {
    const env = {
      PATH: process.env.PATH ?? '',
      HOME: home,
      TMPDIR: process.env.TMPDIR ?? '',
      ...opts.env,
    };
    const nodeArgs = [];
    if (opts.nodeStub !== undefined) {
      env[NODE_STUB_ENV] = opts.nodeStub;
      nodeArgs.push('--import', stubPath);
    }
    const result = spawnSync(
      process.execPath,
      [...nodeArgs, join(root, 'bin', 'kubic.js'), ...args],
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

// The `--import` preload the stubbed guard probes run with (issue #128):
// rewrites process.versions.node before the entry module evaluates, so an
// old runtime is simulated on the current one. A value the contract never
// sets is ignored, keeping direct probes byte-identical.
function nodeStubPreload() {
  return [
    '// Generated by scripts/binary-contract.mjs (issue #128) — do not ship.',
    `const stub = process.env[${JSON.stringify(NODE_STUB_ENV)}];`,
    'if (stub !== undefined) {',
    "  Object.defineProperty(process.versions, 'node', { value: stub });",
    '}',
    '',
  ].join('\n');
}

if (import.meta.main) {
  const root = join(dirname(fileURLToPath(import.meta.url)), '..');
  const scratch = mkdtempSync(join(tmpdir(), 'kubic-binary-contract-'));
  try {
    const cwd = join(scratch, 'cwd');
    const home = join(scratch, 'home');
    mkdirSync(cwd);
    mkdirSync(home);
    const stubPath = join(scratch, 'node-version-stub.mjs');
    writeFileSync(stubPath, nodeStubPreload());
    const manifest = JSON.parse(
      readFileSync(join(root, 'package.json'), 'utf8'),
    );
    const expectedLine = expectedVersionLine(manifest.version);
    const result = binaryContract({
      distPresent: existsSync(join(root, DIST_ENTRY)),
      expectedLine,
      run: realRunner(root, { cwd, home, stubPath }),
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
      `binary contract OK: ${expectedLine} (exit 0); --help/-h exit 0 with the root usage line; bare kubic exit 1 (same line); stubbed old node hits the named guard (exit 1, stderr-only) and the 22.19 floor passes; injected failure prints one \`error:\` line (stack only under KUBIC_DEBUG=1); doctor exit ${DOCTOR_PROVIDER_EXIT} ${JSON.stringify(PROVIDER_DOWN_LINE)}; provider-less run exit ${RUN_PROVIDER_EXIT} with session:/journal:/usage:/trajectory: refs`,
    );
  } catch (error) {
    // The violation marker carries no information the user has not already
    // seen (each problem was printed above): swallow it, keep the exit code.
    if (error !== CONTRACT_VIOLATION) throw error;
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}
