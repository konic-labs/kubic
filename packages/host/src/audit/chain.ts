// The tamper-evident ledger: every record line carries a link to the one
// before it — `chain: { prev, hash }`, where `hash` is the SHA-256 of `prev`
// and the record's own JSON — so editing a line breaks its hash and removing
// one breaks the next line's `prev`. A head file beside the ledger records the
// last hash and the ledger's size after each append, so records removed from
// the end, or bytes added after them, are caught too. A ledger begun before
// the chain keeps its older lines: the first chained record links to the
// digest of everything before it.
//
// Appends run under a lock beside the ledger, so two processes writing one
// ledger never fork the chain. `kubic audit verify` walks it and names the
// first line that does not hold.

import { createHash } from 'node:crypto';
import { join } from 'node:path';
import {
  createNodeFileBridge,
  updateFileLocked,
} from '@kubic/exec/file-bridge';
import { withFileLocked } from '@kubic/exec/lock-file';
import type { OrgAuditRecord } from './audit.js';

/**
 * The `prev` of the first record of a ledger begun with the chain.
 * @internal
 */
export const CHAIN_GENESIS = `sha256:${'0'.repeat(64)}`;

const TAIL_WINDOW = 64 * 1024;
const FILE_MODE = 0o600;
const DIR_MODE = 0o700;

type Bridge = ReturnType<typeof createNodeFileBridge>;

interface ChainLink {
  readonly prev: string;
  readonly hash: string;
}

interface LedgerHead {
  readonly hash: string;
  readonly size: number;
}

function sha256(data: string | Uint8Array): string {
  return `sha256:${createHash('sha256').update(data).digest('hex')}`;
}

/**
 * The hash a record links to its predecessor with.
 * @internal
 */
export function chainHash(prev: string, recordJson: string): string {
  return sha256(`${prev}\n${recordJson}`);
}

function headPath(file: string): string {
  return `${file}.head`;
}

function linkOf(value: unknown): ChainLink | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const chain = (value as { chain?: unknown }).chain;
  if (typeof chain !== 'object' || chain === null) return undefined;
  const { prev, hash } = chain as Record<string, unknown>;
  return typeof prev === 'string' && typeof hash === 'string'
    ? { prev, hash }
    : undefined;
}

function parse(line: string): unknown {
  try {
    return JSON.parse(line) as unknown;
  } catch {
    return undefined;
  }
}

// The last complete line of the file (without its newline), and whether the
// file ends mid-line (a torn write the next append must not run on from).
function tail(
  bridge: Bridge,
  file: string,
  size: number,
): { line: string | undefined; torn: boolean } {
  if (size === 0) return { line: undefined, torn: false };
  let window = Math.min(size, TAIL_WINDOW);
  for (;;) {
    const bytes =
      bridge.readFileRange?.(file, size - window, size) ??
      bridge.readBinaryFile(file).subarray(size - window);
    const text = new TextDecoder().decode(bytes);
    const torn = !text.endsWith('\n');
    const body = torn ? text : text.slice(0, -1);
    const cut = body.lastIndexOf('\n');
    if (cut !== -1 || window === size) {
      return { line: body.slice(cut + 1), torn };
    }
    window = Math.min(size, window * 4);
  }
}

/**
 * Appends one record to the ledger file `file` (in the bridge's directory)
 * with its chain link, durably, and moves the head.
 */
export function appendChainedAuditLine(
  bridge: Bridge,
  dir: string,
  file: string,
  record: OrgAuditRecord,
): void {
  if (!bridge.exists('.')) bridge.createDir('.', true, DIR_MODE);
  withFileLocked(join(dir, `${file}.lock`), () => {
    const size = bridge.exists(file) ? bridge.fileInfo(file).size : 0;
    const last = tail(bridge, file, size);
    let prefix = '';
    // A torn last line is closed off, never written onto.
    if (last.torn) prefix = '\n';
    const linked = last.torn ? undefined : linkOf(parse(last.line ?? ''));
    const prev =
      linked?.hash ??
      (size === 0
        ? CHAIN_GENESIS
        : sha256(
            Buffer.concat([bridge.readBinaryFile(file), Buffer.from(prefix)]),
          ));
    const json = JSON.stringify(record);
    const hash = chainHash(prev, json);
    const line = `${prefix}${json.slice(0, -1)},"chain":${JSON.stringify({ prev, hash })}}\n`;
    if (bridge.appendDurably !== undefined) {
      bridge.appendDurably(file, line, { mode: FILE_MODE });
    } else {
      bridge.appendFile(file, line, { mode: FILE_MODE });
    }
    const after = size + Buffer.byteLength(line, 'utf8');
    updateFileLocked(
      join(dir, headPath(file)),
      () => `${JSON.stringify({ hash, size: after })}\n`,
      { mode: FILE_MODE },
    );
  });
}

interface ChainProblem {
  // The 1-based line the chain breaks at.
  readonly line: number;
  readonly message: string;
}

export interface ChainVerification {
  readonly ok: boolean;
  readonly path: string;
  readonly records: number;
  // Records written before the chain began: covered by the first chained
  // record's link, not linked one by one.
  readonly unchained: number;
  readonly head: string | undefined;
  readonly problem?: ChainProblem;
  // Said when the ledger has no head file: removals from the end then go
  // unseen.
  readonly note?: string;
}

function readHead(bridge: Bridge, file: string): LedgerHead | undefined {
  try {
    const parsed = JSON.parse(bridge.readTextFile(headPath(file))) as unknown;
    if (typeof parsed !== 'object' || parsed === null) return undefined;
    const { hash, size } = parsed as Record<string, unknown>;
    return typeof hash === 'string' && typeof size === 'number'
      ? { hash, size }
      : undefined;
  } catch {
    return undefined;
  }
}

/** Walks the ledger at `path` and names the first line its chain breaks at. */
export function verifyAuditChain(path: string): ChainVerification {
  const dir = join(path, '..');
  const file = path.slice(dir.length + 1);
  const bridge = createNodeFileBridge(dir);
  let bytes: Uint8Array;
  try {
    bytes = bridge.readBinaryFile(file);
  } catch (error) {
    if ((error as { code?: unknown }).code === 'ENOENT') {
      return { ok: true, path, records: 0, unchained: 0, head: undefined };
    }
    throw error;
  }
  const text = new TextDecoder().decode(bytes);
  const lines = text.split('\n');
  if (lines.at(-1) === '') lines.pop();
  let offset = 0;
  let unchained = 0;
  let records = 0;
  let expected: string | undefined;
  const fail = (line: number, message: string): ChainVerification => ({
    ok: false,
    path,
    records,
    unchained,
    head: expected,
    problem: { line, message },
  });
  for (const [index, line] of lines.entries()) {
    const number = index + 1;
    const start = offset;
    offset += Buffer.byteLength(line, 'utf8') + 1;
    const value = parse(line);
    if (typeof value !== 'object' || value === null) {
      return fail(number, 'is not a record: a torn or edited line');
    }
    const link = linkOf(value);
    if (link === undefined) {
      if (expected !== undefined) {
        return fail(
          number,
          'has no chain link: it was inserted, or written without one after the chain began',
        );
      }
      unchained += 1;
      records += 1;
      continue;
    }
    const want =
      expected ??
      (unchained === 0 ? CHAIN_GENESIS : sha256(bytes.subarray(0, start)));
    if (link.prev !== want) {
      return fail(
        number,
        expected === undefined && unchained > 0
          ? 'does not follow the records before the chain began: one of them changed or was removed'
          : `does not follow line ${number - 1}: a record before it was removed, or line ${number - 1} changed`,
      );
    }
    const { chain: _chain, ...record } = value as Record<string, unknown>;
    if (chainHash(link.prev, JSON.stringify(record)) !== link.hash) {
      return fail(number, 'was changed after it was written');
    }
    expected = link.hash;
    records += 1;
  }
  if (expected === undefined) {
    return { ok: true, path, records, unchained, head: undefined };
  }
  const head = readHead(bridge, file);
  if (head === undefined) {
    return {
      ok: true,
      path,
      records,
      unchained,
      head: expected,
      note: `no head file (${headPath(path)}): records removed from the end would go unseen`,
    };
  }
  if (head.hash !== expected || head.size !== bytes.byteLength) {
    return fail(
      lines.length + 1,
      head.size > bytes.byteLength
        ? 'is missing: records were removed from the end of the ledger'
        : 'holds bytes after the last record the head names: the end of the ledger changed',
    );
  }
  return { ok: true, path, records, unchained, head: expected };
}
