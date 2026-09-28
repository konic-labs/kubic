// Faux-provider smoke test for the shipped binary: `KUBIC_PROVIDER=faux`
// drives `kubic run` end to end — real lane, real tools, real session
// store and journal — with Pi's faux provider answering, so no network, no
// credentials and no paid tokens are involved. Run after `npm run build`
// (it is part of `npm run test:binary-contract`).
//
// Probes (each under a hermetic HOME and a scratch cwd):
//   - `run -p hello --json`: exit 0, one JSON envelope line, status
//     completed, the echo reply, and the faux provider named on stderr;
//   - `run -p 'faux:tool ls {"path":"."}' --json`: a real tool call runs
//     and the run still completes;
//   - text mode prints the result block on stdout;
//   - an unknown KUBIC_PROVIDER is refused by name (exit 6), never a
//     silent fall-through to a real provider;
//   - `orchestrate -p … --yes --json` in a scratch git repo: the manager
//     delegates, every worker process answers from the faux provider (the
//     switch crosses the §3.8 spawn allowlist), and the run completes.
//
// The checks are pure (`fauxSmoke({ run })`) so scripts/faux-smoke.test.mjs
// pins them with canned probes; the real runner spawns bin/kubic.js.

import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const FAUX_ENV = { KUBIC_PROVIDER: 'faux' };
export const FAUX_NOTICE_FRAGMENT = 'testing provider';
export const TOOL_PROMPT = 'faux:tool ls {"path":"."}';

function lastLine(stdout) {
  const lines = stdout.trim().split('\n');
  return lines[lines.length - 1] ?? '';
}

function envelopeOf(label, probe, problems) {
  try {
    return JSON.parse(lastLine(probe.stdout));
  } catch {
    problems.push(
      `${label}: last stdout line is not a JSON envelope (${JSON.stringify(lastLine(probe.stdout))})`,
    );
    return undefined;
  }
}

export function fauxSmoke({ run }) {
  const problems = [];

  const echo = run(['run', '-p', 'hello', '--json'], { env: FAUX_ENV });
  if (echo.code !== 0) {
    problems.push(
      `faux run --json: exit ${echo.code}, want 0 (stderr: ${echo.stderr.trim()})`,
    );
  }
  const envelope = envelopeOf('faux run --json', echo, problems);
  if (envelope !== undefined) {
    if (envelope.ok !== true || envelope.status !== 'completed') {
      problems.push(
        `faux run --json: status ${JSON.stringify(envelope.status)}, want "completed"`,
      );
    }
    if (envelope.result?.summary !== 'faux echo: hello') {
      problems.push(
        `faux run --json: summary ${JSON.stringify(envelope.result?.summary)}, want "faux echo: hello"`,
      );
    }
  }
  if (!echo.stderr.includes(FAUX_NOTICE_FRAGMENT)) {
    problems.push('faux run: stderr does not name the faux testing provider');
  }

  const tool = run(['run', '-p', TOOL_PROMPT, '--json'], { env: FAUX_ENV });
  const toolEnvelope = envelopeOf('faux tool run', tool, problems);
  if (tool.code !== 0 || toolEnvelope?.status !== 'completed') {
    problems.push(
      `faux tool run: exit ${tool.code} status ${JSON.stringify(toolEnvelope?.status)}, want 0/completed (stderr: ${tool.stderr.trim()})`,
    );
  } else if (
    !/^faux: ls returned \d+ chars$/.test(toolEnvelope.result?.summary)
  ) {
    problems.push(
      `faux tool run: summary ${JSON.stringify(toolEnvelope.result?.summary)} does not report the ls result`,
    );
  }

  const text = run(['run', '-p', 'hi'], { env: FAUX_ENV });
  if (text.code !== 0 || !/^result: faux echo: hi$/m.test(text.stdout)) {
    problems.push(
      `faux text run: exit ${text.code}, stdout ${JSON.stringify(text.stdout)}`,
    );
  }

  const bogus = run(['run', '-p', 'x', '--json'], {
    env: { KUBIC_PROVIDER: 'bogus' },
  });
  if (
    bogus.code !== 6 ||
    !bogus.stdout.includes('unsupported KUBIC_PROVIDER')
  ) {
    problems.push(
      `unknown KUBIC_PROVIDER: exit ${bogus.code}, want 6 with the named refusal`,
    );
  }
  const orchestrate = run(['orchestrate', '-p', 'say hi', '--yes', '--json'], {
    env: FAUX_ENV,
  });
  const orchestrated = envelopeOf('faux orchestrate', orchestrate, problems);
  if (orchestrate.code !== 0 || orchestrated?.status !== 'completed') {
    problems.push(
      `faux orchestrate: exit ${orchestrate.code} status ${JSON.stringify(orchestrated?.status)}, want 0/completed (${JSON.stringify(orchestrated?.error?.message ?? orchestrate.stderr.trim().slice(-300))})`,
    );
  }
  return { problems };
}

// Git identity for the scratch repo and the orchestrator's merges: the
// hermetic HOME has no global git config.
const GIT_IDENTITY = {
  GIT_AUTHOR_NAME: 'kubic-smoke',
  GIT_AUTHOR_EMAIL: 'smoke@kubic.invalid',
  GIT_COMMITTER_NAME: 'kubic-smoke',
  GIT_COMMITTER_EMAIL: 'smoke@kubic.invalid',
};

function realRunner(root, { cwd, home }) {
  return (args, opts = {}) => {
    const result = spawnSync(
      process.execPath,
      [join(root, 'bin', 'kubic.js'), ...args],
      {
        cwd,
        env: {
          PATH: process.env.PATH ?? '',
          HOME: home,
          TMPDIR: process.env.TMPDIR ?? '',
          KUBIC_NO_NOTICE: '1',
          ...GIT_IDENTITY,
          ...opts.env,
        },
        encoding: 'utf8',
        timeout: 60_000,
      },
    );
    return {
      code: result.status,
      stdout: result.stdout ?? '',
      stderr: result.stderr ?? '',
    };
  };
}

// The scratch cwd is a one-commit git repo, so `orchestrate` has a base to
// branch its worker worktrees from.
function initRepo(cwd, home) {
  for (const args of [
    ['init', '-q'],
    ['add', '.'],
    ['commit', '-qm', 'fixture'],
  ]) {
    const result = spawnSync('git', args, {
      cwd,
      env: { PATH: process.env.PATH ?? '', HOME: home, ...GIT_IDENTITY },
      encoding: 'utf8',
    });
    if (result.status !== 0) {
      throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`);
    }
  }
}

if (import.meta.main) {
  const root = join(dirname(fileURLToPath(import.meta.url)), '..');
  const scratch = mkdtempSync(join(tmpdir(), 'kubic-faux-smoke-'));
  try {
    const cwd = join(scratch, 'cwd');
    const home = join(scratch, 'home');
    mkdirSync(cwd);
    mkdirSync(home);
    writeFileSync(join(cwd, 'README.txt'), 'faux smoke fixture\n');
    initRepo(cwd, home);
    const { problems } = fauxSmoke({ run: realRunner(root, { cwd, home }) });
    if (problems.length > 0) {
      for (const problem of problems) console.error(`faux smoke: ${problem}`);
      process.exitCode = 1;
    } else {
      console.log(
        'faux smoke OK: KUBIC_PROVIDER=faux run --json completed (echo + ls tool call), text result block, unknown provider refused (exit 6), orchestrate --yes completed across worker processes',
      );
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}
