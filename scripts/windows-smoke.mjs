// The built binary on Windows (CI's windows job), runnable on any system:
// under a scratch HOME and a trusted scratch cwd with the faux provider,
// `kubic run` makes a bash tool call — on Windows it runs through Git Bash —
// that writes a file in the workspace; the file lands, the run writes its
// trajectory, the journal records the file (`kubic log`), and `kubic doctor`
// fails no check on the fresh HOME, names the shell the bash tool runs
// through and the AGENTS.md the run loads. No network, no key. Run after
// `npm run build`.

import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const BIN = join(ROOT, 'bin', 'kubic.js');

function kubic(args, cwd, home) {
  return spawnSync(process.execPath, [BIN, ...args], {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      KUBIC_PROVIDER: 'faux',
      KUBIC_NO_NOTICE: '1',
      KUBIC_TRUST_PROJECT: '1',
      NO_COLOR: '1',
    },
    timeout: 120_000,
  });
}

function fail(message, result) {
  console.error(`windows-smoke: ${message}`);
  if (result !== undefined) {
    console.error(
      `exit ${result.status}\n--- stdout\n${result.stdout}\n--- stderr\n${result.stderr}`,
    );
  }
  process.exitCode = 1;
}

const home = mkdtempSync(join(tmpdir(), 'kubic-smoke-home-'));
const cwd = mkdtempSync(join(tmpdir(), 'kubic-smoke-ws-'));
try {
  writeFileSync(join(cwd, 'AGENTS.md'), '# Smoke\n\nAnswer in one line.\n');
  const prompt =
    'faux:tool bash {"command":"echo from-the-bash-tool > made.txt"}';
  const run = kubic(['run', `--prompt=${prompt}`, '--json'], cwd, home);
  const envelope = JSON.parse(run.stdout.trim().split('\n').at(-1) ?? '{}');
  if (run.status !== 0 || envelope.status !== 'completed') {
    fail('kubic run did not complete', run);
  } else if (
    !readFileSync(join(cwd, 'made.txt'), 'utf8').includes('from-the-bash-tool')
  ) {
    fail('the bash tool did not write made.txt', run);
  } else if (run.stderr.includes('trajectory not written')) {
    fail('the run wrote no trajectory', run);
  }
  const log = kubic(['log'], cwd, home);
  if (log.status !== 0 || !log.stdout.includes('made.txt')) {
    fail('kubic log does not name made.txt', log);
  }
  const doctor = kubic(['doctor', '--json'], cwd, home);
  const report = JSON.parse(doctor.stdout);
  const failing = (report.checks ?? []).filter(
    (check) => check.status === 'fail',
  );
  if (failing.length > 0) {
    fail(
      `doctor fails on a fresh HOME: ${failing.map((check) => `${check.id}: ${check.detail}`).join('; ')}`,
      doctor,
    );
  }
  const platform = (report.checks ?? []).find(
    (check) => check.id === 'platform:shell',
  );
  if (platform?.status !== 'pass') {
    fail(`platform:shell is ${platform?.status}: ${platform?.detail}`, doctor);
  }
  const instructions = (report.checks ?? []).find(
    (check) => check.id === 'instructions',
  );
  if (!/^1 loaded \(.*AGENTS\.md\)$/.test(instructions?.detail ?? '')) {
    fail(`instructions: ${instructions?.detail}`, doctor);
  }
  if (process.exitCode !== 1) console.log('windows-smoke: ok');
} finally {
  rmSync(home, { recursive: true, force: true });
  rmSync(cwd, { recursive: true, force: true });
}
