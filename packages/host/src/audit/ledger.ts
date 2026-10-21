// The durable audit ledger: ONE record format (OrgAuditRecord, version 1) in
// ONE append-only JSONL file per repo, written through emitAudit's
// validation and read back by `kubic audit`.
//
// Location: <repo>/.kubic/audit/audit.jsonl, which the shipped runtime
// ignore rules (`.kubic/audit/`) keep out of the user's commit path.
//
// File access goes through the exec FileBridge (I/O confinement).

import { basename, dirname, join, resolve } from 'node:path';
import { redactSecretShapes } from '@kubic/core/secret-shapes';
import { createNodeFileBridge } from '@kubic/exec/file-bridge';
import { matchableSecrets } from '../secret-refs/index.js';
import type { AuditInput, AuditSink, OrgAuditRecord } from './audit.js';
import { AUDIT_RECORD_VERSION, emitAudit } from './audit.js';
import { isPrivilegedAuditWhat } from './records.js';

export const AUDIT_LEDGER_FILE = 'audit.jsonl';

// The ledger's directory for a repo root.
export function auditLedgerDir(repoRoot: string): string {
  return join(repoRoot, '.kubic', 'audit');
}

// The repo runtime root for a working directory: the MAIN
// checkout's toplevel — what `git rev-parse --path-format=absolute
// --git-common-dir` names the parent of — so a run from a subdirectory or a
// linked worktree resolves to the one directory `kubic audit` reads. Resolved from the filesystem (no git spawn): the
// nearest ancestor holding `.git`; a `.git` FILE (linked worktree) is
// followed to its gitdir and that gitdir's `commondir`. Outside a repository,
// the directory itself.
export function resolveRepoRuntimeRoot(cwd: string): string {
  const bridge = createNodeFileBridge('/');
  const start = resolve(cwd);
  let dir = start;
  for (;;) {
    const dotGit = join(dir, '.git');
    let found = false;
    try {
      found = bridge.exists(dotGit);
    } catch {
      // Unreadable ancestor: keep walking.
    }
    if (found) return mainCheckoutFor(dir, dotGit);
    const parent = dirname(dir);
    if (parent === dir) return start;
    dir = parent;
  }
}

function mainCheckoutFor(top: string, dotGit: string): string {
  const bridge = createNodeFileBridge('/');
  let text: string;
  try {
    // A directory `.git` makes this the main checkout; reading it as a file
    // throws, which lands here.
    text = bridge.readTextFile(dotGit);
  } catch {
    return top;
  }
  const match = /^gitdir:\s*(.+)$/m.exec(text);
  if (match?.[1] === undefined) return top;
  const gitDir = resolve(top, match[1].trim());
  let common: string;
  try {
    common = resolve(
      gitDir,
      bridge.readTextFile(join(gitDir, 'commondir')).trim(),
    );
  } catch {
    // No commondir (a submodule's gitdir): the checkout holding the `.git`
    // file is its own main checkout.
    return top;
  }
  return basename(common) === '.git' ? dirname(common) : top;
}

// The ledger dir for a working directory: the repo runtime root's ledger
// (resolveRepoRuntimeRoot) — the one the writer and `kubic audit` share.
export function auditLedgerDirFor(cwd: string): string {
  return auditLedgerDir(resolveRepoRuntimeRoot(cwd));
}

// The base revision a run started from: `git rev-parse
// HEAD` in the WORKSPACE, captured ONCE at run start — `none` outside git
// or when git cannot run. Best-effort by contract: a failed probe is never a
// run failure, and the record then honestly says `none`. The workspace
// travels as `git -C`, never as the spawn's own cwd: the composition root's
// shell is pinned to its env dir, which is not necessarily this run's
// workspace. The runner is that shell spawn, waited: `((cmd, args) =>
// env.shell.spawn(cmd, args, { provenance }).wait())`.
export async function resolveRunBaseRevision(
  workspace: string,
  run: (
    cmd: string,
    args: string[],
  ) => Promise<{
    exitCode: number;
    stdout: string;
  }>,
): Promise<string> {
  try {
    const done = await run('git', ['-C', workspace, 'rev-parse', 'HEAD']);
    const sha = done.stdout.trim();
    if (done.exitCode === 0 && sha !== '') return sha;
  } catch {
    // Not a repo, no git binary, or a spawn failure: `none` below.
  }
  return 'none';
}

// The creation modes of audit files: private like every other piece of
// Kubic state. They apply only to what an append creates; an existing file or
// directory keeps its own mode.
const AUDIT_FILE_MODE = 0o600;
const AUDIT_DIR_MODE = 0o700;

// One record line appended durably (fsync) where the bridge offers it — the
// journal's own primitive — so a crash cannot lose an acknowledged record.
// Shared by the repo ledger and the `[[audit]] file` sink.
export function appendAuditLine(
  bridge: ReturnType<typeof createNodeFileBridge>,
  file: string,
  record: OrgAuditRecord,
): void {
  if (!bridge.exists('.')) bridge.createDir('.', true, AUDIT_DIR_MODE);
  const line = `${JSON.stringify(record)}\n`;
  if (bridge.appendDurably !== undefined) {
    bridge.appendDurably(file, line, { mode: AUDIT_FILE_MODE });
  } else {
    bridge.appendFile(file, line, { mode: AUDIT_FILE_MODE });
  }
}

// A synchronous file sink: one validated record per line. appendAudit
// refuses async sinks, so the append completes before emitAudit returns.
function createLedgerSink(dir: string): AuditSink {
  const bridge = createNodeFileBridge(dir);
  return {
    name: `file:${join(dir, AUDIT_LEDGER_FILE)}`,
    kind: 'file',
    write: (record: OrgAuditRecord): void => {
      appendAuditLine(bridge, AUDIT_LEDGER_FILE, record);
    },
  };
}

function isOrgAuditRecord(value: unknown): value is OrgAuditRecord {
  if (value === null || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.who === 'string' &&
    typeof record.what === 'string' &&
    typeof record.when === 'string' &&
    typeof record.posture === 'string' &&
    (record.result === 'ok' ||
      record.result === 'deny' ||
      record.result === 'error')
  );
}

// A ledger that exists but cannot be read (permission denied, a directory in
// its place, an I/O error) — named, so `kubic audit` never reports it as an
// empty trail.
class AuditLedgerReadError extends Error {
  readonly path: string;
  constructor(path: string, cause: unknown) {
    super(
      `cannot read the audit ledger ${path}: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
    this.name = 'AuditLedgerReadError';
    this.path = path;
  }
}

// Every audit record in the ledger, oldest first. A missing ledger (ENOENT) is
// an empty trail; any other read failure throws AuditLedgerReadError. A torn
// or foreign line (e.g. a pre-unification router event) is skipped, never
// guessed into a record. A record of another version (or with no version
// marker) is refused by name: an audit trail is never read past a record it
// cannot interpret.
export function readAuditLedger(dir: string): OrgAuditRecord[] {
  const path = join(dir, AUDIT_LEDGER_FILE);
  const bridge = createNodeFileBridge(dir);
  let text: string;
  try {
    text = bridge.readTextFile(AUDIT_LEDGER_FILE);
  } catch (error) {
    if ((error as { code?: unknown }).code === 'ENOENT') return [];
    throw new AuditLedgerReadError(path, error);
  }
  const records: OrgAuditRecord[] = [];
  text.split('\n').forEach((line, index) => {
    if (line.trim() === '') return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      return; // Torn line: skipped.
    }
    if (!isOrgAuditRecord(parsed)) return;
    if (parsed.version !== AUDIT_RECORD_VERSION) {
      throw new AuditLedgerReadError(
        path,
        new Error(
          `line ${index + 1} is not a version ${AUDIT_RECORD_VERSION} audit record`,
        ),
      );
    }
    records.push(parsed);
  });
  return records;
}

export type AuditSinkLevel = 'privileged' | 'all';

export interface ConfiguredAuditSink {
  sink: AuditSink;
  level: AuditSinkLevel;
  // The `[[audit]]` table this sink was built from (`audit[1]`), naming
  // the source in sink-failure notes and the doctor report.
  source: string;
  failures: string[];
  stderrNoted: boolean;
}

// The process's configured `[[audit]]` sinks: empty means the
// repo ledger only (current behavior). The composition root sets them once
// per process from the loaded config; tests reset with `setAuditSinks([])`.
let configuredAuditSinks: ConfiguredAuditSink[] = [];

export function setAuditSinks(sinks: ConfiguredAuditSink[]): void {
  configuredAuditSinks = [...sinks];
}

// A read-only snapshot for the doctor probe: the configured sources and
// the failures they recorded this process.
export function auditSinkSnapshot(): ReadonlyArray<{
  source: string;
  kind: string;
  name: string;
  level: AuditSinkLevel;
  failures: readonly string[];
}> {
  return configuredAuditSinks.map((entry) => ({
    source: entry.source,
    kind: entry.sink.kind,
    name: entry.sink.name,
    level: entry.level,
    failures: [...entry.failures],
  }));
}

export function probeMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function redactLeaves(value: unknown): unknown {
  if (typeof value === 'string') return redactSecretShapes(value);
  if (Array.isArray(value)) return value.map(redactLeaves);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, leaf]) => [key, redactLeaves(leaf)]),
    );
  }
  return value;
}

function redactInput(input: AuditInput): AuditInput {
  return redactLeaves(input) as AuditInput;
}

// Emit one record to the repo ledger. An audit failure never decides the
// action (the decision already happened); it is reported on `onError`.
export function appendToLedger(
  dir: string,
  input: AuditInput,
  onError: (message: string) => void = () => undefined,
  secrets: readonly string[] = [],
): OrgAuditRecord | undefined {
  try {
    // emitAudit refuses a record carrying secret-shaped material. A decision
    // must not vanish because a free-text field (a deny reason echoing a
    // command) looked like a secret, so every string leaf is redacted first:
    // the record survives, the material never reaches the ledger.
    // `secrets` (live values) make emitAudit refuse a record carrying one —
    // but only values long enough to be matched as a substring: a short or
    // dummy key (`gw`, `ollama` for provider `ollama`) is a word the record
    // legitimately carries, and refusing over it silently dropped the
    // credential-use row.
    // Configured `[[audit]]` sinks fan out beside the repo
    // ledger, which always leads and is mandatory: the `what` is checked
    // pre-redaction (a redacted `what` would never match the level filter).
    // A configured sink's failure is recorded on its entry and noted on
    // `onError` ONCE per process per sink — then swallowed, so a dead
    // syslog never blocks the repo write (or the action). A failure the
    // transport reported asynchronously, after an earlier record, is noted
    // with the next one. A repo-ledger failure still throws below and
    // reaches `onError` every time.
    const privileged = isPrivilegedAuditWhat(input.what);
    const sinks: AuditSink[] = [createLedgerSink(dir)];
    for (const entry of configuredAuditSinks) {
      if (entry.level === 'privileged' && !privileged) continue;
      const configured = entry.sink;
      sinks.push({
        name: configured.name,
        kind: configured.kind,
        write: (record: OrgAuditRecord): void => {
          try {
            configured.write(record);
          } catch (error) {
            entry.failures.push(probeMessage(error));
          }
          const last = entry.failures[entry.failures.length - 1];
          if (last !== undefined && !entry.stderrNoted) {
            entry.stderrNoted = true;
            onError(`audit sink '${entry.source}' failed: ${last}`);
          }
        },
      });
    }
    return emitAudit(sinks, redactInput(input), {
      secrets: matchableSecrets(secrets),
    });
  } catch (error) {
    onError(error instanceof Error ? error.message : String(error));
    return undefined;
  }
}
