// Request-time credential use, audited.
// A models.json provider key (`apiKeyEnv`, a `$ENV` ref) is resolved through
// resolveSecretRef on EVERY request, each use appends one ledger record
// (ref sentinel, role, purpose — never the value), and the value never lands
// in a persisted file of the run or on the debug channel.
//
// The "provider" is a loopback HTTP server speaking the OpenAI streaming
// shape, owned and closed by the test: no external network, no paid tokens.
import {
  chmodSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { NodeExecutionEnv } from '@kubic/exec/env';
import {
  auditLedgerDir,
  createLedgerModelKeyResolver,
  readAuditLedger,
  runAuditCommand,
} from '@kubic/host/audit';
import { assembleModels } from '@kubic/host/models';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { tempDir } from '../../../../test/temp-dir.js';
import { runHeadlessPrompt } from '../../src/run/command.js';

const SECRET = 'sk-live-kubic-do-not-leak';

const servers: Server[] = [];

beforeEach(() => {
  vi.stubEnv('KUBIC_NO_NOTICE', '1');
  vi.stubEnv('KUBIC_PROVIDER', '');
  vi.stubEnv('GW_API_KEY', SECRET);
});

afterEach(async () => {
  vi.unstubAllEnvs();
  for (const server of servers.splice(0)) {
    await new Promise<void>((done) => server.close(() => done()));
  }
});

// A minimal OpenAI-compatible streaming endpoint. Records each request's
// Authorization header so the test can prove the key really went out.
async function fakeProvider(
  options: {
    rejectEchoingKey?: boolean;
    answerEchoingKey?: boolean;
    // Runs when a request arrives, before the reply (a test's hook into the
    // middle of the run).
    onRequest?: () => void;
  } = {},
): Promise<{ url: string; auths: string[] }> {
  const auths: string[] = [];
  const server = createServer((req, res) => {
    auths.push(String(req.headers.authorization ?? ''));
    options.onRequest?.();
    req.resume();
    req.on('end', () => {
      if (options.rejectEchoingKey === true) {
        // A gateway that reflects the rejected credential in its error body:
        // the value reaches the run through the provider's own error text, not
        // through anything the run wrote itself.
        res.writeHead(401, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            error: {
              message: `invalid credential ${String(req.headers.authorization ?? '')}`,
              type: 'invalid_request_error',
            },
          }),
        );
        return;
      }
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const chunk = (body: unknown): void => {
        res.write(`data: ${JSON.stringify(body)}\n\n`);
      };
      const base = {
        id: 'c1',
        object: 'chat.completion.chunk',
        created: 1,
        model: 'm1',
      };
      chunk({
        ...base,
        choices: [
          {
            index: 0,
            delta: {
              role: 'assistant',
              content:
                options.answerEchoingKey === true
                  ? `your key is ${String(req.headers.authorization ?? '')}`
                  : 'hello',
            },
            finish_reason: null,
          },
        ],
      });
      chunk({
        ...base,
        choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
        usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 },
      });
      res.end('data: [DONE]\n\n');
    });
  });
  servers.push(server);
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const { port } = server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${port}/v1`, auths };
}

function writeModelsJson(
  dir: string,
  baseUrl: string,
  provider: { id: string; apiKeyEnv: string } = {
    id: 'gw',
    apiKeyEnv: 'GW_API_KEY',
  },
): void {
  writeFileSync(
    join(dir, 'models.json'),
    JSON.stringify({
      providers: [
        {
          id: provider.id,
          baseUrl,
          api: 'openai-completions',
          apiKeyEnv: provider.apiKeyEnv,
          models: [{ id: 'm1' }],
        },
      ],
    }),
  );
}

// Every seam of a headless run that defaults to process.cwd() (or the env's
// trust switch) pinned to the temp workspace: the project models.json is
// trust-gated and this suite covers a trusted file's key
// use, not the trust decision — so trust comes from the injected check, not
// KUBIC_TRUST_PROJECT, and skills/roles/models are read from the workspace,
// never the real cwd.
function hermetic(workspace: string) {
  return {
    modelsCwd: workspace,
    env: new NodeExecutionEnv(workspace),
    trustProject: () => true,
    skills: { cwd: workspace, homeDir: workspace, trusted: false },
    roles: { cwd: workspace },
  };
}

function filesUnder(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) out.push(...filesUnder(path));
    else out.push(path);
  }
  return out;
}

describe('createLedgerModelKeyResolver with a short or provider-named key', () => {
  it('appends a ledger row for EVERY use — a dummy key named like its provider is not a secret to refuse over', async () => {
    const workspace = tempDir('ws-credential-short-');
    const errors: string[] = [];
    const resolver = createLedgerModelKeyResolver({
      // Env-only tests: the runner must never fire for $VAR uses.
      runCommand: () => {
        throw new Error('no commands in this test');
      },
      workspace,
      role: 'root',
      sessionId: () => 'sess-credential',
      onError: (message) => errors.push(message),
    });
    const use = {
      provider: 'ollama',
      envVar: 'OLLAMA_API_KEY',
      readEnv: async () => 'ollama',
    };
    // The second use is the one the live-value refusal must not drop: by then
    // the resolved value was in the inventory and matched the row's own
    // provider name.
    expect(await resolver.resolve(use)).toBe('ollama');
    expect(await resolver.resolve(use)).toBe('ollama');
    expect(errors).toEqual([]);
    const rows = readAuditLedger(auditLedgerDir(workspace)).filter(
      (record) => record.what === 'credential:ollama',
    );
    expect(rows).toHaveLength(2);
    expect(rows[1]).toMatchObject({
      credential: { sentinel: 'sentinel:$OLLAMA_API_KEY' },
      reason: 'model-request:ollama',
    });
  });
});

describe('kubic run: models.json key use is audited', () => {
  it('appends one ledger record per request; kubic audit shows it without the value; nothing persisted carries it', async () => {
    const provider = await fakeProvider();
    const workspace = tempDir('ws-credential-');
    const sessionsRoot = tempDir();
    writeModelsJson(workspace, provider.url);
    const debugLines: string[] = [];
    const run = async (): Promise<string> => {
      const result = await runHeadlessPrompt(
        'say hello',
        { debug: true },
        {
          sessionsRoot,
          ...hermetic(workspace),
          model: { provider: 'gw', id: 'm1' },
          debugSink: (line) => debugLines.push(line),
          // No line of this run carries the value (a plain guard); the test
          // 'a run-generated debug line that carries the key …' below is the
          // one that proves the channel is redacted.
          debug: (line) => debugLines.push(line),
        },
      );
      expect(result.terminus).toBe('completed');
      return result.sessionId;
    };
    const sessionId = await run();
    await run();
    // The key really went out on each request (the resolver fed Pi)...
    expect(provider.auths).toEqual([`Bearer ${SECRET}`, `Bearer ${SECRET}`]);
    // ...and each use is one audit record: sentinel ref, role, purpose.
    const ledger = readAuditLedger(auditLedgerDir(workspace));
    const uses = ledger.filter((record) => record.what === 'credential:gw');
    expect(uses).toHaveLength(2);
    expect(uses[0]).toMatchObject({
      who: 'agent:root',
      agent: { session: sessionId, role: 'root' },
      credential: { sentinel: 'sentinel:$GW_API_KEY' },
      permission: { permission: 'credential:use' },
      reason: 'model-request:gw',
      result: 'ok',
    });
    // `kubic audit` lists it, and the value is nowhere in its output.
    const lines: string[] = [];
    const code = (
      await runAuditCommand(
        { json: true },
        {
          loadRecords: () => readAuditLedger(auditLedgerDir(workspace)),
          loadSecrets: () => [],
          out: (line) => lines.push(line),
          err: (line) => lines.push(line),
        },
      )
    ).exitCode;
    expect(code).toBe(0);
    const output = lines.join('\n');
    expect(output).toContain('credential:gw');
    expect(output).not.toContain(SECRET);
    // No persisted file of the run — sessions root, ledger, journal — and no
    // debug line carries the resolved value.
    for (const file of [
      ...filesUnder(sessionsRoot),
      ...filesUnder(workspace),
    ]) {
      expect(readFileSync(file, 'utf8')).not.toContain(SECRET);
    }
    expect(debugLines.join('\n')).not.toContain(SECRET);
    // Hermetic: the run discovered no skills — in particular not the repo's
    // own project skills from process.cwd().
    expect(debugLines.filter((line) => line.includes('skills:'))).toEqual([]);
  });

  // End to end: a `!command` apiKey runs the production runner
  // per request — the command prints the key from the process env, so
  // models.json carries the ref but never the value — and the ledger
  // holds one value-less record for the use.
  it('a !command apiKey resolves through the runner; the ledger holds the ref, never the value', async () => {
    const provider = await fakeProvider();
    const workspace = tempDir('ws-credential-');
    const sessionsRoot = tempDir();
    vi.stubEnv('KUBIC_TEST_KEY_224', SECRET);
    const command = `!${process.execPath} -e console.log(process.env.KUBIC_TEST_KEY_224)`;
    writeFileSync(
      join(workspace, 'models.json'),
      JSON.stringify({
        providers: [
          {
            id: 'gw',
            baseUrl: provider.url,
            api: 'openai-completions',
            apiKey: command,
            models: [{ id: 'm1' }],
          },
        ],
      }),
    );
    const result = await runHeadlessPrompt(
      'say hello',
      { debug: true },
      {
        sessionsRoot,
        ...hermetic(workspace),
        model: { provider: 'gw', id: 'm1' },
      },
    );
    expect(result.terminus).toBe('completed');
    // The command's output really went out as the key...
    expect(provider.auths).toEqual([`Bearer ${SECRET}`]);
    // ...and the ledger holds one record naming the ref, not the value.
    const ledger = readAuditLedger(auditLedgerDir(workspace));
    const uses = ledger.filter((record) => record.what === 'credential:gw');
    expect(uses).toHaveLength(1);
    expect(uses[0]).toMatchObject({
      who: 'agent:root',
      credential: { sentinel: `sentinel:${command}` },
      permission: { permission: 'credential:use' },
      reason: 'model-request:gw',
      result: 'ok',
    });
    expect(JSON.stringify(uses)).not.toContain(SECRET);
    // models.json itself never carried the value — only the ref.
    expect(readFileSync(join(workspace, 'models.json'), 'utf8')).not.toContain(
      SECRET,
    );
  });

  it('a provider error that echoes the key never reaches the debug channel, the envelope or a persisted file', async () => {
    const provider = await fakeProvider({ rejectEchoingKey: true });
    const workspace = tempDir('ws-credential-echo-');
    const sessionsRoot = tempDir();
    writeModelsJson(workspace, provider.url);
    const debugLines: string[] = [];
    const result = await runHeadlessPrompt(
      'say hello',
      { debug: true },
      {
        sessionsRoot,
        ...hermetic(workspace),
        model: { provider: 'gw', id: 'm1' },
        debugSink: (line) => debugLines.push(line),
      },
    );
    // The key really went out and the provider really echoed it back.
    expect(provider.auths).toEqual([`Bearer ${SECRET}`]);
    expect(JSON.stringify(result)).not.toContain(SECRET);
    // (No line of this run echoes the provider's body; see the sweep test
    // below for the proof that the debug channel itself is redacted.)
    expect(debugLines.join('\n')).not.toContain(SECRET);
    for (const file of [
      ...filesUnder(sessionsRoot),
      ...filesUnder(workspace),
    ]) {
      expect(readFileSync(file, 'utf8')).not.toContain(SECRET);
    }
  });

  // The debug channel is redacted at ONE wrapper (redactingSink), and it only
  // matters for a line the run itself generates AFTER the key was used. This
  // makes one: the end-of-run sweep finds an out-of-band change, its journal
  // append fails (the journal dir was made read-only mid-run), and the failure
  // — `reconcile: sweep failed: EACCES … '<sessions root>/…'` — names a path
  // that spells the key (the sessions root's name), as the test's own way of
  // getting a key into a diagnostic. Without the wrapper the key would reach
  // stderr.
  it('a run-generated debug line that carries the key reaches the debug sink redacted', async () => {
    const workspace = tempDir('ws-credential-dbg-');
    const sessionsRoot = tempDir(`sessions-${SECRET}-`);
    const journalDirs = (): string[] =>
      readdirSync(sessionsRoot)
        .map((name) => join(sessionsRoot, name, 'journal'))
        .filter((dir) => {
          try {
            return statSync(dir).isDirectory();
          } catch {
            return false;
          }
        });
    const provider = await fakeProvider({
      onRequest: () => {
        // An out-of-band change the sweep must journal, and a journal it cannot.
        writeFileSync(join(workspace, 'made-out-of-band.txt'), 'x\n');
        for (const dir of journalDirs()) chmodSync(dir, 0o500);
      },
    });
    writeModelsJson(workspace, provider.url);
    const debugLines: string[] = [];
    try {
      const result = await runHeadlessPrompt(
        'say hello',
        { debug: true },
        {
          sessionsRoot,
          ...hermetic(workspace),
          model: { provider: 'gw', id: 'm1' },
          debugSink: (line) => debugLines.push(line),
        },
      );
      expect(result.terminus).toBe('completed');
    } finally {
      for (const dir of journalDirs()) chmodSync(dir, 0o700);
    }
    const sweepFailures = debugLines.filter((line) =>
      line.includes('reconcile: sweep failed'),
    );
    expect(sweepFailures).toHaveLength(1);
    expect(sweepFailures[0]).toContain('[REDACTED]');
    expect(debugLines.join('\n')).not.toContain(SECRET);
  });

  it('a completed run whose answer echoes the key persists it nowhere (session, trajectory, envelope)', async () => {
    const provider = await fakeProvider({ answerEchoingKey: true });
    const workspace = tempDir('ws-credential-answer-');
    const sessionsRoot = tempDir();
    writeModelsJson(workspace, provider.url);
    const result = await runHeadlessPrompt(
      'say hello',
      {},
      {
        sessionsRoot,
        ...hermetic(workspace),
        model: { provider: 'gw', id: 'm1' },
      },
    );
    expect(result.terminus).toBe('completed');
    expect(provider.auths).toEqual([`Bearer ${SECRET}`]);
    expect(result.summary).toContain('your key is Bearer [REDACTED]');
    expect(JSON.stringify(result)).not.toContain(SECRET);
    const trajectory = readFileSync(result.trajectoryRef ?? '', 'utf8');
    expect(trajectory).toContain('Bearer [REDACTED]');
    for (const file of [
      ...filesUnder(sessionsRoot),
      ...filesUnder(workspace),
    ]) {
      expect(readFileSync(file, 'utf8')).not.toContain(SECRET);
    }
  });

  // The user's own prompt is written to the session BEFORE the first request
  // resolves the key, so the session file can only be scrubbed of values the
  // run has already seen; the trajectory and the result are built after the
  // run and are scrubbed of every resolved value.
  it('a prompt that quotes the key is scrubbed from the trajectory and the result', async () => {
    const provider = await fakeProvider();
    const workspace = tempDir('ws-credential-prompt-');
    const sessionsRoot = tempDir();
    writeModelsJson(workspace, provider.url);
    const result = await runHeadlessPrompt(
      `use ${SECRET} please`,
      {},
      {
        sessionsRoot,
        ...hermetic(workspace),
        model: { provider: 'gw', id: 'm1' },
      },
    );
    expect(result.terminus).toBe('completed');
    expect(JSON.stringify(result)).not.toContain(SECRET);
    const trajectory = readFileSync(result.trajectoryRef ?? '', 'utf8');
    expect(trajectory).toContain('use [REDACTED] please');
    expect(trajectory).not.toContain(SECRET);
  });

  it('assembleModels without a resolver keeps the plain env auth (no audit)', async () => {
    const workspace = tempDir('ws-credential-');
    writeModelsJson(workspace, 'http://127.0.0.1:9/v1');
    // A trusted project file without a resolver: the plain
    // env-key auth stays in place and nothing is audited.
    const assembled = await assembleModels(
      workspace,
      {},
      {
        projectTrust: () => true,
      },
    );
    expect(assembled.models.getProvider('gw')).toBeDefined();
    expect(readAuditLedger(auditLedgerDir(workspace))).toEqual([]);
  });
});
