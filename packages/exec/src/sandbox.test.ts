// The bash sandbox: the Seatbelt profile and the bubblewrap arguments a
// policy builds, and — on macOS — commands really confined: a write outside
// the workspace, a network connection and a credential read refused, and an
// approved call given exactly its extra access.

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { createServer, type Server } from 'node:net';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { tempDir } from '../../../test/temp-dir.js';
import { NodeShell } from './env/node-shell.js';
import {
  BashSandbox,
  bubblewrapArgs,
  detectSandbox,
  type SandboxGrants,
  type SandboxPolicy,
  seatbeltProfile,
} from './sandbox.js';

let server: Server | undefined;

afterEach(async () => {
  await new Promise<void>((resolve) => {
    if (server === undefined) resolve();
    else server.close(() => resolve());
  });
  server = undefined;
});

const POLICY: SandboxPolicy = {
  workspace: '/work/repo',
  writable: ['/home/u/.npm'],
  writeAnywhere: false,
  network: false,
  hidden: ['/home/u/.ssh', '/home/u/.aws'],
  temporary: ['/tmp'],
};

describe('seatbeltProfile', () => {
  it('confines writes, hides the credential paths and closes the network', () => {
    const profile = seatbeltProfile(POLICY);
    expect(profile).toContain('(deny default)');
    // `/tmp` is its real path (`/private/tmp` on macOS).
    expect(profile).toMatch(
      /\(allow file-write\* \(subpath "\/work\/repo"\) \(subpath "(\/private)?\/tmp"\) \(subpath "\/home\/u\/\.npm"\)/,
    );
    expect(profile).toContain(
      '(require-not (require-any (subpath "/home/u/.ssh") (subpath "/home/u/.aws")))',
    );
    expect(profile).not.toContain('network');
  });

  it('opens what a grant or a class opens', () => {
    const granted = seatbeltProfile(POLICY, {
      network: true,
      credentials: true,
    });
    expect(granted).toContain('(allow network*)');
    expect(granted).toContain('(allow file-read*)\n');
    expect(seatbeltProfile({ ...POLICY, writeAnywhere: true })).toContain(
      '(allow file-write*)\n',
    );
  });
});

describe('bubblewrapArgs', () => {
  it('binds the root read-only, the workspace writable, and drops the network', () => {
    const args = bubblewrapArgs(
      { ...POLICY, workspace: tempDir('sandbox-bwrap-ws-'), temporary: [] },
      {},
      'bash',
      ['-c', 'true'],
    );
    expect(args.slice(0, 6)).toEqual([
      '--die-with-parent',
      '--new-session',
      '--ro-bind',
      '/',
      '/',
      '--dev',
    ]);
    expect(args).toContain('--unshare-net');
    expect(args.slice(-3)).toEqual(['bash', '-c', 'true']);
    expect(bubblewrapArgs(POLICY, { network: true }, 'bash', [])).not.toContain(
      '--unshare-net',
    );
  });
});

// Runs `command` through the sandbox the way the bash tool does.
async function sandboxed(
  policy: SandboxPolicy,
  command: string,
  grants: SandboxGrants = {},
): Promise<{ exitCode: number | null; stdout: string; stderr: string }> {
  const found = detectSandbox();
  if (found === undefined) throw new Error('no sandbox');
  const shell = new NodeShell(policy.workspace, {
    sandbox: new BashSandbox({
      kind: found.kind,
      binary: found.binary,
      policy: () => policy,
      grants: () => grants,
    }),
  });
  const result = await shell
    .spawn('/bin/bash', ['-c', command], {
      provenance: {
        sessionId: 's',
        agentId: 'root',
        toolCallId: 'call-1',
        turnId: 1,
        operation: 'bash',
      },
    })
    .wait();
  return {
    exitCode: result.exitCode,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

describe.skipIf(detectSandbox()?.kind !== 'seatbelt')(
  'Seatbelt, for real',
  () => {
    function policyFor(): {
      policy: SandboxPolicy;
      outside: string;
      secret: string;
    } {
      const workspace = tempDir('sandbox-ws-');
      const outside = tempDir('sandbox-outside-');
      const home = tempDir('sandbox-home-');
      mkdirSync(join(home, '.ssh'));
      const secret = join(home, '.ssh', 'id_test');
      writeFileSync(secret, 'secret-key\n');
      return {
        policy: {
          workspace,
          writable: [],
          writeAnywhere: false,
          network: false,
          hidden: [join(home, '.ssh')],
          temporary: [],
        },
        outside,
        secret,
      };
    }

    it('writes in the workspace and nowhere else', async () => {
      const { policy, outside } = policyFor();
      const inside = await sandboxed(policy, 'echo hi > inside.txt');
      expect(inside.exitCode).toBe(0);
      expect(existsSync(join(policy.workspace, 'inside.txt'))).toBe(true);
      const escaped = await sandboxed(
        policy,
        `echo hi > ${outside}/escaped.txt`,
      );
      expect(escaped.exitCode).not.toBe(0);
      expect(existsSync(join(outside, 'escaped.txt'))).toBe(false);
    });

    it('keeps the credential paths unreadable unless the call was approved', async () => {
      const { policy, secret } = policyFor();
      expect((await sandboxed(policy, `cat ${secret}`)).exitCode).not.toBe(0);
      const approved = await sandboxed(policy, `cat ${secret}`, {
        credentials: true,
      });
      expect(approved.stdout).toContain('secret-key');
    });

    it('opens no connection, an interpreter included, unless approved', async () => {
      server = createServer((socket) => socket.end('hello\n'));
      await new Promise<void>((resolve) =>
        (server as Server).listen(0, '127.0.0.1', resolve),
      );
      const { port } = (server as Server).address() as AddressInfo;
      const { policy } = policyFor();
      const probe = `${process.execPath} -e "require('net').connect(${port},'127.0.0.1').on('data',d=>{process.stdout.write(String(d));process.exit(0)}).on('error',e=>{console.log(e.code);process.exit(3)})"`;
      const refused = await sandboxed(policy, probe);
      expect(refused.exitCode).toBe(3);
      expect(refused.stdout).toContain('EPERM');
      const approved = await sandboxed(policy, probe, { network: true });
      expect(approved.stdout).toContain('hello');
    });
  },
);
