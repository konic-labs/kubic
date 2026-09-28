// Request-time credential use, audited (issue #359; §36.1 rules 3-4, §60).
// A models.json provider key (`apiKeyEnv`, a `$ENV` ref) is resolved through
// resolveSecretRef on EVERY request, each use appends one §60 ledger record
// (ref sentinel, role, purpose — never the value), and the value never lands
// in a persisted file of the run or on the debug channel.
//
// The "provider" is a loopback HTTP server speaking the OpenAI streaming
// shape, owned and closed by the test: no external network, no paid tokens.
import {
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
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runHeadlessPrompt } from '../../../apps/kubic/src/headless-run.js';
import { NodeExecutionEnv } from '../../exec/src/env.js';
import { createModelKeyResolver } from './config/secrets.js';
import { assembleModels } from './models-cli.js';
import { runAuditCommand } from './policy/audit-cli.js';
import { auditLedgerDir, readAuditLedger } from './policy/audit-ledger.js';

const SECRET = 'sk-live-kubic-359-do-not-leak';
const roots: string[] = [];
const servers: Server[] = [];

function tmpRoot(prefix = 'kubic-359-'): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

beforeEach(() => {
  vi.stubEnv('KUBIC_NO_NOTICE', '1');
  vi.stubEnv('KUBIC_PROVIDER', '');
  vi.stubEnv('GW_API_KEY', SECRET);
  // The project models.json is trust-gated (issue #322; §35.1); this suite
  // covers a trusted file's key use, not the trust decision itself.
  vi.stubEnv('KUBIC_TRUST_PROJECT', '1');
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
async function fakeProvider(): Promise<{ url: string; auths: string[] }> {
  const auths: string[] = [];
  const server = createServer((req, res) => {
    auths.push(String(req.headers.authorization ?? ''));
    req.resume();
    req.on('end', () => {
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
            delta: { role: 'assistant', content: 'hello' },
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

function writeModelsJson(dir: string, baseUrl: string): void {
  writeFileSync(
    join(dir, 'models.json'),
    JSON.stringify({
      providers: [
        {
          id: 'gw',
          baseUrl,
          api: 'openai-completions',
          apiKeyEnv: 'GW_API_KEY',
          models: [{ id: 'm1' }],
        },
      ],
    }),
  );
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

describe('createModelKeyResolver (issue #359)', () => {
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

describe('kubic run: models.json key use is audited (issue #359)', () => {
  it('appends one ledger record per request; kubic audit shows it without the value; nothing persisted carries it', async () => {
    const provider = await fakeProvider();
    const workspace = tmpRoot('ws-359-');
    const sessionsRoot = tmpRoot();
    writeModelsJson(workspace, provider.url);
    const debugLines: string[] = [];
    const run = async (): Promise<string> => {
      const result = await runHeadlessPrompt(
        'say hello',
        { debug: true },
        {
          sessionsRoot,
          modelsCwd: workspace,
          model: { provider: 'gw', id: 'm1' },
          env: new NodeExecutionEnv(workspace),
          debugSink: (line) => debugLines.push(line),
          // The value must not reach the debug channel even when a line
          // carries it (a provider echo, a stray log).
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
    // ...and each use is one §60 record: sentinel ref, role, purpose.
    const ledger = readAuditLedger(auditLedgerDir(workspace));
    const uses = ledger.filter((record) => record.what === 'credential:gw');
    expect(uses).toHaveLength(2);
    expect(uses[0]).toMatchObject({
      who: 'agent:root',
      mode: 'solo',
      agent: { session: sessionId, role: 'root' },
      credential: { sentinel: 'sentinel:$GW_API_KEY' },
      permission: { permission: 'credential:use' },
      reason: 'model-request:gw',
      result: 'ok',
    });
    // `kubic audit` lists it, and the value is nowhere in its output.
    const lines: string[] = [];
    const code = await runAuditCommand(
      { json: true },
      {
        loadRecords: () => readAuditLedger(auditLedgerDir(workspace)),
        loadSecrets: () => [],
        out: (line) => lines.push(line),
        err: (line) => lines.push(line),
      },
    );
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
  });

  it('assembleModels without a resolver keeps the plain env auth (no audit)', async () => {
    const workspace = tmpRoot('ws-359-');
    writeModelsJson(workspace, 'http://127.0.0.1:9/v1');
    // A trusted project file (issue #322) without a resolver: the plain
    // env-key auth stays in place and nothing is audited.
    const assembled = await assembleModels(workspace, {}, {
      projectTrusted: true,
    });
    expect(assembled.models.getProvider('gw')).toBeDefined();
    expect(readAuditLedger(auditLedgerDir(workspace))).toEqual([]);
  });
});
