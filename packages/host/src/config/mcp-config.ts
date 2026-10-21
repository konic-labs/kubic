// `[mcp.<name>]`: the MCP servers the organization allowlists. A server runs
// only when the managed config — the enterprise or product layer — names
// it, with its pinned command or URL and version; a server any other layer
// names is refused by name, and so is a table that is not a usable pin.

import { isAbsolute } from 'node:path';
import type { McpServerSpec } from '../mcp/index.js';
import { checkCollectorUrl } from '../net/index.js';
import type { ConfigLayer, KubicConfig } from './config.js';
import { ConfigError } from './errors.js';

const ALLOWLIST_LAYERS: ReadonlySet<ConfigLayer> = new Set([
  'enterprise',
  'product',
]);
const SERVER_NAME = /^[A-Za-z0-9-]{1,32}$/;
const VARIABLE = /^[A-Z][A-Z0-9_]*$/;

function spec(
  name: string,
  table: NonNullable<KubicConfig['mcp']>[string],
): McpServerSpec {
  const where = `'[mcp.${name}]'`;
  if (!SERVER_NAME.test(name)) {
    throw new ConfigError(
      `${where}: a server name is 1-32 letters, digits or dashes (it prefixes each tool's name)`,
    );
  }
  if ((table.command === undefined) === (table.url === undefined)) {
    throw new ConfigError(
      `${where} names exactly one of 'command' (a stdio server) or 'url' (a streamable HTTP server)`,
    );
  }
  if (table.command !== undefined && !isAbsolute(table.command)) {
    throw new ConfigError(
      `${where}: 'command' must be an absolute path, pinned (got ${JSON.stringify(table.command)})`,
    );
  }
  if (table.url !== undefined) {
    try {
      checkCollectorUrl(table.url);
    } catch (error) {
      throw new ConfigError(
        `${where}: ${error instanceof Error ? error.message.replace('collector URL', 'server URL') : String(error)}`,
      );
    }
  }
  if (table.version === undefined || table.version.trim() === '') {
    throw new ConfigError(`${where} pins no 'version'`);
  }
  if (table.url !== undefined && table.args !== undefined) {
    throw new ConfigError(`${where}: 'args' is for a stdio server`);
  }
  const badVariable = (table.env ?? []).find((name) => !VARIABLE.test(name));
  if (badVariable !== undefined) {
    throw new ConfigError(
      `${where}: env ${JSON.stringify(badVariable)} is not a variable name`,
    );
  }
  const unoffered = (table.approve ?? []).find(
    (tool) => table.tools !== undefined && !table.tools.includes(tool),
  );
  if (unoffered !== undefined) {
    throw new ConfigError(
      `${where}: approve names ${JSON.stringify(unoffered)}, which 'tools' does not offer`,
    );
  }
  return {
    name,
    version: table.version,
    ...(table.command === undefined ? {} : { command: table.command }),
    ...(table.args === undefined ? {} : { args: [...table.args] }),
    ...(table.url === undefined ? {} : { url: table.url }),
    ...(table.tools === undefined ? {} : { tools: [...table.tools] }),
    ...(table.approve === undefined ? {} : { approve: [...table.approve] }),
    ...(table.env === undefined ? {} : { env: [...table.env] }),
  };
}

export function mcpServersOf(
  perLayer: ReadonlyArray<{ layer: ConfigLayer; config: KubicConfig }>,
  projectPath?: string,
): McpServerSpec[] {
  for (const { layer, config } of perLayer) {
    const named = Object.keys(config.mcp ?? {})[0];
    if (named !== undefined && !ALLOWLIST_LAYERS.has(layer)) {
      throw new ConfigError(
        `'[mcp.${named}]' is read from the enterprise and product layers only — an MCP server runs only when the organization allowlists it; the ${layer} layer${layer === 'project' && projectPath !== undefined ? ` (${projectPath})` : ''} cannot name one`,
      );
    }
  }
  const servers = new Map<string, McpServerSpec>();
  for (const layer of ['enterprise', 'product'] as const) {
    for (const entry of perLayer.filter((each) => each.layer === layer)) {
      for (const [name, table] of Object.entries(entry.config.mcp ?? {})) {
        if (!servers.has(name)) servers.set(name, spec(name, table));
      }
    }
  }
  return [...servers.values()];
}
