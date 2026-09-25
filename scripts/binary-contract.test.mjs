// Unit tests for the shipped-artifact contract (issue #101).
// Static repo state, no build needed: the probe runner is injected, so the
// assertion logic is exercised without dist/ — the real binary run lives in
// scripts/binary-contract.mjs (CI: the `binary-contract` job).
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { binaryContract, expectedVersionLine } from './binary-contract.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const SESSION = '01a0d7d9-d6fb-71c2-bcfa-15f762197e6b';
const VERSION_LINE = 'kubic 0.0.0 (license: MIT)';
const RUN_MESSAGE = 'no models available: register a provider first';
const PROVIDER_FAIL =
  'FAIL limit:provider-availability (provider-down): no providers configured — configure a provider; `kubic run` exits 6 on provider failure (§78)';

function ok(stdout) {
  return { code: 0, stdout, stderr: '', error: null };
}

function versionOut(text = VERSION_LINE) {
  return ok(`${text}\n`);
}

function doctorOut(code = 6, fails = [PROVIDER_FAIL]) {
  const lines = [
    'PASS dep:node (ok): node 24.13.0 (need >=22.19)',
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
    `trajectory: trajectory:${SESSION}`,
  ];
  return { code, stdout: `${lines.join('\n')}\n`, stderr: '', error: null };
}

// Replays the three probes with the given per-command overrides.
function fakeRun(overrides = {}) {
  return (args) => {
    if (args[0] === '--version') return overrides.version ?? versionOut();
    if (args[0] === 'doctor') return overrides.doctor ?? doctorOut();
    if (args[0] === 'run') return overrides.run ?? runOut();
    throw new Error(`unexpected probe: ${args.join(' ')}`);
  };
}

function contractWith(overrides = {}, options = {}) {
  return binaryContract({
    distPresent: options.distPresent ?? true,
    expectedLine: VERSION_LINE,
    run: fakeRun(overrides),
  });
}

describe('binary contract (issue #101)', () => {
  it('passes on the clean provider-less baseline', () => {
    assert.deepEqual(contractWith().problems, []);
  });

  it('fails when the build output is missing', () => {
    const result = contractWith({}, { distPresent: false });
    assert.equal(result.problems.length, 1);
    assert.match(result.problems[0], /dist\/apps\/kubic\/src\/main\.js/);
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
        'FAIL extension:bundle (extension-posture): bundle missing',
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

// ci.yml wiring (issue #101): the contract above only gates a push once
// the workflow actually builds and runs the binary. Text-matched like
// erasable.test.mjs's CI check — the job block is delimited by its own
// 2-space job key, so an edit that drops the step fails here.
function jobBlock(name) {
  const yml = readFileSync(
    join(ROOT, '.github', 'workflows', 'ci.yml'),
    'utf8',
  );
  const start = yml.indexOf(`\n  ${name}:`);
  assert.ok(start !== -1, `ci.yml must define a \`${name}\` job`);
  const rest = yml.slice(start + 1);
  const next = rest.slice(1).search(/^ {2}[a-z-]+:/m);
  return next === -1 ? rest : rest.slice(0, next + 1);
}

describe('CI wiring (issue #101)', () => {
  it('runs the binary contract in a dedicated job after a real build', () => {
    const job = jobBlock('binary-contract');
    assert.match(job, /actions\/checkout@v4/);
    assert.match(job, /actions\/setup-node@v4/);
    assert.match(job, /node: \['22', '24'\]/);
    assert.match(job, /npm ci/);
    assert.match(job, /npm run build/);
    assert.match(job, /npm run test:binary-contract/);
  });

  it('runs docs:check as its own verify step', () => {
    assert.match(jobBlock('verify'), /- run: npm run docs:check\n/);
  });

  it('npm test includes the binary-contract unit suite', () => {
    const manifest = JSON.parse(
      readFileSync(join(ROOT, 'package.json'), 'utf8'),
    );
    assert.ok(
      manifest.scripts.test.includes('scripts/binary-contract.test.mjs'),
      'npm test must run scripts/binary-contract.test.mjs',
    );
  });

  it('docs/contributing.md lists the new gates for local parity', () => {
    const md = readFileSync(join(ROOT, 'docs', 'contributing.md'), 'utf8');
    for (const needle of [
      'npm run build',
      'npm run test:binary-contract',
      'npm run docs:check',
    ]) {
      assert.ok(
        md.includes(needle),
        `docs/contributing.md must list \`${needle}\` so contributors run the CI gates locally`,
      );
    }
  });

  it('a failing run leaves no temp dir behind (cleanup survives the exit path)', () => {
    // The contract exits non-zero on violation; process.exit() would kill the
    // process before the finally-block cleanup, leaking one scratch dir per
    // failing run. Point TMPDIR at a fresh dir and force the failure path.
    const sandbox = mkdtempSync(join(tmpdir(), 'bc-cleanup-'));
    try {
      const entry = join(ROOT, 'dist/apps/kubic/src/main.js');
      const stashed = `${entry}.cleanup-probe`;
      const hadDist = existsSync(entry);
      if (hadDist) renameSync(entry, stashed);
      try {
        const result = spawnSync(
          process.execPath,
          ['scripts/binary-contract.mjs'],
          {
            cwd: ROOT,
            env: { ...process.env, TMPDIR: sandbox },
            encoding: 'utf8',
          },
        );
        assert.equal(result.status, 1, 'the missing-dist path must exit 1');
        const leftovers = readdirSync(sandbox).filter((n) =>
          n.startsWith('kubic-binary-contract-'),
        );
        assert.deepEqual(
          leftovers,
          [],
          'no scratch dir may survive a failing run',
        );
      } finally {
        if (hadDist) renameSync(stashed, entry);
      }
    } finally {
      rmSync(sandbox, { recursive: true, force: true });
    }
  });
});
