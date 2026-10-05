// Pins the faux smoke checker (scripts/faux-smoke.mjs) with canned probes:
// a healthy binary passes, and each way the faux path can break is named.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { FAUX_ENV, fauxSmoke, TOOL_PROMPT } from './faux-smoke.mjs';

const SESSIONS = '/home/.kubic/sessions';
const CWD = '/repo';
const TOOL_TRAJECTORY = `${SESSIONS}/tool-1/trajectory.json`;
const WORKER_TRAJECTORY = `${SESSIONS}/orch-w1/trajectory.json`;

function envelope(status, summary, extra = {}) {
  return JSON.stringify({
    ok: status === 'completed',
    status,
    result: { summary },
    ...extra,
  });
}

function trajectory(overrides = {}) {
  return {
    schema_version: '1.1',
    identity: { sessionId: 'tool-1', agentId: 'root', workerId: null },
    provenance: {
      sessionId: 'tool-1',
      agentId: 'root',
      pid: 10,
      generation: 0,
      worktree: CWD,
      model: 'faux/echo',
    },
    actions: [{ seq: 1, tool: 'ls', args: { path: '.' } }],
    ...overrides,
  };
}

// The canned sessions root: the tool run's trajectory and one worker's.
function healthyFiles() {
  return {
    [TOOL_TRAJECTORY]: JSON.stringify(trajectory()),
    [WORKER_TRAJECTORY]: JSON.stringify(
      trajectory({
        identity: { sessionId: 'orch-w1', agentId: 'w1', workerId: 'w1' },
        provenance: {
          sessionId: 'orch-w1',
          agentId: 'w1',
          pid: 77,
          generation: 1,
          worktree: `${CWD}/.kubic/worktrees/w1`,
          model: 'faux/echo',
        },
      }),
    ),
  };
}

// A binary that behaves: echo, a tool round-trip with its trajectory, the
// analysis surfaces over it, text mode, the refusal, orchestrate + workers.
function healthy(overrides = {}) {
  return (args, opts = {}) => {
    const key = `${args[0]}|${opts.env?.KUBIC_PROVIDER ?? ''}`;
    const full = `${args.join(' ')}|${opts.env?.KUBIC_PROVIDER ?? ''}`;
    if (overrides[full] !== undefined) return overrides[full];
    if (overrides[key] !== undefined) return overrides[key];
    if (opts.env?.KUBIC_PROVIDER === 'bogus') {
      return {
        code: 6,
        stdout: envelope(
          'provider_probe_failed',
          'unsupported KUBIC_PROVIDER "bogus"',
        ),
        stderr: '',
      };
    }
    if (args[0] === 'orchestrate') {
      return { code: 0, stdout: envelope('completed', 'done'), stderr: '' };
    }
    if (args[0] === 'benchmark') {
      // Issue #262: seven executable fixtures, one live-PTY stub.
      const results = [
        'swe-bench-mini',
        'repo-mod-rename',
        'bugfix-repro',
        'refactor-extract',
        'testgen-cover',
        'review-diff',
        'agentic-live',
      ].map((suite) => ({
        suite,
        stub: false,
        skipped: false,
        success: true,
        determinism: 'live',
      }));
      results.push({
        suite: 'terminal-live',
        stub: true,
        skipped: true,
        success: false,
        determinism: 'live',
      });
      return {
        code: 0,
        stdout: JSON.stringify({ ok: true, exitCode: 0, results }),
        stderr: '',
      };
    }
    if (['replay', 'eval', 'export'].includes(args[0])) {
      return { code: 0, stdout: '{}', stderr: '' };
    }
    if (args[0] === 'workers') {
      return {
        code: 0,
        stdout: JSON.stringify([
          { workerId: 'w1', sessionId: 'orch-w1', generation: 1, pid: 77 },
        ]),
        stderr: '',
      };
    }
    if (args.includes(TOOL_PROMPT)) {
      return {
        code: 0,
        stdout: envelope('completed', 'faux: ls returned 12 chars', {
          sessionId: 'tool-1',
          trajectory: { ref: TOOL_TRAJECTORY },
        }),
        stderr: 'warn: provider: faux/echo (testing provider: …)',
      };
    }
    if (!args.includes('--json')) {
      return {
        code: 0,
        stdout: 'result: faux echo: hi\nsession: s\n',
        stderr: '',
      };
    }
    return {
      code: 0,
      stdout: `${envelope('completed', 'faux echo: hello')}\n`,
      stderr: 'warn: provider: faux/echo (testing provider: …)',
    };
  };
}

function smoke(overrides = {}, files = healthyFiles()) {
  return fauxSmoke({
    run: healthy(overrides),
    readFile: (path) => {
      const text = files[path];
      if (text === undefined) throw new Error(`ENOENT: ${path}`);
      return text;
    },
    sessionsRoot: SESSIONS,
    cwd: CWD,
  });
}

describe('faux smoke checker', () => {
  it('passes a healthy binary and always sets the faux switch', () => {
    const seen = [];
    const run = healthy();
    const files = healthyFiles();
    const result = fauxSmoke({
      run: (args, opts) => {
        seen.push(opts?.env?.KUBIC_PROVIDER);
        return run(args, opts);
      },
      readFile: (path) => files[path],
      sessionsRoot: SESSIONS,
      cwd: CWD,
    });
    assert.deepEqual(result.problems, []);
    assert.equal(FAUX_ENV.KUBIC_PROVIDER, 'faux');
    assert.ok(seen.every((value) => value === 'faux' || value === 'bogus'));
  });

  it('names a run that did not complete', () => {
    const { problems } = smoke({
      'run -p hello --json|faux': {
        code: 6,
        stdout: envelope('provider_probe_failed', 'no models'),
        stderr: '',
      },
    });
    assert.ok(problems.some((p) => p.includes('exit 6, want 0')));
    assert.ok(problems.some((p) => p.includes('want "completed"')));
    assert.ok(problems.some((p) => p.includes('does not name the faux')));
  });

  it('names a non-JSON envelope and a missing tool round-trip', () => {
    const { problems } = smoke({
      'run -p hello --json|faux': {
        code: 0,
        stdout: 'oops',
        stderr: 'testing provider',
      },
      [`run -p ${TOOL_PROMPT} --json|faux`]: {
        code: 0,
        stdout: envelope('completed', 'faux echo: faux:tool ls'),
        stderr: '',
      },
    });
    assert.ok(problems.some((p) => p.includes('not a JSON envelope')));
    assert.ok(
      problems.some((p) => p.includes('does not report the ls result')),
    );
  });

  it('names a provider switch that falls through silently', () => {
    const { problems } = smoke({
      'run -p x --json|bogus': {
        code: 0,
        stdout: envelope('completed', 'x'),
        stderr: '',
      },
    });
    assert.ok(problems.some((p) => p.startsWith('unknown KUBIC_PROVIDER')));
  });

  it('names a benchmark whose fixture suite failed, and one that refused', () => {
    const failedRow = JSON.stringify({
      ok: true,
      exitCode: 0,
      results: [
        {
          suite: 'swe-bench-mini',
          stub: false,
          skipped: false,
          success: false,
          determinism: 'live',
        },
      ],
    });
    const { problems } = smoke({
      'benchmark --model faux/echo --worktree /repo --generation 0 --size smoke --json|faux':
        { code: 0, stdout: failedRow, stderr: '' },
    });
    assert.ok(
      problems.some((p) => p.includes('swe-bench-mini: success false')),
    );

    const refused = smoke({
      'benchmark --model faux/echo --worktree /repo --generation 0 --size smoke --json|faux':
        { code: 2, stdout: '', stderr: 'error: no executable suites' },
    });
    assert.ok(
      refused.problems.some(
        (p) =>
          p.includes('faux benchmark: exit 2, want 0') &&
          p.includes('no executable suites'),
      ),
    );
  });

  it('names a failed orchestration', () => {
    const { problems } = smoke({
      'orchestrate -p say hi --yes --json|faux': {
        code: 1,
        stdout: envelope('failed', 'x', {
          error: { message: 'worker exited 6' },
        }),
        stderr: '',
      },
    });
    assert.ok(
      problems.some(
        (p) => p.includes('faux orchestrate') && p.includes('worker exited 6'),
      ),
    );
  });

  // `--json` stdout is exactly one document, which the formatter indents
  // with two spaces (orchestrate's envelope spans many lines).
  it('reads an indented multi-line --json envelope', () => {
    const { problems } = smoke({
      'orchestrate -p say hi --yes --json|faux': {
        code: 0,
        stdout: `${JSON.stringify({ ok: true, status: 'completed' }, null, 2)}\n`,
        stderr: '',
      },
    });
    assert.deepEqual(problems, []);
  });
});

describe('faux smoke checker: run-produced trajectories (issue #383)', () => {
  it('names a trajectory ref that resolves to nothing (the old trajectory:<id> string)', () => {
    const { problems } = smoke({
      [`run -p ${TOOL_PROMPT} --json|faux`]: {
        code: 0,
        stdout: envelope('completed', 'faux: ls returned 12 chars', {
          sessionId: 'tool-1',
          trajectory: { ref: 'trajectory:tool-1' },
        }),
        stderr: '',
      },
    });
    assert.ok(
      problems.some((p) =>
        p.includes('"trajectory:tool-1" does not name a trajectory.json file'),
      ),
    );
  });

  it('names an unreadable or non-§46 trajectory file', () => {
    const missing = smoke({}, { [WORKER_TRAJECTORY]: '{}' });
    assert.ok(
      missing.problems.some(
        (p) =>
          p.startsWith('faux tool run: cannot read') && p.includes('ENOENT'),
      ),
    );
    const foreign = smoke(
      {},
      { ...healthyFiles(), [TOOL_TRAJECTORY]: JSON.stringify({ x: 1 }) },
    );
    assert.ok(
      foreign.problems.some((p) =>
        p.includes('is not a §46 trajectory export'),
      ),
    );
  });

  it('accepts a legacy 1.0 §46 record and the current 1.1 one', () => {
    // 1.1 additions are optional on read (issue #329): both majors pass.
    const legacy = smoke(
      {},
      {
        ...healthyFiles(),
        [TOOL_TRAJECTORY]: JSON.stringify(
          trajectory({ schema_version: '1.0' }),
        ),
      },
    );
    assert.deepEqual(legacy.problems, []);
    const current = smoke(
      {},
      {
        ...healthyFiles(),
        [TOOL_TRAJECTORY]: JSON.stringify(
          trajectory({ schema_version: '1.1' }),
        ),
      },
    );
    assert.deepEqual(current.problems, []);
  });

  it('names a trajectory for another session or without the tool call', () => {
    const { problems } = smoke(
      {},
      {
        ...healthyFiles(),
        [TOOL_TRAJECTORY]: JSON.stringify(
          trajectory({
            provenance: { ...trajectory().provenance, sessionId: 'other' },
            actions: [],
          }),
        ),
      },
    );
    assert.ok(
      problems.some((p) => p.includes('session "other", envelope "tool-1"')),
    );
    assert.ok(problems.some((p) => p.includes('the ls call is not an action')));
  });

  it('names replay, eval and export that fail on the run-produced file', () => {
    const failing = { code: 2, stdout: '', stderr: 'boom' };
    const { problems } = smoke({
      'replay|faux': failing,
      'eval|faux': failing,
      'export|faux': failing,
    });
    for (const label of [
      'replay of a run trajectory: exit 2',
      'eval --trajectory of a run trajectory: exit 2',
      'export --type sft of a run trajectory: exit 2',
    ]) {
      assert.ok(
        problems.some((p) => p.startsWith(label)),
        label,
      );
    }
  });

  it('names worker trajectories that do not match their kubic workers row', () => {
    const { problems } = smoke(
      {},
      {
        ...healthyFiles(),
        [WORKER_TRAJECTORY]: JSON.stringify(
          trajectory({
            identity: { sessionId: 'orch-w1', agentId: 'w1', workerId: 'w9' },
            provenance: {
              sessionId: 'orch-w1',
              agentId: 'w1',
              pid: 78,
              generation: 2,
              worktree: CWD,
              model: 'faux/echo',
            },
          }),
        ),
      },
    );
    for (const fragment of [
      'worker w1 trajectory: workerId "w9", row "w1"',
      'worker w1 trajectory: generation 2, row 1',
      'worker w1 trajectory: pid 78, row 77',
      "is not the worker's own worktree",
    ]) {
      assert.ok(
        problems.some((p) => p.includes(fragment)),
        fragment,
      );
    }
  });

  it('names a worker row without a trajectory, and no rows at all', () => {
    const files = healthyFiles();
    delete files[WORKER_TRAJECTORY];
    const missing = smoke({}, files);
    assert.ok(
      missing.problems.some((p) =>
        p.startsWith('worker w1 trajectory: cannot read'),
      ),
    );
    const none = smoke({
      'workers|faux': { code: 0, stdout: '[]', stderr: '' },
    });
    assert.ok(
      none.problems.includes(
        'kubic workers --json: no worker rows after orchestrate',
      ),
    );
  });
});
