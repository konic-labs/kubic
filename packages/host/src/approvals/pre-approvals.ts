// A signed pre-approval file: a job's own list of exactly what it may run
// without an ask, signed by the organization. It grants a capability for the
// tools and the command patterns it names and nothing else, it is checked on
// every call (never latched), and a file that changed after it was signed,
// was signed with another key, or has expired is refused before the run
// starts.
//
//   {"version": 1, "job": "nightly-deps", "reason": "the nightly refresh",
//    "expires": "2026-11-01T00:00:00Z",
//    "grants": [{"capability": "install", "tools": ["bash"],
//                "commands": ["npm ci", "npm install *"]}]}
//
// A `*` in a command pattern stands for any text without a shell operator
// (`;`, `&`, `|`, a backtick, `$`, `<`, `>`, a parenthesis or a newline), so
// `npm install *` never covers `npm install x; curl …`. A grant with
// `commands` covers only calls that carry a command (bash).

import { createNodeFileBridge, type FileBridge } from '@kubic/exec/file-bridge';
import {
  ed25519PublicKey,
  SignatureError,
  signatureMatches,
} from '../signing/index.js';
import { ALWAYS_ASK } from './policy.js';

const MAX_FILE_BYTES = 256 * 1024;
const COMMAND_WILDCARD = '[^;&|`$<>()\\n\\r]*';
const FILE_KEYS = new Set(['version', 'job', 'reason', 'expires', 'grants']);
const GRANT_KEYS = new Set(['capability', 'tools', 'commands']);

class PreApprovalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PreApprovalError';
  }
}

interface PreApprovalGrant {
  readonly capability: string;
  readonly tools?: readonly string[];
  readonly commands?: readonly string[];
}

export interface PreApprovals {
  readonly path: string;
  readonly job: string;
  readonly reason: string;
  readonly expires?: string;
  readonly grants: readonly PreApprovalGrant[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function nonEmpty(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== '';
}

function strings(value: unknown, where: string): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length === 0 || !value.every(nonEmpty)) {
    throw new PreApprovalError(`${where} must be a non-empty list of strings`);
  }
  return value.map((entry) => entry.trim());
}

function unknownKeys(
  record: Record<string, unknown>,
  known: ReadonlySet<string>,
  where: string,
): void {
  const extra = Object.keys(record).filter((key) => !known.has(key));
  if (extra.length > 0) {
    throw new PreApprovalError(
      `${where} has unknown key(s): ${extra.join(', ')}`,
    );
  }
}

function parseGrant(value: unknown, index: number): PreApprovalGrant {
  const where = `grants[${index}]`;
  if (!isRecord(value)) throw new PreApprovalError(`${where} is not a table`);
  unknownKeys(value, GRANT_KEYS, where);
  if (!nonEmpty(value.capability)) {
    throw new PreApprovalError(`${where}.capability must be a capability name`);
  }
  const capability = value.capability.trim();
  if (ALWAYS_ASK.has(capability)) {
    throw new PreApprovalError(
      `${where}: ${capability} always asks — no pre-approval grants it`,
    );
  }
  const tools = strings(value.tools, `${where}.tools`);
  const commands = strings(value.commands, `${where}.commands`);
  return {
    capability,
    ...(tools === undefined ? {} : { tools }),
    ...(commands === undefined ? {} : { commands }),
  };
}

/** The pre-approval file `text` (read from `path`), validated; refuses by name. */
export function parsePreApprovals(text: string, path: string): PreApprovals {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    throw new PreApprovalError(
      `${path} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  try {
    if (!isRecord(value)) throw new PreApprovalError('it is not a JSON object');
    unknownKeys(value, FILE_KEYS, 'the file');
    if (value.version !== 1) {
      throw new PreApprovalError('version must be 1');
    }
    if (!nonEmpty(value.job)) throw new PreApprovalError('job must be named');
    if (!nonEmpty(value.reason)) {
      throw new PreApprovalError('reason must say why the job may run this');
    }
    if (
      value.expires !== undefined &&
      (typeof value.expires !== 'string' ||
        Number.isNaN(Date.parse(value.expires)))
    ) {
      throw new PreApprovalError('expires must be an ISO 8601 date');
    }
    if (!Array.isArray(value.grants) || value.grants.length === 0) {
      throw new PreApprovalError('grants must list at least one grant');
    }
    return {
      path,
      job: value.job.trim().slice(0, 128),
      reason: value.reason.trim().slice(0, 500),
      ...(value.expires === undefined ? {} : { expires: value.expires }),
      grants: value.grants.map(parseGrant),
    };
  } catch (error) {
    throw error instanceof PreApprovalError
      ? new PreApprovalError(`pre-approval file ${path}: ${error.message}`)
      : error;
  }
}

/**
 * Reads, verifies and parses the pre-approval file at `path` against the
 * Ed25519 key at `keyPath`: an unsigned, altered, expired or malformed file
 * is refused by name.
 */
export function loadPreApprovals(options: {
  readonly path: string;
  readonly keyPath: string;
  readonly now?: number;
  readonly bridge?: Pick<FileBridge, 'exists' | 'readTextFile'>;
}): PreApprovals {
  const files = options.bridge ?? createNodeFileBridge('/');
  const { path, keyPath } = options;
  const signaturePath = `${path}.sig`;
  const read = (file: string, what: string): string => {
    try {
      return files.readTextFile(file);
    } catch (error) {
      throw new PreApprovalError(
        `cannot read the ${what} ${file}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  };
  const text = read(path, 'pre-approval file');
  if (Buffer.byteLength(text, 'utf8') > MAX_FILE_BYTES) {
    throw new PreApprovalError(
      `pre-approval file ${path} is over ${MAX_FILE_BYTES / 1024} KiB`,
    );
  }
  let key: ReturnType<typeof ed25519PublicKey>;
  try {
    key = ed25519PublicKey(read(keyPath, 'pre-approval key'), keyPath);
  } catch (error) {
    throw error instanceof SignatureError
      ? new PreApprovalError(error.message)
      : error;
  }
  if (!files.exists(signaturePath)) {
    throw new PreApprovalError(
      `pre-approval file ${path} is not signed: ${signaturePath} is missing`,
    );
  }
  if (!signatureMatches(key, text, read(signaturePath, 'signature'))) {
    throw new PreApprovalError(
      `pre-approval file ${path} does not match its signature ${signaturePath} — it changed after it was signed, or was signed with another key than ${keyPath}`,
    );
  }
  const parsed = parsePreApprovals(text, path);
  const now = options.now ?? Date.now();
  if (parsed.expires !== undefined && Date.parse(parsed.expires) <= now) {
    throw new PreApprovalError(
      `pre-approval file ${path} expired at ${parsed.expires}`,
    );
  }
  return parsed;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function commandMatches(pattern: string, command: string): boolean {
  const body = pattern.split('*').map(escapeRegExp).join(COMMAND_WILDCARD);
  return new RegExp(`^${body}$`).test(command.trim());
}

/**
 * The `by` a pre-approval answers this call's capability with
 * (`pre-approval:<job>`), or undefined when no grant covers it.
 */
export function preApprovalFor(
  pre: PreApprovals,
  toolName: string,
  capability: string,
  args: Record<string, unknown>,
): string | undefined {
  if (ALWAYS_ASK.has(capability)) return undefined;
  const command = typeof args.command === 'string' ? args.command : undefined;
  const covered = pre.grants.some(
    (grant) =>
      grant.capability === capability &&
      (grant.tools === undefined || grant.tools.includes(toolName)) &&
      (grant.commands === undefined ||
        (command !== undefined &&
          grant.commands.some((pattern) => commandMatches(pattern, command)))),
  );
  return covered ? `pre-approval:${pre.job}` : undefined;
}
