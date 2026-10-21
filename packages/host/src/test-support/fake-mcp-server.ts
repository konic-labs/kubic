// A fake MCP server for tests: a CommonJS script written to a directory and
// run with this Node, speaking newline-delimited JSON-RPC on stdio. It
// reports the version it is given and offers `echo`, `danger` and `hidden`.

import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

const SCRIPT = `
const readline = require('node:readline');
const version = process.argv[2] || '1.2.3';
const send = (message) => process.stdout.write(JSON.stringify(message) + '\\n');
process.stderr.write('fake server ready\\n');
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  const message = JSON.parse(line);
  if (message.method === 'initialize') {
    send({ jsonrpc: '2.0', id: message.id, result: {
      protocolVersion: '2025-06-18',
      capabilities: { tools: {} },
      serverInfo: { name: 'fake', version },
    } });
  } else if (message.method === 'tools/list') {
    send({ jsonrpc: '2.0', id: message.id, result: { tools: [
      { name: 'echo', description: 'Echo the text back',
        inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } },
      { name: 'danger', description: 'Do something risky',
        inputSchema: { type: 'object', properties: {} } },
      { name: 'hidden', description: 'Not on the allowlist',
        inputSchema: { type: 'object', properties: {} } },
    ] } });
  } else if (message.method === 'tools/call') {
    const text = (message.params.arguments || {}).text;
    send({ jsonrpc: '2.0', id: message.id, result: {
      content: [{ type: 'text', text: message.params.name + ': ' + (text === undefined ? 'done' : text) }],
    } });
  } else if (message.id !== undefined) {
    send({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'not here' } });
  }
});
`;

/** Writes the server into `dir`; returns how to start it. */
export function writeFakeMcpServer(
  dir: string,
  version = '1.2.3',
): { readonly command: string; readonly args: string[] } {
  const script = join(dir, 'fake-mcp-server.cjs');
  writeFileSync(script, SCRIPT);
  return { command: process.execPath, args: [script, version] };
}
