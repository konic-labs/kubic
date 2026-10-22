// The launcher's proxy relaunch (bin/env-proxy.mjs): when to relaunch, what
// the child gets, and — end to end, with a real Node child and a loopback
// proxy — that fetch then goes through the proxy and NO_PROXY is honoured.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  needsEnvProxyRelaunch,
  relaunchWithEnvProxy,
} from '../bin/env-proxy.mjs';

const MODULE = fileURLToPath(new URL('../bin/env-proxy.mjs', import.meta.url));
const SUPPORTED = new Set(['--use-env-proxy']);

describe('needsEnvProxyRelaunch', () => {
  it('relaunches only with a proxy variable, no opt-in yet and Node support', () => {
    const cases = [
      [{}, SUPPORTED, false],
      [{ HTTPS_PROXY: 'http://proxy:3128' }, SUPPORTED, true],
      [{ https_proxy: 'http://proxy:3128' }, SUPPORTED, true],
      [{ HTTP_PROXY: 'http://proxy:3128' }, SUPPORTED, true],
      [{ HTTPS_PROXY: '' }, SUPPORTED, false],
      [
        { HTTPS_PROXY: 'http://proxy:3128', NODE_USE_ENV_PROXY: '1' },
        SUPPORTED,
        false,
      ],
      [
        { HTTPS_PROXY: 'http://proxy:3128', NODE_USE_ENV_PROXY: '0' },
        SUPPORTED,
        false,
      ],
      [{ HTTPS_PROXY: 'http://proxy:3128' }, new Set(), false],
      [{ NO_PROXY: 'example.com' }, SUPPORTED, false],
    ];
    for (const [env, flags, expected] of cases) {
      assert.equal(
        needsEnvProxyRelaunch(env, flags),
        expected,
        JSON.stringify(env),
      );
    }
  });
});

describe('relaunchWithEnvProxy', () => {
  function fakeChild() {
    const child = new EventEmitter();
    child.killed = [];
    child.kill = (signal) => child.killed.push(signal);
    return child;
  }

  it('starts the same script with the opt-in and exits with its code', () => {
    const child = fakeChild();
    const calls = [];
    const exits = [];
    relaunchWithEnvProxy('/opt/kubic/bin/kubic.js', ['run', '-p', 'hi'], {
      spawn: (command, args, options) => {
        calls.push({ command, args, options });
        return child;
      },
      exit: (code) => exits.push(code),
      raise: () => assert.fail('no signal expected'),
    });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].command, process.execPath);
    assert.deepEqual(calls[0].args.slice(-4), [
      '/opt/kubic/bin/kubic.js',
      'run',
      '-p',
      'hi',
    ]);
    assert.ok(calls[0].args.includes('--disable-warning=UNDICI-EHPA'));
    assert.equal(calls[0].options.env.NODE_USE_ENV_PROXY, '1');
    assert.equal(calls[0].options.stdio, 'inherit');
    child.emit('exit', 3, null);
    assert.deepEqual(exits, [3]);
  });

  it('forwards SIGTERM to the child and ends with the signal that ended it', () => {
    const child = fakeChild();
    const raised = [];
    relaunchWithEnvProxy('/k.js', [], {
      spawn: () => child,
      exit: () => assert.fail('no exit code expected'),
      raise: (signal) => raised.push(signal),
    });
    process.emit('SIGTERM', 'SIGTERM');
    assert.deepEqual(child.killed, ['SIGTERM']);
    child.emit('exit', null, 'SIGTERM');
    assert.deepEqual(raised, ['SIGTERM']);
    // The listeners are gone once the child has exited.
    assert.equal(process.listenerCount('SIGTERM'), 0);
  });
});

describe('model traffic through a proxy, end to end', () => {
  const scratch = mkdtempSync(join(tmpdir(), 'env-proxy-'));
  after(() => rmSync(scratch, { recursive: true, force: true }));

  // A stand-in for the CLI: one fetch to a host that does not exist, then a
  // distinctive exit code so the pass-through is visible.
  const script = join(scratch, 'fetch-once.mjs');
  writeFileSync(
    script,
    "try { await fetch('https://api.example.invalid/v1/messages', { signal: AbortSignal.timeout(3000) }); } catch {} process.exit(7);\n",
  );
  // A stand-in for bin/kubic.js: relaunch the stand-in CLI, as a file script.
  const launcher = join(scratch, 'launcher.mjs');
  writeFileSync(
    launcher,
    `import { relaunchWithEnvProxy } from ${JSON.stringify(MODULE)};\nrelaunchWithEnvProxy(${JSON.stringify(script)}, []);\n`,
  );

  async function throughLauncher(env) {
    const connects = [];
    const proxy = createServer((_request, response) => {
      response.writeHead(502).end();
    });
    proxy.on('connect', (request, socket) => {
      connects.push(request.url);
      socket.end('HTTP/1.1 502 Bad Gateway\r\n\r\n');
    });
    await new Promise((resolve) => proxy.listen(0, '127.0.0.1', resolve));
    const proxyUrl = `http://127.0.0.1:${proxy.address().port}`;
    const code = await new Promise((resolve) => {
      const child = spawn(process.execPath, [launcher], {
        env: { PATH: process.env.PATH ?? '', HTTPS_PROXY: proxyUrl, ...env },
        stdio: 'ignore',
      });
      child.on('exit', (exitCode) => resolve(exitCode));
    });
    await new Promise((resolve) => proxy.close(resolve));
    return { code, connects };
  }

  it('sends the request to the proxy and passes the exit code through', async (t) => {
    if (!process.allowedNodeEnvironmentFlags.has('--use-env-proxy')) {
      t.skip('this Node has no --use-env-proxy');
      return;
    }
    const { code, connects } = await throughLauncher({});
    assert.equal(code, 7);
    assert.deepEqual(connects, ['api.example.invalid:443']);
  });

  it('goes direct for a NO_PROXY host', async (t) => {
    if (!process.allowedNodeEnvironmentFlags.has('--use-env-proxy')) {
      t.skip('this Node has no --use-env-proxy');
      return;
    }
    const { code, connects } = await throughLauncher({
      NO_PROXY: 'api.example.invalid',
    });
    assert.equal(code, 7);
    assert.deepEqual(connects, []);
  });
});
