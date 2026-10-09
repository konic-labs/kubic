// Request-time credential use, audited.
// A models.json provider key (`apiKeyEnv`, a `$ENV` ref) is resolved through
// resolveSecretRef on EVERY request, each use appends one ledger record
// (ref sentinel, role, purpose — never the value), and the value never lands
// in a persisted file of the run or on the debug channel.
//
// The "provider" is a loopback HTTP server speaking the OpenAI streaming
// shape, owned and closed by the test: no external network, no paid tokens.
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NodeExecutionEnv } from '@kubic/exec/env';
import {
  auditLedgerDir,
  createLedgerModelKeyResolver,
  readAuditLedger,
} from '@kubic/host/audit';
import {
  createModelKeyResolver,
  parseSecretRef,
} from '@kubic/host/secret-refs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runHeadlessPrompt } from '../../src/run/command.js';

const SECRET = 'sk-live-kubic-do-not-leak';

const roots: string[] = [];

const servers: Server[] = [];

function tmpRoot(prefix = 'kubic-credential-audit-'): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

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
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
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

describe('createModelKeyResolver', () => {
  it('resolves through resolveSecretRef with exactly one audit event per use, never the value', async () => {
    const events: unknown[] = [];
    const resolver = createModelKeyResolver({
      role: 'root',
      audit: (event) => events.push(event),
      now: () => 0,
    });
    const use = {
      provider: 'gw',
      envVar: 'GW_API_KEY',
      readEnv: async () => SECRET,
    };
    expect(await resolver.resolve(use)).toBe(SECRET);
    expect(await resolver.resolve(use)).toBe(SECRET);
    expect(events).toEqual([
      {
        ref: '$GW_API_KEY',
        role: 'root',
        purpose: 'model-request:gw',
        provider: 'gw',
        at: '1970-01-01T00:00:00.000Z',
      },
      {
        ref: '$GW_API_KEY',
        role: 'root',
        purpose: 'model-request:gw',
        provider: 'gw',
        at: '1970-01-01T00:00:00.000Z',
      },
    ]);
    expect(JSON.stringify(events)).not.toContain(SECRET);
    expect(resolver.live()).toEqual([SECRET]);
  });

  it('an unset key is not a use: no event, no value', async () => {
    const events: unknown[] = [];
    const resolver = createModelKeyResolver({
      role: 'root',
      audit: (event) => events.push(event),
    });
    expect(
      await resolver.resolve({
        provider: 'gw',
        envVar: 'GW_API_KEY',
        readEnv: async () => '',
      }),
    ).toBeUndefined();
    expect(events).toEqual([]);
  });
});

// The resolver serves parsed secret refs — an explicit
// `$VAR` fails closed naming the variable, a `!command` runs the injected
// runner on every resolve (rerun per request, never cached), one audit
// record per use carrying the ref but never the value.
describe('createModelKeyResolver ref uses', () => {
  it('resolves an env ref with one audit event per use, never the value', async () => {
    const events: unknown[] = [];
    const resolver = createModelKeyResolver({
      role: 'root',
      audit: (event) => events.push(event),
      now: () => 0,
    });
    const use = {
      provider: 'gw',
      ref: parseSecretRef('$GW_API_KEY'),
      readEnv: async () => SECRET,
    };
    expect(await resolver.resolve(use)).toBe(SECRET);
    expect(await resolver.resolve(use)).toBe(SECRET);
    expect(events).toEqual([
      {
        ref: '$GW_API_KEY',
        role: 'root',
        purpose: 'model-request:gw',
        provider: 'gw',
        at: '1970-01-01T00:00:00.000Z',
      },
      {
        ref: '$GW_API_KEY',
        role: 'root',
        purpose: 'model-request:gw',
        provider: 'gw',
        at: '1970-01-01T00:00:00.000Z',
      },
    ]);
    expect(JSON.stringify(events)).not.toContain(SECRET);
    expect(resolver.live()).toEqual([SECRET]);
  });

  it('a missing env ref fails closed naming the variable: no event, no value', async () => {
    const events: unknown[] = [];
    const resolver = createModelKeyResolver({
      role: 'root',
      audit: (event) => events.push(event),
    });
    await expect(
      resolver.resolve({
        provider: 'gw',
        ref: parseSecretRef('$GW_API_KEY'),
        readEnv: async () => '',
      }),
    ).rejects.toThrow(/missing env secret: GW_API_KEY/);
    expect(events).toEqual([]);
    expect(resolver.live()).toEqual([]);
  });

  it('runs the command on every resolve and audits the command ref, never the value', async () => {
    const events: unknown[] = [];
    const runs: string[][] = [];
    const resolver = createModelKeyResolver({
      role: 'root',
      audit: (event) => events.push(event),
      now: () => 0,
      runCommand: (argv) => {
        runs.push([...argv]);
        return 'command-key-value';
      },
    });
    const use = {
      provider: 'gw',
      ref: parseSecretRef('!echo hi-cmd'),
      readEnv: async () => undefined,
    };
    expect(await resolver.resolve(use)).toBe('command-key-value');
    expect(await resolver.resolve(use)).toBe('command-key-value');
    expect(runs).toEqual([
      ['echo', 'hi-cmd'],
      ['echo', 'hi-cmd'],
    ]);
    // The audited ref is the ref as written (like `$VAR`), never the value.
    expect(events).toEqual([
      {
        ref: '!echo hi-cmd',
        role: 'root',
        purpose: 'model-request:gw',
        provider: 'gw',
        at: '1970-01-01T00:00:00.000Z',
      },
      {
        ref: '!echo hi-cmd',
        role: 'root',
        purpose: 'model-request:gw',
        provider: 'gw',
        at: '1970-01-01T00:00:00.000Z',
      },
    ]);
    expect(JSON.stringify(events)).not.toContain('command-key-value');
    expect(resolver.live()).toEqual(['command-key-value']);
  });

  it('a command ref without a runner fails closed naming the provider', async () => {
    const resolver = createModelKeyResolver({
      role: 'root',
      audit: () => {},
    });
    await expect(
      resolver.resolve({
        provider: 'gw',
        ref: parseSecretRef('!echo hi-cmd'),
        readEnv: async () => undefined,
      }),
    ).rejects.toThrow(/provider 'gw': no secret-command runner/);
  });

  it('an empty command output fails closed naming the provider and command', async () => {
    const resolver = createModelKeyResolver({
      role: 'root',
      audit: () => {},
      runCommand: () => '',
    });
    await expect(
      resolver.resolve({
        provider: 'gw',
        ref: parseSecretRef('!echo hi-cmd'),
        readEnv: async () => undefined,
      }),
    ).rejects.toThrow(/provider 'gw': empty output from secret command/);
  });

  it('a literal ref is a programmer error, never a use', async () => {
    const events: unknown[] = [];
    const resolver = createModelKeyResolver({
      role: 'root',
      audit: (event) => events.push(event),
    });
    await expect(
      resolver.resolve({
        provider: 'gw',
        ref: parseSecretRef('not-needed'),
        readEnv: async () => undefined,
      }),
    ).rejects.toThrow(/env or command ref/);
    expect(events).toEqual([]);
  });
});

describe('a first-use audit failure never carries the value', () => {
  it('the resolved value is registered as live BEFORE its audit event fires', async () => {
    const seenAtAudit: string[][] = [];
    const resolver = createModelKeyResolver({
      role: 'root',
      audit: () => {
        seenAtAudit.push(resolver.live());
      },
    });
    await resolver.resolve({
      provider: 'gw',
      envVar: 'GW_API_KEY',
      readEnv: async () => SECRET,
    });
    expect(seenAtAudit).toEqual([[SECRET]]);
  });

  it('a ledger write that fails on the very first use reports a redacted message', async () => {
    // A value with no secret SHAPE (so only the live inventory can redact it).
    // The ledger resolves to the MAIN checkout of a linked worktree, whose
    // path spells the value, and that checkout's `.kubic` is a FILE: the
    // ledger's createDir fails with an error naming the path — the value in
    // an error message on the first use, before a second use could have
    // taught the inventory about it. (The record itself carries the worktree
    // path, so it is not refused for material: the append really fails.)
    const value = 'zqxjvw-firstuse-value';
    const main = tmpRoot(`main-${value}-`);
    mkdirSync(join(main, '.git', 'worktrees', 'wt'), { recursive: true });
    writeFileSync(join(main, '.git', 'worktrees', 'wt', 'commondir'), '../..');
    writeFileSync(join(main, '.kubic'), 'not a directory');
    const worktree = tmpRoot('wt-credential-');
    writeFileSync(
      join(worktree, '.git'),
      `gitdir: ${join(main, '.git', 'worktrees', 'wt')}\n`,
    );
    const errors: string[] = [];
    const resolver = createLedgerModelKeyResolver({
      // Env-only tests: the runner must never fire for $VAR uses.
      runCommand: () => {
        throw new Error('no commands in this test');
      },
      workspace: worktree,
      role: 'root',
      sessionId: () => 'sess-credential',
      onError: (message) => errors.push(message),
    });
    expect(
      await resolver.resolve({
        provider: 'gw',
        envVar: 'GW_API_KEY',
        readEnv: async () => value,
      }),
    ).toBe(value);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('audit sink failure');
    expect(errors[0]).not.toContain(value);
    expect(errors[0]).toContain('[redacted-secret]');
  });

  it('a record that would carry the value is refused on the first use, not written', async () => {
    const value = 'zqxjvw-firstuse-value';
    const workspace = tmpRoot(`ws-${value}-`);
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
    await resolver.resolve({
      provider: 'gw',
      envVar: 'GW_API_KEY',
      readEnv: async () => value,
    });
    expect(errors).toEqual([
      'audit record carries secret material: refused (sentinel only)',
    ]);
    expect(readAuditLedger(auditLedgerDir(workspace))).toEqual([]);
  });
});

// LM Studio's documented dummy key IS its provider name (`lm-studio`, 9
// characters — past the short-key minimum). It is not a secret: scrubbing it
// rewrote the provider in the envelope (`[REDACTED]/m1`) and in every session
// row, and the ledger refused every `credential:lm-studio` row (the record
// carries the provider name). A value that is (or sits inside) the run's
// provider/model ids is identity, never a secret.
describe('a dummy key equal to its provider id', () => {
  const KEY = 'lm-studio';

  it('a key matching its provider id does not blank identity, and its use is still audited', async () => {
    vi.stubEnv('LM_STUDIO_API_KEY', KEY);
    const provider = await fakeProvider();
    const workspace = tmpRoot('ws-credential-lms-');
    const sessionsRoot = tmpRoot();
    writeModelsJson(workspace, provider.url, {
      id: 'lm-studio',
      apiKeyEnv: 'LM_STUDIO_API_KEY',
    });
    const errors: string[] = [];
    const result = await runHeadlessPrompt(
      'say hello',
      { debug: true },
      {
        sessionsRoot,
        ...hermetic(workspace),
        model: { provider: 'lm-studio', id: 'm1' },
        debugSink: (line) => errors.push(line),
      },
    );
    expect(result.terminus).toBe('completed');
    expect(provider.auths).toEqual([`Bearer ${KEY}`]);
    // The envelope names the model, not `[REDACTED]/m1`.
    expect(result.model).toBe('lm-studio/m1');
    expect(JSON.stringify(result)).not.toContain('[REDACTED]');
    // Session rows keep their provider (assistant entries, usage/cost rows).
    const sessionText = filesUnder(sessionsRoot)
      .filter((file) => file.endsWith('.jsonl') && !file.includes('spans'))
      .map((file) => readFileSync(file, 'utf8'))
      .join('\n');
    expect(sessionText).toContain('"provider":"lm-studio"');
    expect(sessionText).not.toContain('[REDACTED]');
    const trajectory = readFileSync(result.trajectoryRef ?? '', 'utf8');
    expect(trajectory).not.toContain('[REDACTED]');
    // The credential-use row is written: it names only the ref (sentinel).
    const rows = readAuditLedger(auditLedgerDir(workspace)).filter(
      (record) => record.what === 'credential:lm-studio',
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      credential: { sentinel: 'sentinel:$LM_STUDIO_API_KEY' },
      reason: 'model-request:lm-studio',
    });
    expect(errors.filter((line) => line.includes('not audited'))).toEqual([]);
  });

  // `kubic tui` resolves keys without a catalog identity: the row's own
  // provider is still exempt, on the first use and every later one.
  it('the ledger resolver writes a row for every use even with no catalog identity', async () => {
    const workspace = tmpRoot('ws-credential-lms-ledger-');
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
      provider: 'lm-studio',
      envVar: 'LM_STUDIO_API_KEY',
      readEnv: async () => KEY,
    };
    await resolver.resolve(use);
    await resolver.resolve(use);
    expect(errors).toEqual([]);
    expect(
      readAuditLedger(auditLedgerDir(workspace)).filter(
        (record) => record.what === 'credential:lm-studio',
      ),
    ).toHaveLength(2);
  });

  it('the resolver reports a key that is a provider id as identity, not as a live secret', async () => {
    const resolver = createModelKeyResolver({
      role: 'root',
      audit: () => undefined,
      identity: () => ['lm-studio', 'm1'],
    });
    await resolver.resolve({
      provider: 'lm-studio',
      envVar: 'LM_STUDIO_API_KEY',
      readEnv: async () => KEY,
    });
    await resolver.resolve({
      provider: 'gw',
      envVar: 'GW_API_KEY',
      readEnv: async () => SECRET,
    });
    expect(resolver.live()).toEqual([SECRET]);
  });
});
