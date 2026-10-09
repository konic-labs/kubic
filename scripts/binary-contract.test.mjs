// Unit tests for the shipped-artifact contract.
// Static repo state, no build needed: the probe runner is injected, so the
// assertion logic is exercised without dist/ — the real binary run lives in
// scripts/binary-contract.mjs (CI: the `binary-contract` job).
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { nodeVersionSupported } from '../bin/node-guard.mjs';
import {
  BUILTIN_ROLE_NAMES,
  binaryContract,
  CONFIG_REFUSAL_KEY,
  CRASH_PROBE_ENV,
  CRASH_PROBE_MESSAGE,
  expectedVersionLine,
  MODELS_RECEIPT_PREFIX,
  nodeGuardLine,
  ROOT_HELP_TEXT,
  UNKNOWN_COMMAND_HELP_HINT,
  unknownCommandError,
  unknownPromptHint,
} from './binary-contract.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const SESSION = '01a0d7d9-d6fb-71c2-bcfa-15f762197e6b';
const VERSION_LINE = 'kubic 0.0.0 (license: MIT)';
const RUN_MESSAGE = 'no models available: register a provider first';
const PROVIDER_FAIL =
  'FAIL limit:provider-availability (provider-down): no providers configured — configure a provider; `kubic run` exits 6 on provider failure';

function ok(stdout) {
  return { code: 0, stdout, stderr: '', error: null };
}

function versionOut(text = VERSION_LINE) {
  return ok(`${text}\n`);
}

// `kubic --help` / `kubic -h`: the root usage line, exit 0.
function helpOut(line = ROOT_HELP_TEXT) {
  return ok(`${line}\n`);
}

// `kubic <command> --help`: the command's own usage, exit 0, and nothing
// on stderr (no lane boot).
const COMMAND_HELP = new Set(['run', 'tui']);

function commandHelpOut(command) {
  return ok(
    `Usage: kubic ${command} [options]\n\nOptions:\n  -h, --help  print usage\n`,
  );
}

// Bare `kubic`: the identical line, exit 1 — POSIX usage-on-no-args.
function bareOut(line = ROOT_HELP_TEXT) {
  return { code: 1, stdout: `${line}\n`, stderr: '', error: null };
}

// An unknown command (hint/ stderr): exit 2, nothing on stdout, the error line,
// the prompt hint and the help hint on stderr.
function unknownOut() {
  return {
    code: 2,
    stdout: '',
    stderr: `${unknownCommandError('nosuch-command')}\n${unknownPromptHint('nosuch-command')}\n${UNKNOWN_COMMAND_HELP_HINT}\n`,
    error: null,
  };
}

// The internal crash probe without its env gate: an unknown
// command with NO prompt hint — the seam is not a user surface.
function usageOnlyOut() {
  return {
    code: 2,
    stdout: '',
    stderr: `${unknownCommandError('__crash-probe')}\n${UNKNOWN_COMMAND_HELP_HINT}\n`,
    error: null,
  };
}

// The headline bare prompt: a multi-word argv token runs
// like `kubic run -p`, so the faux provider answers with a completed run.
function barePromptOut() {
  return ok(
    `${JSON.stringify({ ok: true, exitCode: 0, status: 'completed', result: { summary: 'echo: hello there' } })}\n`,
  );
}

// The launcher's guard refusal for a stubbed runtime: one named line on
// stderr, exit 1, nothing on stdout.
function guardRefusal(stub) {
  return {
    code: 1,
    stdout: '',
    stderr: `${nodeGuardLine(stub)}\n`,
    error: null,
  };
}

// `kubic __crash-probe`: the top-level catch-all's operator-facing shape —
// one `error: <message>` line, exit 1, no stack.
function crashOut() {
  return {
    code: 1,
    stdout: '',
    stderr: `error: ${CRASH_PROBE_MESSAGE}\n`,
    error: null,
  };
}

// The same failure with KUBIC_DEBUG=1: full stack first, named line last.
function debugCrashOut() {
  const stack = `Error: ${CRASH_PROBE_MESSAGE}\n    at main (file:///probe/main.js:1:1)\n    at async file:///probe/main.js:2:1`;
  return {
    code: 1,
    stdout: '',
    stderr: `${stack}\nerror: ${CRASH_PROBE_MESSAGE}\n`,
    error: null,
  };
}

// The embedded role presets are part of the doctor baseline:
// a runner with no `.kubic/roles/` reports all five as `builtin role`.
function rolePresetLines() {
  return BUILTIN_ROLE_NAMES.map(
    (name) => `PASS role:${name} (ok): builtin role — 5 tool(s): bash, read`,
  );
}

function doctorOut(code = 6, fails = [PROVIDER_FAIL]) {
  const lines = [
    'PASS dep:node (ok): node 24.13.0 (need >=22.19)',
    ...rolePresetLines(),
    ...fails,
    `doctor: 6 pass, 6 warn, ${fails.length} fail, 0 skip`,
  ];
  return { code, stdout: `${lines.join('\n')}\n`, stderr: '', error: null };
}

function runOut(code = 6) {
  const lines = [
    `error: ${RUN_MESSAGE}`,
    `result: ${RUN_MESSAGE}`,
    `session: ${SESSION}`,
    `journal: journal:${SESSION}`,
    `usage: usage:${SESSION}`,
    `trajectory: /home/.kubic/sessions/${SESSION}/trajectory.json`,
  ];
  return { code, stdout: `${lines.join('\n')}\n`, stderr: '', error: null };
}

// An override may be a probe object or a `(stub) => probe` function when
// the faked output has to name the stubbed version.
function applyOverride(override, stub) {
  return typeof override === 'function' ? override(stub) : override;
}

// The models.json receipt is a diagnostic, so `--json` stdout is
// one document. The fake mirrors the real split.
function modelsJsonOut() {
  return {
    code: 0,
    stdout: `${JSON.stringify([{ id: 'local/llama3' }])}\n`,
    stderr: `${MODELS_RECEIPT_PREFIX} /x/models.json (project, trusted): local\n`,
    error: null,
  };
}

function doctorJsonOut() {
  return {
    code: 0,
    stdout: `${JSON.stringify({ ok: true, exitCode: 0, checks: [] })}\n`,
    stderr: `${MODELS_RECEIPT_PREFIX} /x/models.json (project, trusted): local\n`,
    error: null,
  };
}

function modelsTextOut() {
  return {
    code: 0,
    stdout: 'local/llama3\n',
    stderr: `${MODELS_RECEIPT_PREFIX} /x/models.json (project, trusted): local\n`,
    error: null,
  };
}

// The refusal a project config with an unknown key produces.
const REFUSAL_MESSAGE = `layer 'project': unknown key '${CONFIG_REFUSAL_KEY}'`;

function refusedRunTextOut() {
  return {
    code: 1,
    stdout: '',
    stderr: `error: ${REFUSAL_MESSAGE}\n`,
    error: null,
  };
}

function refusedRunJsonOut() {
  return {
    code: 1,
    stdout: `${JSON.stringify({
      ok: false,
      exitCode: 1,
      sessionId: 'unassigned',
      status: 'failed',
      result: { summary: REFUSAL_MESSAGE },
      journal: { ref: 'journal:unassigned' },
      usage: { ref: 'usage:unassigned' },
      trajectory: { ref: 'trajectory:unassigned' },
      error: { kind: 'failed', message: REFUSAL_MESSAGE },
    })}\n`,
    stderr: `error: ${REFUSAL_MESSAGE}\n`,
    error: null,
  };
}

// Replays the probes with the given per-command overrides. The stubbed-node
// probes key on `opts.nodeStub`: the contract only stubs
// below-the-floor values and the exact floor, so the fake mirrors a working
// guard for those while each override can force the drift under test.
function fakeRun(overrides = {}) {
  return (args, opts = {}) => {
    const stub = opts.nodeStub;
    if (stub === '21.9.0' || stub === '22.18.0') {
      return applyOverride(overrides.guardRefused, stub) ?? guardRefusal(stub);
    }
    if (stub === '22.19.0') {
      return overrides.guardBoundary ?? versionOut();
    }
    if (stub !== undefined) {
      throw new Error(`unexpected node stub: ${stub}`);
    }
    if (args.length === 0) return overrides.bare ?? bareOut();
    if (args[0] === 'nosuch-command') {
      return overrides.unknown ?? unknownOut();
    }
    if (opts.env?.KUBIC_PROVIDER === 'faux' && args[0] === 'hello there') {
      return overrides.barePrompt ?? barePromptOut();
    }
    if (args.length >= 2 && args[1] === '--help' && COMMAND_HELP.has(args[0])) {
      return overrides[`${args[0]}Help`] ?? commandHelpOut(args[0]);
    }
    if (args[0] === 'models' && args.includes('--json')) {
      if (opts.cwd === undefined) {
        throw new Error('the models --json probe must run in the models cwd');
      }
      return overrides.modelsJson ?? modelsJsonOut();
    }
    if (args[0] === 'models') {
      if (opts.cwd === undefined) {
        throw new Error('the models probe must run in the models cwd');
      }
      return overrides.modelsText ?? modelsTextOut();
    }
    if (args[0] === 'doctor' && args.includes('--json')) {
      if (opts.cwd === undefined) {
        throw new Error('the doctor --json probe must run in the models cwd');
      }
      return overrides.doctorJson ?? doctorJsonOut();
    }
    // The refused-config probes are the only ones carrying the trust env
    // opt-in; the provider-less `run -p` probe stays on its own case below.
    if (opts.env?.KUBIC_TRUST_PROJECT === '1') {
      if (args.includes('--json')) {
        return overrides.refusedRunJson ?? refusedRunJsonOut();
      }
      return overrides.refusedRunText ?? refusedRunTextOut();
    }
    if (args[0] === '__crash-probe') {
      // Without the contract's env gate the seam is unreachable: the command
      // falls through to the unknown-command path — the same shape as any other
      // unknown command.
      if (opts.env?.[CRASH_PROBE_ENV] !== '1') {
        return overrides.ungatedCrash ?? usageOnlyOut();
      }
      return opts.env?.KUBIC_DEBUG === '1'
        ? (overrides.debugCrash ?? debugCrashOut())
        : (overrides.crash ?? crashOut());
    }
    if (args[0] === '--version') return overrides.version ?? versionOut();
    if (args[0] === '--help') return overrides.help ?? helpOut();
    if (args[0] === '-h')
      return overrides.shortHelp ?? overrides.help ?? helpOut();
    if (args.length >= 2 && args[1] === '--help' && COMMAND_HELP.has(args[0])) {
      return overrides[`${args[0]}Help`] ?? commandHelpOut(args[0]);
    }
    if (args.length >= 2 && args[1] === '--help' && COMMAND_HELP.has(args[0])) {
      return overrides[`${args[0]}Help`] ?? commandHelpOut(args[0]);
    }
    if (args[0] === 'doctor') return overrides.doctor ?? doctorOut();
    if (args[0] === 'run') return overrides.run ?? runOut();
    throw new Error(`unexpected probe: ${args.join(' ')}`);
  };
}

function contractWith(overrides = {}, options = {}) {
  return binaryContract({
    distPresent: options.distPresent ?? true,
    expectedLine: VERSION_LINE,
    modelsCwd: options.modelsCwd ?? '/models',
    refusedCwd: options.refusedCwd ?? '/refused',
    runSymlinked: options.runSymlinked,
    run: fakeRun(overrides),
  });
}

describe('binary contract', () => {
  it('passes on the clean provider-less baseline', () => {
    assert.deepEqual(contractWith().problems, []);
  });

  it('fails when the build output is missing', () => {
    const result = contractWith({}, { distPresent: false });
    assert.equal(result.problems.length, 1);
    assert.match(result.problems[0], /dist\/kubic\.js/);
    assert.match(result.problems[0], /npm run build/);
  });

  it('composes the exact version line from the live manifest', () => {
    const manifest = JSON.parse(
      readFileSync(join(ROOT, 'package.json'), 'utf8'),
    );
    assert.equal(expectedVersionLine(manifest.version), VERSION_LINE);
  });
});

describe('binary contract --version probe', () => {
  it('fails when the printed line drifts', () => {
    const result = contractWith({
      version: versionOut('kubic 0.0.1 (license: MIT)'),
    });
    assert.equal(result.problems.length, 1);
    assert.match(result.problems[0], /kubic 0\.0\.1 \(license: MIT\)/);
    assert.match(result.problems[0], /kubic 0\.0\.0 \(license: MIT\)/);
  });

  it('fails when the line is not exact (extra output)', () => {
    const result = contractWith({
      version: versionOut(`${VERSION_LINE}\nwarning: noise`),
    });
    assert.equal(result.problems.length, 1);
    assert.match(result.problems[0], /expected exactly/);
  });

  it('fails when --version exits non-zero', () => {
    const result = contractWith({
      version: {
        code: 1,
        stdout: '',
        stderr: 'kubic: build output missing — run `npm run build` first.\n',
        error: null,
      },
    });
    assert.equal(result.problems.length, 1);
    assert.match(result.problems[0], /exited 1 \(expected 0\)/);
  });
});

describe('binary contract root help probes', () => {
  it('fails when both help flags exit 1 (the pre defect)', () => {
    const exit1 = {
      code: 1,
      stdout: `${ROOT_HELP_TEXT}\n`,
      stderr: '',
      error: null,
    };
    const result = contractWith({ help: exit1 });
    assert.equal(result.problems.length, 2);
    for (const problem of result.problems) {
      assert.match(problem, /exited 1 \(expected 0 — help is success/);
    }
  });

  it('fails when -h alone drifts (exit 2 from an old unknown-flag path)', () => {
    const result = contractWith({
      shortHelp: { code: 2, stdout: '', stderr: '', error: null },
    });
    assert.equal(result.problems.length, 1);
    assert.match(result.problems[0], /kubic -h` exited 2 \(expected 0/);
  });

  it('fails when --help prints a drifted usage line', () => {
    const result = contractWith({
      help: helpOut('usage: kubic <run>'),
      shortHelp: helpOut(),
    });
    assert.equal(result.problems.length, 1);
    assert.match(result.problems[0], /kubic --help` printed/);
    assert.match(result.problems[0], /expected exactly/);
  });

  it('fails when the bare invocation exits 0', () => {
    const result = contractWith({ bare: { ...bareOut(), code: 0 } });
    assert.equal(result.problems.length, 1);
    assert.match(
      result.problems[0],
      /kubic` with no command exited 0 \(expected 1/,
    );
  });

  it('fails when the bare invocation prints a different line than --help', () => {
    const result = contractWith({ bare: bareOut('usage: kubic <run>') });
    assert.equal(result.problems.length, 1);
    assert.match(
      result.problems[0],
      /expected the identical `kubic --help` text/,
    );
  });

  it('fails when a probe could not run at all', () => {
    const result = contractWith({
      bare: {
        code: null,
        stdout: '',
        stderr: '',
        error: new Error('spawn E2BIG'),
      },
    });
    assert.equal(result.problems.length, 1);
    assert.match(result.problems[0], /could not run: spawn E2BIG/);
  });
});

describe('binary contract launcher guard probes', () => {
  it('fails when an old runtime is ignored (guard absent — version still printed)', () => {
    const result = contractWith({ guardRefused: versionOut() });
    assert.equal(result.problems.length, 2);
    for (const problem of result.problems) {
      assert.match(problem, /exited 0 \(expected 1 — named Node guard/);
    }
  });

  it('fails when the refusal line drifts', () => {
    const result = contractWith({
      guardRefused: {
        code: 1,
        stdout: '',
        stderr: 'kubic: node 22+ required\n',
        error: null,
      },
    });
    assert.equal(result.problems.length, 2);
    for (const problem of result.problems) {
      assert.match(problem, /expected exactly/);
    }
  });

  it('fails when the refusal leaks to stdout (stderr must carry it alone)', () => {
    const result = contractWith({
      guardRefused: (stub) => ({
        code: 1,
        stdout: `${nodeGuardLine(stub)}\n`,
        stderr: '',
        error: null,
      }),
    });
    const leaks = result.problems.filter((p) => /stderr-only/.test(p));
    assert.equal(leaks.length, 2);
  });

  it('fails when the guard fires at the exact floor (22.19.0)', () => {
    const result = contractWith({
      guardBoundary: {
        code: 1,
        stdout: '',
        stderr: `${nodeGuardLine('22.19.0')}\n`,
        error: null,
      },
    });
    assert.equal(result.problems.length, 1);
    assert.match(result.problems[0], /must not fire at >= 22\.19/);
  });

  it('fails when the passing guard still writes to stderr', () => {
    const result = contractWith({
      guardBoundary: {
        ...versionOut(),
        stderr: `${nodeGuardLine('22.19.0')}\n`,
      },
    });
    assert.equal(result.problems.length, 1);
    assert.match(result.problems[0], /must stay silent when it passes/);
  });
});

describe('binary contract failure probes', () => {
  it('fails when the injected failure exits 0', () => {
    const result = contractWith({ crash: { ...crashOut(), code: 0 } });
    assert.equal(result.problems.length, 1);
    assert.match(result.problems[0], /exited 0 \(expected 1/);
  });

  it('fails when a raw stack leaks without KUBIC_DEBUG', () => {
    const result = contractWith({ crash: debugCrashOut() });
    assert.equal(result.problems.length, 1);
    assert.match(result.problems[0], /one named line, no stack/);
  });

  it('fails when the failure output leaks to stdout', () => {
    const result = contractWith({
      crash: { ...crashOut(), stdout: 'noise\n' },
    });
    assert.equal(result.problems.length, 1);
    assert.match(result.problems[0], /failures are stderr-only/);
  });

  it('fails when KUBIC_DEBUG=1 hides the stack', () => {
    const result = contractWith({ debugCrash: crashOut() });
    assert.equal(result.problems.length, 1);
    assert.match(result.problems[0], /must include the full stack/);
  });

  it('fails when KUBIC_DEBUG=1 loses the named error line', () => {
    const result = contractWith({
      debugCrash: {
        code: 1,
        stdout: '',
        stderr: `Error: ${CRASH_PROBE_MESSAGE}\n    at main (file:///probe/main.js:1:1)\n`,
        error: null,
      },
    });
    assert.equal(result.problems.length, 1);
    assert.match(result.problems[0], /lost the `error: <message>` line/);
  });

  it('fails when the seam fires without the env gate (internal-only breach)', () => {
    const result = contractWith({ ungatedCrash: crashOut() });
    // Exit code and stderr; stdout is empty either way.
    assert.equal(result.problems.length, 2);
    for (const problem of result.problems) {
      assert.match(problem, /without the env gate/);
    }
    assert.match(result.problems[0], /exited 1 \(expected 2/);
  });
});

describe('binary contract unknown-command probe', () => {
  it('fails when an unknown command exits 1 (the old posture)', () => {
    const result = contractWith({ unknown: { ...unknownOut(), code: 1 } });
    assert.equal(result.problems.length, 1);
    assert.match(result.problems[0], /exited 1 \(expected 2/);
  });

  it('fails when the unknown-command path writes to stdout', () => {
    const result = contractWith({
      unknown: { ...unknownOut(), stdout: `${ROOT_HELP_TEXT}\n` },
    });
    assert.equal(result.problems.length, 1);
    assert.match(result.problems[0], /expected an empty stdout/);
  });

  it('fails when the unknown-command path drops the error line', () => {
    const result = contractWith({ unknown: { ...unknownOut(), stderr: '' } });
    assert.equal(result.problems.length, 1);
    assert.match(
      result.problems[0],
      /expected the error line, the prompt hint/,
    );
  });

  it('fails when the unknown-command path drops the prompt hint', () => {
    const result = contractWith({
      unknown: {
        ...unknownOut(),
        stderr: `${unknownCommandError('nosuch-command')}\n${UNKNOWN_COMMAND_HELP_HINT}\n`,
      },
    });
    assert.equal(result.problems.length, 1);
    assert.match(result.problems[0], /prompt hint/);
  });
});

describe('binary contract bare-prompt probe', () => {
  it('fails when the bare prompt does not run like `kubic run -p`', () => {
    const result = contractWith({
      barePrompt: { ...barePromptOut(), code: 2 },
    });
    assert.equal(result.problems.length, 1);
    assert.match(result.problems[0], /exited 2 \(expected 0/);
  });

  it('fails when the bare prompt does not settle completed', () => {
    const result = contractWith({
      barePrompt: ok(
        `${JSON.stringify({ ok: false, exitCode: 1, status: 'failed' })}\n`,
      ),
    });
    assert.equal(result.problems.length, 1);
    assert.match(result.problems[0], /expected ok:true, status:"completed"/);
  });

  it('fails when the bare prompt prints more than one document', () => {
    const result = contractWith({
      barePrompt: ok(
        `${JSON.stringify({ ok: true, exitCode: 0, status: 'completed' })}\nnoise\n`,
      ),
    });
    assert.equal(result.problems.length, 1);
    assert.match(result.problems[0], /exactly one --json envelope/);
  });
});

describe('kubic launcher source contract', () => {
  it('decides the 22.19 floor table-style (no old runtime needed)', () => {
    const cases = [
      ['20.11.1', false],
      ['21.9.0', false],
      ['22.0.0', false],
      ['22.18.0', false],
      ['22.18.99', false],
      ['22.19.0', true],
      ['22.19.1', true],
      ['22.20.0', true],
      ['23.0.0', true],
      ['24.13.0', true],
      ['22', false],
      ['garbage', false],
    ];
    for (const [version, expected] of cases) {
      assert.equal(
        nodeVersionSupported(version),
        expected,
        `node ${version} should ${expected ? 'pass' : 'refuse'}`,
      );
    }
  });

  it('keeps the guard ahead of the dist import with no top-level await before it', () => {
    const src = readFileSync(join(ROOT, 'bin', 'kubic.js'), 'utf8');
    // Executable order only: comments above the guard may (and should)
    // explain the hazard without tripping the assertion.
    const code = src
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/[^\n]*/g, '');
    const guardAt = code.indexOf('nodeVersionSupported(process.versions.node)');
    const importAt = code.indexOf("await import('../dist/kubic.js')");
    assert.ok(
      guardAt !== -1,
      'bin/kubic.js must call nodeVersionSupported(process.versions.node)',
    );
    assert.ok(
      importAt !== -1,
      'bin/kubic.js must keep the built-entry dynamic import',
    );
    assert.ok(
      guardAt < importAt,
      'the guard must precede the dynamic import — a top-level await before it re-introduces the raw SyntaxError on old runtimes',
    );
    assert.doesNotMatch(
      code.slice(0, guardAt),
      /\bawait\b/,
      'no top-level await may precede the guard',
    );
  });

  it('keeps the guard module import-free with no top-level await', () => {
    const src = readFileSync(join(ROOT, 'bin', 'node-guard.mjs'), 'utf8');
    // Executable tokens only, the same stripping as the wrapper-order
    // assertion above: the module header may (and should) explain the
    // hazard without tripping the assertion.
    const code = src
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/[^\n]*/g, '');
    assert.doesNotMatch(
      code,
      /\bimport\b/,
      'bin/node-guard.mjs must not import anything — bin/kubic.js imports it statically, so any dependency would have to parse on the very runtimes the guard exists to refuse',
    );
    assert.doesNotMatch(
      code,
      /\bawait\b/,
      'bin/node-guard.mjs must not contain `await` — a top-level await makes the static import from bin/kubic.js a parse error before the guard can print the named requirement',
    );
  });

  it('prints the named refusal the shipped contract pins', () => {
    const src = readFileSync(join(ROOT, 'bin', 'kubic.js'), 'utf8');
    // The refusal is a template literal in the wrapper (the version is
    // interpolated at runtime); matched as a regex so the literal text,
    // `${...}` and all, is pinned without tripping
    // lint/suspicious/noTemplateCurlyInString.
    assert.match(
      src,
      /kubic: node >= 22\.19 required \(running \$\{process\.versions\.node\}\) — see the README install section/,
    );
  });
});

describe('binary contract doctor probe', () => {
  it('fails when doctor exits 0 (exit-code drift)', () => {
    const result = contractWith({ doctor: doctorOut(0) });
    assert.equal(result.problems.length, 1);
    assert.match(result.problems[0], /doctor` exited 0 \(expected 6/);
  });

  it('fails when the provider-down reason string changes', () => {
    const drifted = PROVIDER_FAIL.replace(
      '(provider-down)',
      '(provider-missing)',
    );
    const result = contractWith({
      doctor: doctorOut(6, [drifted]),
    });
    assert.ok(
      result.problems.some((p) => /provider-missing/.test(p)),
      `expected reason drift, got ${JSON.stringify(result.problems)}`,
    );
  });

  it('fails when the check id is renamed', () => {
    const renamed = PROVIDER_FAIL.replace(
      'limit:provider-availability',
      'limit:provider-reachability',
    );
    const result = contractWith({ doctor: doctorOut(6, [renamed]) });
    assert.ok(
      result.problems.some((p) =>
        /limit:provider-availability \(provider-down\)/.test(p),
      ),
      `expected check-id drift, got ${JSON.stringify(result.problems)}`,
    );
  });

  it('fails when a second FAIL line appears (runner is not clean)', () => {
    const result = contractWith({
      doctor: doctorOut(1, [
        PROVIDER_FAIL,
        'FAIL dep:node (deps-missing): node 20.0.0 (need >=22.19)',
      ]),
    });
    assert.ok(
      result.problems.some((p) => /2 FAIL line\(s\)/.test(p)),
      `expected fail-count drift, got ${JSON.stringify(result.problems)}`,
    );
  });
});

describe('binary contract provider-less run probe', () => {
  it('fails when the run exits 0', () => {
    const result = contractWith({ run: runOut(0) });
    assert.equal(result.problems.length, 1);
    assert.match(result.problems[0], /run -p` exited 0 \(expected 6/);
  });

  it('fails when a ref is missing', () => {
    const base = runOut();
    const result = contractWith({
      run: {
        ...base,
        stdout: base.stdout.replace(/^trajectory: .*\n/m, ''),
      },
    });
    assert.equal(result.problems.length, 1);
    assert.match(result.problems[0], /missing the `trajectory:` ref/);
  });

  it('fails when a ref points at a different session', () => {
    const base = runOut();
    const result = contractWith({
      run: {
        ...base,
        stdout: base.stdout.replace(/^usage: .*/m, 'usage: usage:deadbeef'),
      },
    });
    assert.equal(result.problems.length, 1);
    assert.match(result.problems[0], /does not point at session/);
  });

  // The trajectory ref is the written file, never the old
  // `trajectory:<id>` string that resolved to nothing.
  it("fails when the trajectory ref is not that session's trajectory.json", () => {
    for (const ref of [
      `trajectory:${SESSION}`,
      '/home/.kubic/sessions/deadbeef/trajectory.json',
    ]) {
      const base = runOut();
      const result = contractWith({
        run: {
          ...base,
          stdout: base.stdout.replace(/^trajectory: .*/m, `trajectory: ${ref}`),
        },
      });
      assert.equal(result.problems.length, 1, ref);
      assert.match(
        result.problems[0],
        /`trajectory:` ref .* does not point at session/,
      );
    }
  });

  it('fails when the provider message changes', () => {
    const base = runOut();
    const result = contractWith({
      run: {
        ...base,
        stdout: base.stdout.replace(
          /no models available: register a provider first/g,
          'no provider configured',
        ),
      },
    });
    assert.ok(
      result.problems.some((p) =>
        /no models available: register a provider first/.test(p),
      ),
      `expected provider-message drift, got ${JSON.stringify(result.problems)}`,
    );
  });
});

describe('binary contract cleanup', () => {
  it('a failing run leaves no temp dir behind (cleanup survives the exit path)', () => {
    // The contract exits non-zero on violation; process.exit() would kill the
    // process before the finally-block cleanup, leaking one scratch dir per
    // failing run. Point TMPDIR at a fresh dir and force the failure path.
    // The script derives its root from its own location, so a copy in a
    // dist-less fixture root takes the missing-build path without renaming
    // the real dist/ (which raced any concurrent build or binary run).
    // realpath: the script's main guard compares argv[1] with its own
    // resolved URL, so a symlinked tmpdir (macOS /var -> /private/var)
    // would skip main entirely and exit 0.
    const sandbox = realpathSync(mkdtempSync(join(tmpdir(), 'bc-cleanup-')));
    try {
      const fixtureRoot = join(sandbox, 'repo');
      const scratchTmp = join(sandbox, 'tmp');
      mkdirSync(join(fixtureRoot, 'scripts'), { recursive: true });
      mkdirSync(scratchTmp);
      copyFileSync(
        join(ROOT, 'scripts', 'binary-contract.mjs'),
        join(fixtureRoot, 'scripts', 'binary-contract.mjs'),
      );
      copyFileSync(
        join(ROOT, 'package.json'),
        join(fixtureRoot, 'package.json'),
      );
      const result = spawnSync(
        process.execPath,
        [join(fixtureRoot, 'scripts', 'binary-contract.mjs')],
        {
          cwd: fixtureRoot,
          env: { ...process.env, TMPDIR: scratchTmp },
          encoding: 'utf8',
        },
      );
      assert.equal(result.status, 1, 'the missing-dist path must exit 1');
      assert.match(result.stderr, /binary contract: missing build output/);
      assert.deepEqual(
        readdirSync(scratchTmp),
        [],
        'no scratch dir may survive a failing run',
      );
    } finally {
      rmSync(sandbox, { recursive: true, force: true });
    }
  });
});

describe('binary contract --json purity probes', () => {
  it('fails when the models.json receipt leaks to stdout', () => {
    const result = contractWith({
      modelsJson: {
        ...modelsJsonOut(),
        stdout: `${MODELS_RECEIPT_PREFIX} /x/models.json (project, trusted): local\n[]\n`,
      },
    });
    assert.ok(
      result.problems.some((p) => /leaked the models.json receipt/.test(p)),
      JSON.stringify(result.problems),
    );
  });

  it('fails when models --json stdout is not one JSON document', () => {
    const result = contractWith({
      modelsJson: { ...modelsJsonOut(), stdout: 'not json\n' },
    });
    assert.ok(
      result.problems.some((p) => /not one JSON document/.test(p)),
      JSON.stringify(result.problems),
    );
  });

  it('fails when the receipt is missing from stderr', () => {
    const result = contractWith({
      doctorJson: { ...doctorJsonOut(), stderr: '' },
    });
    assert.ok(
      result.problems.some((p) =>
        /did not print the models.json receipt/.test(p),
      ),
      JSON.stringify(result.problems),
    );
  });

  it('fails when the refused-config text run leaks the reason to stdout', () => {
    const result = contractWith({
      refusedRunText: {
        ...refusedRunTextOut(),
        stdout: `error: ${REFUSAL_MESSAGE}\n`,
      },
    });
    assert.ok(
      result.problems.some((p) => /stderr-only/.test(p)),
      JSON.stringify(result.problems),
    );
  });

  it('fails when the refused-config envelope is missing under --json', () => {
    const result = contractWith({
      refusedRunJson: { ...refusedRunJsonOut(), stdout: '' },
    });
    assert.ok(
      result.problems.some((p) => /exactly one envelope/.test(p)),
      JSON.stringify(result.problems),
    );
  });

  it('fails when the refused-config envelope reports a different exit', () => {
    const result = contractWith({
      refusedRunJson: { ...refusedRunJsonOut(), code: 2 },
    });
    assert.ok(
      result.problems.some((p) => /exited 2 \(expected 1/.test(p)),
      JSON.stringify(result.problems),
    );
  });

  it('fails when the refused-config envelope does not name the reason', () => {
    const result = contractWith({
      refusedRunJson: {
        ...refusedRunJsonOut(),
        stdout: `${JSON.stringify({
          ok: false,
          exitCode: 1,
          error: { kind: 'failed', message: 'refused' },
        })}\n`,
      },
    });
    assert.ok(
      result.problems.some((p) => /does not name the reason/.test(p)),
      JSON.stringify(result.problems),
    );
  });
});

describe('binary contract command help probes', () => {
  it('fails when a command help request boots a lane (writes to stderr)', () => {
    const result = contractWith({
      runHelp: {
        ...commandHelpOut('run'),
        stderr:
          'warning: this run executes in-process with your user authority\n',
      },
    });
    assert.ok(
      result.problems.some((p) => /must not boot a lane/.test(p)),
      JSON.stringify(result.problems),
    );
  });

  it('fails when a command help request exits non-zero', () => {
    const result = contractWith({
      runHelp: { ...commandHelpOut('run'), code: 1 },
    });
    assert.ok(
      result.problems.some((p) => /exited 1 \(expected 0/.test(p)),
      JSON.stringify(result.problems),
    );
  });

  it('fails when a command help request prints the wrong usage', () => {
    const result = contractWith({
      tuiHelp: commandHelpOut('doctor'),
    });
    assert.ok(
      result.problems.some((p) => /did not print its usage line/.test(p)),
      JSON.stringify(result.problems),
    );
  });
});

describe('binary contract symlinked-bin probe', () => {
  const linkedVersion = () => ({
    code: 0,
    stdout: `${VERSION_LINE}\n`,
    stderr: '',
    error: null,
  });

  it('passes when --version through the symlink prints the version line', () => {
    let seen = null;
    const result = contractWith(
      {},
      {
        runSymlinked: (args) => {
          seen = args;
          return linkedVersion();
        },
      },
    );
    assert.deepEqual(result.problems, []);
    assert.deepEqual(seen, ['--version']);
  });

  it('is skipped when the symlinked runner is absent', () => {
    const result = contractWith();
    assert.deepEqual(result.problems, []);
  });

  it('fails when the symlinked run exits nonzero', () => {
    const result = contractWith(
      {},
      {
        runSymlinked: () => ({
          code: 1,
          stdout: '',
          stderr: 'error: cannot find module',
          error: null,
        }),
      },
    );
    assert.equal(result.problems.length, 1);
    assert.match(result.problems[0], /symlinked bin exited 1/);
  });
});
