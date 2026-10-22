// The MCP client over a real stdio server: the version pin, the tools the
// allowlist narrows to, a call's text, and a server reporting another
// version refused by name.
import { spawnMcpStdio } from '@kubic/exec/mcp-stdio';
import { afterEach, describe, expect, it } from 'vitest';
import { tempDir } from '../../../../test/temp-dir.js';
import { writeFakeMcpServer } from '../test-support/fake-mcp-server.js';
import { connectMcpServer, type McpConnection } from './client.js';

const open: McpConnection[] = [];

afterEach(() => {
  for (const connection of open.splice(0)) connection.close();
});

function transport(version?: string) {
  const dir = tempDir('mcp-client-');
  const server = writeFakeMcpServer(dir, version);
  const stderr: string[] = [];
  return {
    stderr,
    transport: spawnMcpStdio({
      command: server.command,
      args: server.args,
      cwd: dir,
      stderr: (line) => stderr.push(line),
    }),
  };
}

describe('connectMcpServer', () => {
  it('offers the allowlisted tools of a server on its pinned version', async () => {
    const { transport: wire, stderr } = transport();
    const connection = await connectMcpServer(
      {
        name: 'fake',
        command: '/x',
        version: '1.2.3',
        tools: ['echo', 'danger', 'gone'],
      },
      wire,
      '0.1.2',
    );
    open.push(connection);
    expect(connection.tools.map((tool) => tool.qualified)).toEqual([
      'mcp__fake__echo',
      'mcp__fake__danger',
    ]);
    expect(connection.missing).toEqual(['gone']);
    expect(await connection.call('echo', { text: 'hi' })).toEqual({
      text: 'echo: hi',
      isError: false,
    });
    expect(stderr).toContain('fake server ready');
  });

  it('refuses a server reporting another version', async () => {
    const { transport: wire } = transport('9.9.9');
    await expect(
      connectMcpServer(
        { name: 'fake', command: '/x', version: '1.2.3' },
        wire,
        '0.1.2',
      ),
    ).rejects.toThrow(
      `MCP server 'fake' reports version "9.9.9", but the allowlist pins "1.2.3"`,
    );
  });
});
