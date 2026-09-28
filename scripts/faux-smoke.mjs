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
//   - the tool run's §46 trajectory (issue #383): the envelope's trajectory
//     ref is the absolute path of `<sessions-root>/<id>/trajectory.json`,
//     the file parses, and `replay <file> --tier recorded`, `eval
//     --trajectory <json>` and `export --trajectory <file> --type sft` all
//     succeed on it;
//   - `orchestrate -p … --yes --json` in a scratch git repo: the manager
//     delegates, every worker process answers from the faux provider (the
//     switch crosses the §3.8 spawn allowlist), and the run completes; each
//     `kubic workers` row's session holds a trajectory whose worker id,
//     generation and pid match the row, recorded in the worker's own
//     worktree.
//
// The checks are pure (`fauxSmoke({ run, readFile, sessionsRoot, cwd })`)
// so scripts/faux-smoke.test.mjs pins them with canned probes; the real
// runner spawns bin/kubic.js.

import { spawnSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const FAUX_ENV = { KUBIC_PROVIDER: 'faux' };
export const FAUX_NOTICE_FRAGMENT = 'testing provider';
export const TOOL_PROMPT = 'faux:tool ls {"path":"."}';

// `--json` stdout is exactly one JSON document (formatJson indents it, so
// it may span lines); anything else on stdout is a contract break.
function envelopeOf(label, probe, problems) {
  try {
    return JSON.parse(probe.stdout.trim());
  } catch {
    problems.push(
      `${label}: stdout is not a JSON envelope (${JSON.stringify(probe.stdout.trim().slice(-200))})`,
    );
    return undefined;
  }
}

// A run's trajectory file, parsed; a problem (and undefined) when the ref
// does not name a readable §46 record.
function trajectoryAt(label, path, readFile, problems) {
  if (typeof path !== 'string' || !path.endsWith('/trajectory.json')) {
    problems.push(
      `${label}: trajectory ref ${JSON.stringify(path)} does not name a trajectory.json file`,
    );
    return undefined;
  }
  try {
    const parsed = JSON.parse(readFile(path));
    if (parsed?.schema_version !== '1.0' || parsed?.provenance === undefined) {
      problems.push(`${label}: ${path} is not a §46 trajectory export`);
      return undefined;
    }
    return parsed;
  } catch (error) {
    problems.push(`${label}: cannot read ${path} (${error.message})`);
    return undefined;
  }
}

// Replay, eval and export all consume the run-produced file (issue #383):
// the analysis surfaces are no longer fixture-only.
function consumeTrajectory(run, path, readFile, problems) {
  const replay = run(['replay', path, '--tier', 'recorded', '--json'], {
    env: FAUX_ENV,
  });
  if (replay.code !== 0) {
    problems.push(
      `replay of a run trajectory: exit ${replay.code}, want 0 (${replay.stdout.trim().slice(-300)} ${replay.stderr.trim().slice(-300)})`,
    );
  }
  const scored = run(
    [
      'eval',
      '--trajectory',
      readFile(path),
      '--suite',
      'bugfix-repro',
      '--tier',
      'smoke',
      '--json',
    ],
    { env: FAUX_ENV },
  );
  if (scored.code !== 0) {
    problems.push(
      `eval --trajectory of a run trajectory: exit ${scored.code}, want 0 (${scored.stdout.trim().slice(-300)} ${scored.stderr.trim().slice(-300)})`,
    );
  }
  const exported = run(['export', '--trajectory', path, '--type', 'sft'], {
    env: FAUX_ENV,
  });
  if (exported.code !== 0) {
    problems.push(
      `export --type sft of a run trajectory: exit ${exported.code}, want 0 (${exported.stdout.trim().slice(-300)} ${exported.stderr.trim().slice(-300)})`,
    );
  }
}

// Each worker row's own trajectory (issue #383, §74): written by the worker
// child into its session, with the row's identity as provenance.
function checkWorkerTrajectories(run, readFile, sessionsRoot, cwd, problems) {
  const workers = run(['workers', '--json'], { env: FAUX_ENV });
  const rows = envelopeOf('kubic workers --json', workers, problems);
  if (!Array.isArray(rows) || rows.length === 0) {
    problems.push('kubic workers --json: no worker rows after orchestrate');
    return;
  }
  for (const row of rows) {
    const label = `worker ${row.workerId} trajectory`;
    const trajectory = trajectoryAt(
      label,
      `${sessionsRoot}/${row.sessionId}/trajectory.json`,
      readFile,
      problems,
    );
    if (trajectory === undefined) continue;
    if (trajectory.identity?.workerId !== row.workerId) {
      problems.push(
        `${label}: workerId ${JSON.stringify(trajectory.identity?.workerId)}, row ${JSON.stringify(row.workerId)}`,
      );
    }
    if (trajectory.provenance.generation !== row.generation) {
      problems.push(
        `${label}: generation ${trajectory.provenance.generation}, row ${row.generation}`,
      );
    }
    if (row.pid !== undefined && trajectory.provenance.pid !== row.pid) {
      problems.push(
        `${label}: pid ${trajectory.provenance.pid}, row ${row.pid}`,
      );
    }
    if (
      typeof trajectory.provenance.worktree !== 'string' ||
      trajectory.provenance.worktree === cwd
    ) {
      problems.push(
        `${label}: worktree ${JSON.stringify(trajectory.provenance.worktree)} is not the worker's own worktree`,
      );
    }
  }
}

export function fauxSmoke({ run, readFile, sessionsRoot, cwd }) {
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
  if (toolEnvelope !== undefined) {
    const path = toolEnvelope.trajectory?.ref;
    const trajectory = trajectoryAt('faux tool run', path, readFile, problems);
    if (trajectory !== undefined) {
      if (trajectory.provenance.sessionId !== toolEnvelope.sessionId) {
        problems.push(
          `faux tool run trajectory: session ${JSON.stringify(trajectory.provenance.sessionId)}, envelope ${JSON.stringify(toolEnvelope.sessionId)}`,
        );
      }
      if (!trajectory.actions?.some((action) => action.tool === 'ls')) {
        problems.push('faux tool run trajectory: the ls call is not an action');
      }
      consumeTrajectory(run, path, readFile, problems);
    }
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
  } else {
    checkWorkerTrajectories(run, readFile, sessionsRoot, cwd, problems);
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
    const { problems } = fauxSmoke({
      run: realRunner(root, { cwd, home }),
      readFile: (path) => readFileSync(path, 'utf8'),
      sessionsRoot: join(home, '.kubic', 'sessions'),
      cwd,
    });
    if (problems.length > 0) {
      for (const problem of problems) console.error(`faux smoke: ${problem}`);
      process.exitCode = 1;
    } else {
      console.log(
        'faux smoke OK: KUBIC_PROVIDER=faux run --json completed (echo + ls tool call), its trajectory.json read by replay/eval/export, text result block, unknown provider refused (exit 6), orchestrate --yes completed across worker processes, each worker trajectory matching its kubic workers row',
      );
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}
