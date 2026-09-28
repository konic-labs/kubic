// Pins the faux smoke checker (scripts/faux-smoke.mjs) with canned probes:
// a healthy binary passes, and each way the faux path can break is named.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { FAUX_ENV, fauxSmoke, TOOL_PROMPT } from './faux-smoke.mjs';

function envelope(status, summary, extra = {}) {
  return JSON.stringify({
    ok: status === 'completed',
    status,
    result: { summary },
    ...extra,
  });
}

// A binary that behaves: echo, a tool round-trip, text mode, the refusal.
function healthy(overrides = {}) {
  return (args, opts = {}) => {
    const key = `${args.join(' ')}|${opts.env?.KUBIC_PROVIDER ?? ''}`;
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
    if (args.includes(TOOL_PROMPT)) {
      return {
        code: 0,
        stdout: envelope('completed', 'faux: ls returned 12 chars'),
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

describe('faux smoke checker', () => {
  it('passes a healthy binary and always sets the faux switch', () => {
    const seen = [];
    const run = healthy();
    const result = fauxSmoke({
      run: (args, opts) => {
        seen.push(opts?.env?.KUBIC_PROVIDER);
        return run(args, opts);
      },
    });
    assert.deepEqual(result.problems, []);
    assert.equal(FAUX_ENV.KUBIC_PROVIDER, 'faux');
    assert.ok(seen.every((value) => value === 'faux' || value === 'bogus'));
  });

  it('names a run that did not complete', () => {
    const { problems } = fauxSmoke({
      run: healthy({
        'run -p hello --json|faux': {
          code: 6,
          stdout: envelope('provider_probe_failed', 'no models'),
          stderr: '',
        },
      }),
    });
    assert.ok(problems.some((p) => p.includes('exit 6, want 0')));
    assert.ok(problems.some((p) => p.includes('want "completed"')));
    assert.ok(problems.some((p) => p.includes('does not name the faux')));
  });

  it('names a non-JSON envelope and a missing tool round-trip', () => {
    const { problems } = fauxSmoke({
      run: healthy({
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
      }),
    });
    assert.ok(problems.some((p) => p.includes('not a JSON envelope')));
    assert.ok(
      problems.some((p) => p.includes('does not report the ls result')),
    );
  });

  it('names a provider switch that falls through silently', () => {
    const { problems } = fauxSmoke({
      run: healthy({
        'run -p x --json|bogus': {
          code: 0,
          stdout: envelope('completed', 'x'),
          stderr: '',
        },
      }),
    });
    assert.ok(problems.some((p) => p.startsWith('unknown KUBIC_PROVIDER')));
  });

  it('names a failed orchestration', () => {
    const { problems } = fauxSmoke({
      run: healthy({
        'orchestrate -p say hi --yes --json|faux': {
          code: 1,
          stdout: envelope('failed', 'x', {
            error: { message: 'worker exited 6' },
          }),
          stderr: '',
        },
      }),
    });
    assert.ok(
      problems.some(
        (p) => p.includes('faux orchestrate') && p.includes('worker exited 6'),
      ),
    );
  });
});
