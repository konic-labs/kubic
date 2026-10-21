import { generateKeyPairSync } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { createNodeFileBridge } from '@kubic/exec/file-bridge';
import { afterEach, describe, expect, it } from 'vitest';
import { tempDir } from '../../../../test/temp-dir.js';
import { ConfigError } from './errors.js';
import {
  managedConfigDirs,
  managedFilePath,
  pullManagedPolicy,
  refreshManagedPolicy,
  signManagedText,
} from './managed.js';
import { loadRuntimeConfig } from './runtime.js';

const BRIDGE = createNodeFileBridge('/');

function keys(type: 'ed25519' | 'rsa' = 'ed25519') {
  const pair =
    type === 'ed25519'
      ? generateKeyPairSync('ed25519')
      : generateKeyPairSync('rsa', { modulusLength: 1024 });
  return {
    publicPem: pair.publicKey
      .export({ type: 'spki', format: 'pem' })
      .toString(),
    privatePem: pair.privateKey
      .export({ type: 'pkcs8', format: 'pem' })
      .toString(),
  };
}

// A managed directory with a config, optionally signed with `privatePem`.
function managedDir(
  config: string,
  options: { publicPem?: string; privatePem?: string } = {},
): string {
  const dir = tempDir('managed-dir-');
  writeFileSync(join(dir, 'config.toml'), config);
  if (options.publicPem !== undefined) {
    writeFileSync(join(dir, 'policy.pub'), options.publicPem);
  }
  if (options.privatePem !== undefined) {
    writeFileSync(
      join(dir, 'config.toml.sig'),
      `${signManagedText(options.privatePem, config)}\n`,
    );
  }
  return dir;
}

function load(dir: string, home = tempDir('managed-home-')) {
  const cwd = tempDir('managed-cwd-');
  return loadRuntimeConfig({
    bridge: BRIDGE,
    home,
    cwd,
    projectRoot: cwd,
    managedDirs: [dir],
  });
}

function refusal(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(ConfigError);
    return (error as Error).message;
  }
  throw new Error('not refused');
}

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(
    servers
      .splice(0)
      .map((server) => new Promise<void>((done) => server.close(() => done()))),
  );
});

// A loopback policy server: path → body, with a request count.
async function policyServer(
  files: Record<string, string>,
): Promise<{ url: string; requests: string[] }> {
  const requests: string[] = [];
  const server = createServer((request, response) => {
    requests.push(request.url ?? '');
    const body = files[request.url ?? ''];
    if (body === undefined) {
      response.writeHead(404).end();
      return;
    }
    response.writeHead(200, { 'content-type': 'text/plain' }).end(body);
  });
  servers.push(server);
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const { port } = server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${port}`, requests };
}

describe('managed config paths', () => {
  it('searches the platform managed directory before /etc/kubic', () => {
    expect(managedConfigDirs('darwin')).toEqual([
      '/Library/Application Support/Kubic',
      '/etc/kubic',
    ]);
    expect(managedConfigDirs('linux')).toEqual(['/etc/kubic']);
    expect(managedConfigDirs('win32', { ProgramData: 'D:\\Data' })).toEqual([
      'D:\\Data\\Kubic',
    ]);
  });

  it('takes each file from the first directory holding it', () => {
    const first = tempDir('managed-first-');
    const second = tempDir('managed-second-');
    writeFileSync(join(second, 'config.toml'), '');
    writeFileSync(join(first, 'product.toml'), '');
    expect(managedFilePath(BRIDGE, 'config.toml', [first, second])).toBe(
      join(second, 'config.toml'),
    );
    expect(managedFilePath(BRIDGE, 'product.toml', [first, second])).toBe(
      join(first, 'product.toml'),
    );
    expect(managedFilePath(BRIDGE, 'other.toml', [first, second])).toBe(
      join(second, 'other.toml'),
    );
  });
});

describe('signed managed config', () => {
  const config = '[policy]\nallowed_providers = ["local"]\n';

  it('applies a config whose signature verifies with policy.pub', () => {
    const pair = keys();
    const dir = managedDir(config, pair);
    const runtime = load(dir);
    expect(runtime.config.policy?.allowedProviders).toEqual(['local']);
    expect(runtime.managed).toEqual({
      configPath: join(dir, 'config.toml'),
      signed: true,
    });
  });

  it('refuses an unsigned config and a tampered one by name', () => {
    const pair = keys();
    const unsigned = managedDir(config, { publicPem: pair.publicPem });
    expect(refusal(() => load(unsigned))).toBe(
      `managed config ${join(unsigned, 'config.toml')} is not signed: ${join(unsigned, 'config.toml')}.sig is missing, and ${join(unsigned, 'policy.pub')} requires a signature`,
    );
    const tampered = managedDir(config, pair);
    writeFileSync(
      join(tampered, 'config.toml'),
      `${config}allowed_tools = ["bash"]\n`,
    );
    expect(refusal(() => load(tampered))).toContain(
      `managed config ${join(tampered, 'config.toml')} does not match its signature`,
    );
    // A signature from another key does not verify either.
    const other = managedDir(config, {
      publicPem: pair.publicPem,
      privatePem: keys().privatePem,
    });
    expect(refusal(() => load(other))).toContain(
      'does not match its signature',
    );
  });

  it('refuses a policy.pub that is not an Ed25519 key', () => {
    const rsa = keys('rsa');
    const dir = managedDir(config, { publicPem: rsa.publicPem });
    writeFileSync(join(dir, 'config.toml.sig'), 'AAAA\n');
    expect(refusal(() => load(dir))).toContain(
      'is a rsa key — a managed policy is signed with Ed25519',
    );
    expect(() => signManagedText(rsa.privatePem, config)).toThrow(
      'a rsa key cannot sign a managed policy',
    );
  });

  it('loads an unsigned config when no policy.pub asks for a signature', () => {
    const dir = managedDir(config);
    expect(load(dir).managed).toEqual({
      configPath: join(dir, 'config.toml'),
      signed: false,
    });
  });

  it('refuses [managed] outside the managed config', () => {
    const home = tempDir('managed-home-');
    mkdirSync(join(home, '.kubic'));
    writeFileSync(
      join(home, '.kubic', 'config.toml'),
      '[managed]\nurl = "https://policy.example.com/kubic.toml"\n',
    );
    expect(refusal(() => load(tempDir('managed-none-'), home))).toContain(
      "'[managed]' is read only from the managed config; the global layer",
    );
  });
});

describe('remote managed policy', () => {
  const remotePolicy = '[policy]\ndenied_tools = ["bash"]\n';

  async function setup(served: { policy?: string; signature?: string } = {}) {
    const pair = keys();
    const policy = served.policy ?? remotePolicy;
    const server = await policyServer({
      '/kubic.toml': policy,
      '/kubic.toml.sig':
        served.signature ?? signManagedText(pair.privatePem, policy),
    });
    const url = `${server.url}/kubic.toml`;
    const local = `[managed]\nurl = "${url}"\nrefreshHours = 1\n[model]\nprovider = "local"\nid = "small"\n`;
    const dir = managedDir(local, pair);
    return { pair, dir, url, server, home: tempDir('managed-home-') };
  }

  it('pulls, verifies and caches the remote policy, then merges it above the local file', async () => {
    const { dir, url, home } = await setup();
    // Nothing fetched yet: the load waits for a pull, by name.
    expect(refusal(() => load(dir, home))).toBe(
      `the managed policy from ${url} has not been fetched yet — run 'kubic policy pull' while the policy server is reachable`,
    );
    const pulled = await pullManagedPolicy({
      home,
      remote: { url },
      keyPath: join(dir, 'policy.pub'),
      now: () => Date.UTC(2026, 9, 21),
    });
    expect(pulled).toEqual({ url, fetchedAt: '2026-10-21T00:00:00.000Z' });
    const runtime = load(dir, home);
    expect(runtime.policy.tools.deny).toEqual(['bash']);
    expect(runtime.policy.tools.denySources).toEqual({ bash: 'enterprise' });
    expect(runtime.config.model?.provider).toBe('local');
    expect(runtime.managed?.remote).toEqual({
      url,
      fetchedAt: '2026-10-21T00:00:00.000Z',
      cachePath: join(home, '.kubic', 'managed', 'policy.toml'),
    });
  });

  it('never caches a remote policy whose signature does not verify', async () => {
    const { dir, url, home } = await setup({
      signature: 'bm90IGEgc2lnbmF0dXJl',
    });
    await expect(
      pullManagedPolicy({
        home,
        remote: { url },
        keyPath: join(dir, 'policy.pub'),
      }),
    ).rejects.toThrow('does not match its signature');
    expect(refusal(() => load(dir, home))).toContain(
      'has not been fetched yet',
    );
  });

  it('refuses an edited cache on the next load', async () => {
    const { dir, url, home } = await setup();
    await pullManagedPolicy({
      home,
      remote: { url },
      keyPath: join(dir, 'policy.pub'),
    });
    const cached = join(home, '.kubic', 'managed', 'policy.toml');
    writeFileSync(
      cached,
      readFileSync(cached, 'utf8').replace('bash', 'nothing'),
    );
    expect(refusal(() => load(dir, home))).toContain(
      `managed config ${cached} does not match its signature`,
    );
  });

  it('refreshes only a stale cache, and keeps the last copy when the server is down', async () => {
    const { dir, home, server } = await setup();
    const now = Date.UTC(2026, 9, 21, 12);
    expect(
      await refreshManagedPolicy({ home, dirs: [dir], now: () => now }),
    ).toEqual([]);
    expect(server.requests).toEqual(['/kubic.toml', '/kubic.toml.sig']);
    // Fresh within refreshHours: no request.
    await refreshManagedPolicy({ home, dirs: [dir], now: () => now + 60_000 });
    expect(server.requests).toHaveLength(2);
    // Stale, and the server is gone: one warning, the cache stays in force.
    await new Promise<void>((done) =>
      servers.splice(0)[0]?.close(() => done()),
    );
    const warnings = await refreshManagedPolicy({
      home,
      dirs: [dir],
      now: () => now + 2 * 3_600_000,
    });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('the last verified copy stays in force');
    expect(load(dir, home).policy.tools.deny).toEqual(['bash']);
  });

  it('needs a policy.pub and an https url', async () => {
    const dir = managedDir(
      '[managed]\nurl = "https://policy.example.com/kubic.toml"\n',
    );
    expect(refusal(() => load(dir))).toContain(
      'needs a policy.pub beside the managed config',
    );
    const pair = keys();
    const plain = managedDir(
      '[managed]\nurl = "http://policy.example.com/kubic.toml"\n',
      pair,
    );
    expect(refusal(() => load(plain))).toContain(
      "'managed': 'url' must use https (plain http only to this machine)",
    );
  });
});
