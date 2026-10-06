// Worker provider credentials on the prod path (issue #200; §36.3, §3.8,
// §58, §59). A worker child gets exactly its role's provider keys — delivered
// as its KUBIC_ROLE_<role>_* grant, never as ambient env — and reads them back
// as the provider's apiKey auth. The provider is a loopback HTTP server
// speaking the OpenAI streaming shape, owned and closed by the test: no
// external network, no paid tokens.
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
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NodeExecutionEnv } from '../../../packages/exec/src/env.js';
import { runHeadlessPrompt } from './headless-run.js';

const SECRET = 'sk-worker-200-do-not-leak';
const roots: string[] = [];
const servers: Server[] = [];

function tmpRoot(prefix = 'kubic-200-'): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

beforeEach(() => {
  vi.stubEnv('KUBIC_NO_NOTICE', '1');
  vi.stubEnv('KUBIC_PROVIDER', '');
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

// The role the worker runs as; `--role implementer` loads this document, so
// the child's own role name is what namespaces its grant read.
function writeRoleDoc(dir: string): void {
  const rolesDir = join(dir, '.kubic', 'roles');
  mkdirSync(rolesDir, { recursive: true });
  writeFileSync(
    join(rolesDir, 'implementer.md'),
    [
      '---',
      'role: implementer',
      'tools: [read, ls, find, grep, write, edit, bash]',
      'filesystem: workspace-write',
      'shell: true',
      'network: none',
      'git: false',
      'credentials: none',
      '---',
      '',
      '# implementer',
      '',
      '## Prompt',
      '',
      'You are the implementer.',
      '',
    ].join('\n'),
  );
}

function workspaceWith(baseUrl: string): string {
  const workspace = tmpRoot('ws-200-');
  writeModelsJson(workspace, baseUrl);
  writeRoleDoc(workspace);
  return workspace;
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

describe('worker child provider credentials (issue #200)', () => {
  it('authenticates from its KUBIC_ROLE_<role>_ grant, not ambient env', async () => {
    const provider = await fakeProvider();
    const workspace = workspaceWith(provider.url);
    const sessionsRoot = tmpRoot();
    // The child's whole env view: the base has NO GW_API_KEY — the only copy
    // rides under the role grant namespace, exactly as buildSpawnEnv mints it.
    vi.stubEnv('KUBIC_ROLE_IMPLEMENTER_GW_API_KEY', SECRET);
    expect(process.env.GW_API_KEY).toBeUndefined();
    const result = await runHeadlessPrompt(
      'say hello',
      { debug: false, role: 'implementer' },
      {
        sessionsRoot,
        modelsCwd: workspace,
        roles: { cwd: workspace },
        // Skills discovery defaults to process.cwd(); the run must read the
        // workspace only (a Stryker sandbox lives inside the real checkout).
        skills: { cwd: workspace, homeDir: workspace, trusted: false },
        model: { provider: 'gw', id: 'm1' },
        env: new NodeExecutionEnv(workspace),
      },
    );
    expect(result.terminus).toBe('completed');
    expect(provider.auths).toEqual([`Bearer ${SECRET}`]);
  });

  it('does not authenticate when the grant is for a sibling role only', async () => {
    const provider = await fakeProvider();
    const workspace = workspaceWith(provider.url);
    const sessionsRoot = tmpRoot();
    vi.stubEnv('KUBIC_ROLE_PLANNER_GW_API_KEY', SECRET);
    const result = await runHeadlessPrompt(
      'say hello',
      { debug: false, role: 'implementer' },
      {
        sessionsRoot,
        modelsCwd: workspace,
        roles: { cwd: workspace },
        // Skills discovery defaults to process.cwd(); the run must read the
        // workspace only (a Stryker sandbox lives inside the real checkout).
        skills: { cwd: workspace, homeDir: workspace, trusted: false },
        model: { provider: 'gw', id: 'm1' },
        env: new NodeExecutionEnv(workspace),
      },
    );
    expect(result.terminus).not.toBe('completed');
    expect(provider.auths).toEqual([]);
  });

  it('never writes the granted key into the child session or workspace', async () => {
    const provider = await fakeProvider();
    const workspace = workspaceWith(provider.url);
    const sessionsRoot = tmpRoot();
    vi.stubEnv('KUBIC_ROLE_IMPLEMENTER_GW_API_KEY', SECRET);
    const result = await runHeadlessPrompt(
      'say hello',
      { debug: false, role: 'implementer' },
      {
        sessionsRoot,
        modelsCwd: workspace,
        roles: { cwd: workspace },
        // Skills discovery defaults to process.cwd(); the run must read the
        // workspace only (a Stryker sandbox lives inside the real checkout).
        skills: { cwd: workspace, homeDir: workspace, trusted: false },
        model: { provider: 'gw', id: 'm1' },
        env: new NodeExecutionEnv(workspace),
      },
    );
    expect(result.terminus).toBe('completed');
    for (const file of filesUnder(sessionsRoot)) {
      expect(readFileSync(file, 'utf8')).not.toContain(SECRET);
    }
  });
});
