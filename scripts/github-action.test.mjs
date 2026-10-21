// The GitHub Action's runner: the inputs it refuses, the read-only review it
// runs by default, the envelope it reads and the comment it posts.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  commentBody,
  kubicArgs,
  parseEnvelope,
  readInputs,
  refusalOf,
} from './github-action.mjs';

describe('the Kubic GitHub Action', () => {
  it('reviews read-only by default, against the base branch', () => {
    const inputs = readInputs({ GITHUB_BASE_REF: 'main' });
    assert.equal(refusalOf(inputs), undefined);
    const args = kubicArgs(inputs);
    assert.deepEqual(args.slice(0, 6), [
      'run',
      '--json',
      '--max-turns',
      '40',
      '--role',
      'reviewer',
    ]);
    assert.match(
      args.at(-1),
      /^--prompt=Review the changes this pull request makes: read `git diff origin\/main\.\.\.HEAD`/,
    );
  });

  it('writes only when allow-edits and push both say so', () => {
    const task = (extra) =>
      readInputs({
        KUBIC_ACTION_MODE: 'task',
        KUBIC_ACTION_PROMPT: 'fix it',
        ...extra,
      });
    assert.ok(kubicArgs(task({})).includes('reviewer'));
    assert.ok(
      !kubicArgs(task({ KUBIC_ACTION_ALLOW_EDITS: 'true' })).includes(
        'reviewer',
      ),
    );
    assert.match(
      refusalOf(task({ KUBIC_ACTION_PUSH: 'true' })),
      /push needs allow-edits/,
    );
    assert.match(
      refusalOf(
        readInputs({
          KUBIC_ACTION_PUSH: 'true',
          KUBIC_ACTION_ALLOW_EDITS: 'true',
        }),
      ),
      /a review never writes/,
    );
    assert.match(
      refusalOf(readInputs({ KUBIC_ACTION_MODE: 'task' })),
      /needs a prompt/,
    );
  });

  it('reads the envelope from the last JSON line and posts its summary', () => {
    const envelope = parseEnvelope(
      'warning: something\n{"ok":true,"status":"completed","result":{"summary":"src/a.ts:3 is wrong"},"model":"faux/echo","usage":{"costUsd":0.0123}}\n',
    );
    assert.equal(envelope.status, 'completed');
    const body = commentBody(readInputs({}), envelope);
    assert.match(body, /^### Kubic review\n\nsrc\/a\.ts:3 is wrong/);
    assert.match(
      body,
      /status `completed` · model `faux\/echo` · cost \$0\.0123/,
    );
    assert.equal(parseEnvelope('not json\n'), undefined);
  });
});
