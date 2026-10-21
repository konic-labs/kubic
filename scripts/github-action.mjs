#!/usr/bin/env node
// The Kubic GitHub Action's runner (action.yml): runs `kubic run --json` on
// a pull request — a read-only review by default, or a task — writes the
// step's outputs and summary, and posts the result as a pull-request
// comment. It writes to the repository only when `allow-edits` and `push`
// both say so, and never to a pull request from a fork.
//
// The action passes its inputs as KUBIC_ACTION_* variables, never by
// interpolating them into a script.

import { spawnSync } from 'node:child_process';
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const MAX_COMMENT = 60_000;

/** The action's inputs, from the environment the composite step sets. */
export function readInputs(env) {
  const flag = (name) => (env[name] ?? '').trim().toLowerCase() === 'true';
  return {
    mode: (env.KUBIC_ACTION_MODE ?? 'review').trim() || 'review',
    prompt: (env.KUBIC_ACTION_PROMPT ?? '').trim(),
    base:
      (env.KUBIC_ACTION_BASE ?? '').trim() ||
      (env.GITHUB_BASE_REF ?? '').trim(),
    model: (env.KUBIC_ACTION_MODEL ?? '').trim(),
    maxTurns: (env.KUBIC_ACTION_MAX_TURNS ?? '40').trim() || '40',
    allowEdits: flag('KUBIC_ACTION_ALLOW_EDITS'),
    push: flag('KUBIC_ACTION_PUSH'),
    comment:
      (env.KUBIC_ACTION_COMMENT ?? 'true').trim().toLowerCase() !== 'false',
  };
}

/** Why the inputs cannot run, or undefined. */
export function refusalOf(inputs) {
  if (inputs.mode !== 'review' && inputs.mode !== 'task') {
    return `mode must be "review" or "task" (got ${JSON.stringify(inputs.mode)})`;
  }
  if (inputs.mode === 'task' && inputs.prompt === '') {
    return 'mode "task" needs a prompt';
  }
  if (inputs.push && !inputs.allowEdits) {
    return 'push needs allow-edits: the action writes to the repository only when both say so';
  }
  if (inputs.push && inputs.mode !== 'task') {
    return 'push is for mode "task": a review never writes';
  }
  if (!/^[1-9][0-9]*$/.test(inputs.maxTurns)) {
    return `max-turns must be a positive integer (got ${JSON.stringify(inputs.maxTurns)})`;
  }
  return undefined;
}

/** The prompt a review runs: the pull request's diff against its base. */
export function reviewPrompt(base, extra) {
  const range = base === '' ? 'HEAD~1...HEAD' : `origin/${base}...HEAD`;
  return [
    `Review the changes this pull request makes: read \`git diff ${range}\` and the files it touches.`,
    'Report each finding with its file and line, what is wrong and how to fix it, most important first;',
    'say plainly when you find nothing that needs a change. Do not edit anything.',
    ...(extra === '' ? [] : ['', extra]),
  ].join('\n');
}

/** The `kubic run` arguments the inputs ask for. */
export function kubicArgs(inputs) {
  const prompt =
    inputs.mode === 'review'
      ? reviewPrompt(inputs.base, inputs.prompt)
      : inputs.prompt;
  return [
    'run',
    '--json',
    '--max-turns',
    inputs.maxTurns,
    ...(inputs.model === '' ? [] : ['--model', inputs.model]),
    // Read-only unless edits were opted into: the reviewer role holds no
    // write, edit or git tool, and its shell is read-only.
    ...(inputs.mode === 'review' || !inputs.allowEdits
      ? ['--role', 'reviewer']
      : []),
    `--prompt=${prompt}`,
  ];
}

/** The `--json` envelope: the last stdout line that parses. */
export function parseEnvelope(stdout) {
  const lines = stdout
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    try {
      const parsed = JSON.parse(lines[index]);
      if (parsed !== null && typeof parsed === 'object' && 'status' in parsed) {
        return parsed;
      }
    } catch {
      // Not the envelope line.
    }
  }
  return undefined;
}

/** The pull-request comment for a finished run. */
export function commentBody(inputs, envelope) {
  const title = inputs.mode === 'review' ? 'Kubic review' : 'Kubic task';
  const summary =
    String(envelope?.result?.summary ?? '').trim() || '_No answer._';
  const clipped =
    summary.length > MAX_COMMENT
      ? `${summary.slice(0, MAX_COMMENT)}\n\n_…cut at ${MAX_COMMENT} characters._`
      : summary;
  const facts = [
    `status \`${envelope?.status ?? 'unknown'}\``,
    ...(envelope?.model === undefined ? [] : [`model \`${envelope.model}\``]),
    ...(envelope?.usage?.costUsd === undefined
      ? []
      : [`cost $${Number(envelope.usage.costUsd).toFixed(4)}`]),
  ];
  return `### ${title}\n\n${clipped}\n\n<sub>${facts.join(' · ')}</sub>\n`;
}

function setOutput(name, value) {
  const file = process.env.GITHUB_OUTPUT;
  if (file === undefined) return;
  const delimiter = `kubic-${Math.random().toString(36).slice(2)}`;
  appendFileSync(file, `${name}<<${delimiter}\n${value}\n${delimiter}\n`);
}

function pullRequest() {
  try {
    const event = JSON.parse(
      readFileSync(process.env.GITHUB_EVENT_PATH ?? '', 'utf8'),
    );
    return event.pull_request;
  } catch {
    return undefined;
  }
}

function run(command, args, options = {}) {
  return spawnSync(command, args, {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'inherit'],
    ...options,
  });
}

function pushChanges(pr) {
  if (pr?.head?.repo?.full_name !== pr?.base?.repo?.full_name) {
    console.log('::warning::not pushing: the pull request comes from a fork');
    return;
  }
  if (run('git', ['status', '--porcelain']).stdout.trim() === '') return;
  run('git', ['add', '--all']);
  run('git', [
    '-c',
    'user.name=kubic',
    '-c',
    'user.email=kubic@users.noreply.github.com',
    'commit',
    '--message',
    'chore: apply the Kubic task',
  ]);
  const pushed = run('git', ['push', 'origin', `HEAD:${pr.head.ref}`]);
  if (pushed.status !== 0) console.log('::warning::the push was refused');
}

function main() {
  const inputs = readInputs(process.env);
  const refusal = refusalOf(inputs);
  if (refusal !== undefined) {
    console.log(`::error::${refusal}`);
    process.exit(2);
  }
  const result = run('kubic', kubicArgs(inputs));
  const envelope = parseEnvelope(result.stdout ?? '');
  const exitCode = result.status ?? 1;
  setOutput('status', envelope?.status ?? 'failed');
  setOutput('exit-code', String(exitCode));
  setOutput('summary', String(envelope?.result?.summary ?? ''));
  const body = commentBody(inputs, envelope);
  if (process.env.GITHUB_STEP_SUMMARY !== undefined) {
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, body);
  }
  const pr = pullRequest();
  if (inputs.comment && pr?.number !== undefined) {
    const file = join(tmpdir(), `kubic-comment-${process.pid}.md`);
    writeFileSync(file, body);
    const posted = run('gh', [
      'pr',
      'comment',
      String(pr.number),
      '--body-file',
      file,
    ]);
    if (posted.status !== 0)
      console.log('::warning::the comment could not be posted');
  }
  if (inputs.push && exitCode === 0) pushChanges(pr);
  process.exit(exitCode);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
