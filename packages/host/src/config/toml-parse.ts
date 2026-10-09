// The TOML subset Kubic's config files use, parsed into plain records:
// tables, array tables, inline tables, strings, numbers, booleans and arrays.
// A key that could reach an object's prototype is refused by name.

import { isRecord } from './checks.js';
import { ConfigError } from './errors.js';

function stripTrailingComment(line: string): string {
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (inSingle) {
      if (ch === "'") inSingle = false;
    } else if (inDouble) {
      if (ch === '\\') i += 1;
      else if (ch === '"') inDouble = false;
    } else if (ch === "'") {
      inSingle = true;
    } else if (ch === '"') {
      inDouble = true;
    } else if (ch === '#') {
      return line.slice(0, i);
    }
  }
  return line;
}

function splitEquals(line: string, lineNo: number): [string, string] {
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (inSingle) {
      if (ch === "'") inSingle = false;
    } else if (inDouble) {
      if (ch === '\\') i += 1;
      else if (ch === '"') inDouble = false;
    } else if (ch === "'") {
      inSingle = true;
    } else if (ch === '"') {
      inDouble = true;
    } else if (ch === '=') {
      return [line.slice(0, i), line.slice(i + 1)];
    }
  }
  throw new ConfigError(`line ${lineNo}: expected key = value`);
}

function splitTopLevel(text: string, lineNo: number): string[] {
  const parts: string[] = [];
  let depth = 0;
  let inSingle = false;
  let inDouble = false;
  let current = '';
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (inSingle) {
      current += ch;
      if (ch === "'") inSingle = false;
    } else if (inDouble) {
      current += ch;
      if (ch === '\\') {
        current += text[i + 1] ?? '';
        i += 1;
      } else if (ch === '"') {
        inDouble = false;
      }
    } else if (ch === "'") {
      inSingle = true;
      current += ch;
    } else if (ch === '"') {
      inDouble = true;
      current += ch;
    } else if (ch === '[' || ch === '{') {
      depth += 1;
      current += ch;
    } else if (ch === ']' || ch === '}') {
      depth -= 1;
      current += ch;
    } else if (ch === ',' && depth === 0) {
      parts.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  if (inSingle || inDouble) {
    throw new ConfigError(`line ${lineNo}: unterminated string in array`);
  }
  parts.push(current);
  return parts;
}

function unescapeDouble(raw: string, lineNo: number): string {
  let out = '';
  for (let i = 0; i < raw.length; i += 1) {
    const ch = raw[i];
    if (ch !== '\\') {
      out += ch;
      continue;
    }
    const next = raw[i + 1];
    if (next === 'n') out += '\n';
    else if (next === 't') out += '\t';
    else if (next === 'r') out += '\r';
    else if (next === '"') out += '"';
    else if (next === '\\') out += '\\';
    else {
      throw new ConfigError(`line ${lineNo}: bad escape \\${next ?? ''}`);
    }
    i += 1;
  }
  return out;
}

function parseScalar(text: string, lineNo: number): unknown {
  const token = text.trim();
  if (token.length >= 2 && token.startsWith('"') && token.endsWith('"')) {
    return unescapeDouble(token.slice(1, -1), lineNo);
  }
  if (token.length >= 2 && token.startsWith("'") && token.endsWith("'")) {
    return token.slice(1, -1);
  }
  if (token === 'true') return true;
  if (token === 'false') return false;
  if (/^[+-]?\d+(\.\d+)?$/.test(token)) return Number(token);
  if (token.startsWith('{')) {
    if (!token.endsWith('}')) {
      throw new ConfigError(`line ${lineNo}: unterminated inline table`);
    }
    return parseInlineTable(token.slice(1, -1), lineNo);
  }
  if (token.startsWith('[') && token.endsWith(']')) {
    const inner = token.slice(1, -1).trim();
    if (inner === '') return [];
    return splitTopLevel(inner, lineNo).map((item) => {
      const value = parseScalar(item, lineNo);
      // Inline-table elements are the per-entry shape some array keys
      // validate themselves (`[roles.*].models`); nested
      // arrays stay unsupported, and every other array key still
      // refuses tables through its own typed checker.
      if (Array.isArray(value)) {
        throw new ConfigError(`line ${lineNo}: nested arrays are unsupported`);
      }
      return value;
    });
  }
  throw new ConfigError(`line ${lineNo}: cannot parse value ${token}`);
}

// A TOML inline table (`{ id = "acme/big", thinking = "high" }` in a role's
// `models` list): the parser supports exactly one level of it. Guarded like
// the section parser: dunder keys are refused and duplicates are named.
function parseInlineTable(
  inner: string,
  lineNo: number,
): Record<string, unknown> {
  const trimmed = inner.trim();
  const out: Record<string, unknown> = {};
  if (trimmed === '') return out;
  for (const entry of splitTopLevel(trimmed, lineNo)) {
    const [rawKey, rawValue] = splitEquals(entry.trim(), lineNo);
    const key = rawKey.trim();
    if (!/^[A-Za-z0-9_-]+$/.test(key)) {
      throw new ConfigError(`line ${lineNo}: bad key '${key}'`);
    }
    assertSafePathKey(key, `line ${lineNo}`);
    if (Object.hasOwn(out, key)) {
      throw new ConfigError(`line ${lineNo}: duplicate key '${key}'`);
    }
    out[key] = parseScalar(rawValue, lineNo);
  }
  return out;
}

// Prototype-pollution guard: TOML section/key segments are
// attacker-controlled (project-local configs are post-trust files), so
// dunder segments must never be assigned onto plain objects —
// `obj['__proto__'] = ...` mutates Object.prototype instead of creating an
// own property. Rejected fail-closed at both assignment sites (setPath for
// parsing, unflatten for layer merging).
const UNSAFE_PATH_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

export function assertSafePathKey(key: string, context: string): void {
  if (UNSAFE_PATH_KEYS.has(key)) {
    throw new ConfigError(`${context}: forbidden key '${key}'`);
  }
}

function setPath(
  root: Record<string, unknown>,
  path: string[],
  value: unknown,
  lineNo: number,
): void {
  for (const key of path) assertSafePathKey(key, `line ${lineNo}`);
  let node = root;
  for (let i = 0; i < path.length - 1; i += 1) {
    const key = path[i] as string;
    const next = node[key];
    if (next === undefined) {
      const fresh: Record<string, unknown> = {};
      node[key] = fresh;
      node = fresh;
    } else if (isRecord(next)) {
      node = next;
    } else {
      throw new ConfigError(
        `line ${lineNo}: '${path.slice(0, i + 1).join('.')}' is already a value`,
      );
    }
  }
  const leaf = path[path.length - 1] as string;
  if (Object.hasOwn(node, leaf)) {
    throw new ConfigError(`line ${lineNo}: duplicate key '${path.join('.')}'`);
  }
  node[leaf] = value;
}

// `[[audit]]`: append a fresh table to the array at `path` and
// return it so following key lines land inside that element. The path walk
// mirrors setPath's guards (dunder segments refused, collisions named) and
// the array container is created on first sight.
function appendArrayTable(
  root: Record<string, unknown>,
  path: string[],
  lineNo: number,
): Record<string, unknown> {
  for (const key of path) assertSafePathKey(key, `line ${lineNo}`);
  let node = root;
  for (let i = 0; i < path.length - 1; i += 1) {
    const key = path[i] as string;
    const next = node[key];
    if (next === undefined) {
      const fresh: Record<string, unknown> = {};
      node[key] = fresh;
      node = fresh;
    } else if (isRecord(next)) {
      node = next;
    } else {
      throw new ConfigError(
        `line ${lineNo}: '${path.slice(0, i + 1).join('.')}' is already a value`,
      );
    }
  }
  const leaf = path[path.length - 1] as string;
  const existing = node[leaf];
  const fresh: Record<string, unknown> = {};
  if (existing === undefined) {
    node[leaf] = [fresh];
    return fresh;
  }
  if (!Array.isArray(existing)) {
    throw new ConfigError(
      `line ${lineNo}: '${path.join('.')}' is already a value`,
    );
  }
  existing.push(fresh);
  return fresh;
}

export function parseTomlDocument(text: string): Record<string, unknown> {
  const root: Record<string, unknown> = {};
  let section: string[] = [];
  // The table key lines land in: `root` for ordinary sections, the newest
  // element for an `[[array-of-tables]]` header.
  let table: Record<string, unknown> = root;
  const lines = text.split('\n');
  lines.forEach((rawLine, index) => {
    const lineNo = index + 1;
    const line = stripTrailingComment(rawLine).trim();
    if (line === '') return;
    const arrayHeader = /^\[\[([A-Za-z0-9_.-]+)\]\]$/.exec(line);
    if (arrayHeader !== null) {
      section = [];
      table = appendArrayTable(
        root,
        (arrayHeader[1] as string).split('.'),
        lineNo,
      );
      return;
    }
    const header = /^\[([A-Za-z0-9_.-]+)\]$/.exec(line);
    if (header) {
      section = (header[1] as string).split('.');
      table = root;
      return;
    }
    if (line.startsWith('[')) {
      throw new ConfigError(`line ${lineNo}: bad section header`);
    }
    const [rawKey, rawValue] = splitEquals(line, lineNo);
    const key = rawKey.trim();
    if (!/^[A-Za-z0-9_-]+(\.[A-Za-z0-9_-]+)*$/.test(key)) {
      throw new ConfigError(`line ${lineNo}: bad key '${key}'`);
    }
    setPath(
      table,
      [...section, ...key.split('.')],
      parseScalar(rawValue, lineNo),
      lineNo,
    );
  });
  return root;
}
