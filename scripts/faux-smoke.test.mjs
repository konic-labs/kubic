// Pins the faux smoke checker (scripts/faux-smoke.mjs) with canned probes:
// a healthy binary passes, and each way the faux path can break is named.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { FAUX_ENV, fauxSmoke, TOOL_PROMPT } from './faux-smoke.mjs';

const SESSIONS = '/home/.kubic/sessions';
const CWD = '/repo';
const TOOL_TRAJECTORY = `${SESSIONS}/tool-1/trajectory.json`;

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
    schema_version: '1.0',
    identity: { sessionId: 'tool-1', agentId: 'root' },
    provenance: {
      sessionId: 'tool-1',
      agentId: 'root',
      pid: 10,
      worktree: CWD,
      model: 'faux/echo',
    },
    actions: [{ seq: 1, tool: 'ls', args: { path: '.' } }],
    ...overrides,
  };
}

// The canned sessions root: the tool run's trajectory.
function healthyFiles() {
  return {
    [TOOL_TRAJECTORY]: JSON.stringify(trajectory()),
  };
}

// A binary that behaves: echo, a tool round-trip with its trajectory, the
// analysis surfaces over it, text mode and the refusal.
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
    if (args[0] === 'benchmark') {
      // Seven executable fixtures, one live-PTY stub.
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
      'benchmark --model faux/echo --worktree /repo --size smoke --json|faux': {
        code: 0,
        stdout: failedRow,
        stderr: '',
      },
    });
    assert.ok(
      problems.some((p) => p.includes('swe-bench-mini: success false')),
    );

    const refused = smoke({
      'benchmark --model faux/echo --worktree /repo --size smoke --json|faux': {
        code: 2,
        stdout: '',
        stderr: 'error: no executable suites',
      },
    });
    assert.ok(
      refused.problems.some(
        (p) =>
          p.includes('faux benchmark: exit 2, want 0') &&
          p.includes('no executable suites'),
      ),
    );
  });
});

describe('faux smoke checker: run-produced trajectories', () => {
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

  it('names an unreadable or non-trajectory file', () => {
    const missing = smoke({}, {});
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
        p.includes('is not a 1.0 trajectory export'),
      ),
    );
  });

  it('pins the 1.0 export the binary writes and names any other version', () => {
    const ok = smoke(
      {},
      { ...healthyFiles(), [TOOL_TRAJECTORY]: JSON.stringify(trajectory()) },
    );
    assert.deepEqual(ok.problems, []);
    const other = smoke(
      {},
      {
        ...healthyFiles(),
        [TOOL_TRAJECTORY]: JSON.stringify(
          trajectory({ schema_version: '1.4' }),
        ),
      },
    );
    assert.ok(
      other.problems.some((p) => p.includes('is not a 1.0 trajectory export')),
    );
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
});
