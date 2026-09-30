// Persistent project-trust store (issue #228; design §35.1).
//
// Trust for a project-local layer is a user decision, not a per-invocation
// env export: this module is the durable half — one JSON file under
// `~/.kubic/`, keyed by the canonical project path, holding `true`
// (trusted) or `false` (declined). An absent key means "no decision yet".
//
// Two rules the design names explicitly:
//
//   exact path    — a decision for one directory is never inherited by its
//                   children and never leaks to a sibling (`/a` does not
//                   trust `/a-sibling`). No ancestor walk, unlike Pi's
//                   trust-manager.
//   canonical key — symlinked paths and their targets are one project, so
//                   the key is the realpath when it exists.
//
// Fail-closed posture: a missing, unreadable or corrupt store reads as "no
// decision" — every consuming command then refuses the project layer by
// name instead of running on it. Mutations and listing name the broken file
// (`TrustStoreError`) rather than silently overwriting user data; the
// operator fixes or deletes the file and runs `kubic trust` again.
//
// File access: the exec FileBridge (I/O confinement — this module never
// imports node:fs) and its locked tmp+rename update, so a concurrent
// grant/revoke can never leave a half-written store.

import { isAbsolute, join, resolve } from 'node:path';
import {
  createNodeFileBridge,
  updateFileLocked,
} from '../../../exec/src/file-bridge.js';
import { RUNTIME_ENV_OVERRIDES } from './runtime.js';

// A recorded decision: true (trusted), false (declined), or null (no
// decision recorded — the store never persists this).
export type ProjectTrustDecision = boolean | null;

// One recorded boolean decision, for `kubic trust --list`.
export interface ProjectTrustEntry {
  readonly path: string;
  readonly decision: boolean;
}

// The trust state of one project directory, as the commands report it.
export interface ProjectTrustReport {
  // The home directory whose `.kubic/trust.json` was consulted.
  readonly home: string;
  // Canonical path the decision is keyed to.
  readonly key: string;
  // The gated project config (`<cwd>/.kubic/config.toml`).
  readonly configPath: string;
  // Whether that file exists (an absent file needs no trust).
  readonly present: boolean;
  // The recorded decision, exactly as stored.
  readonly decision: ProjectTrustDecision;
  // KUBIC_TRUST_PROJECT=1/true in the process env.
  readonly envTrust: boolean;
  // The effective gate: a recorded true or the env opt-in.
  readonly trusted: boolean;
  readonly storePath: string;
  // Present when the store file exists but could not be read or parsed
  // (issue #228 review): reads stay fail-closed (no decision), and the
  // report names the file instead of implying the user never decided.
  readonly storeError?: string;
}

// A broken store file, named by path — never silently replaced.
export class TrustStoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TrustStoreError';
  }
}

const BRIDGE = createNodeFileBridge('/');

// The report for a directory with no project config and no recorded
// decision. Exported for callers that build a `CliConfigResult` without
// touching the store (test fixtures, programmatic loads): the conservative
// shape keeps every consumer fail-closed, never `undefined`.
export const NO_PROJECT_TRUST: ProjectTrustReport = {
  home: '',
  key: '',
  configPath: '',
  present: false,
  decision: null,
  envTrust: false,
  trusted: false,
  storePath: '',
};

export function projectTrustStorePath(home: string): string {
  return join(requireHome(home), '.kubic', 'trust.json');
}

// The trust store lives under the user's home and nowhere else (issue #228
// review): an empty or relative home would resolve against the process cwd
// and put the store inside the project it is meant to gate — a repository
// could then ship its own decision. Refused by name; `loadCliConfig` turns
// the refusal into a named config error.
function requireHome(home: string): string {
  if (home === '' || !isAbsolute(home)) {
    throw new TrustStoreError(
      `project trust needs an absolute home directory, got ${JSON.stringify(home)} — the store cannot live inside the project`,
    );
  }
  return resolve(home);
}

// The key a decision is recorded under: the realpath when the path exists,
// the absolute path otherwise (a project dir may be recorded before it
// exists). Never walks up.
export function canonicalTrustPath(path: string): string {
  const absolute = resolve(path);
  try {
    return BRIDGE.realPath?.(absolute) ?? absolute;
  } catch {
    return absolute;
  }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// The store's wire shape: canonical path → true | false | null. `null` is
// accepted (Pi's vocabulary) and read as "no decision"; it is never
// written — removing a key IS the null decision.
function parseTrustFile(
  text: string,
  path: string,
): Record<string, boolean | null> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new TrustStoreError(
      `trust store ${path} is not valid JSON: ${message(error)} — fix or delete the file, then run 'kubic trust' again`,
    );
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new TrustStoreError(
      `trust store ${path} must be a JSON object of canonical path → true|false|null`,
    );
  }
  // null-prototype: a store key can be any canonical path, and a plain
  // object would silently swallow a JSON `"__proto__"` key into the
  // prototype instead of an own entry (the repo's prototype-pollution
  // posture).
  const entries = Object.create(null) as Record<string, boolean | null>;
  for (const [key, value] of Object.entries(parsed)) {
    if (value !== true && value !== false && value !== null) {
      throw new TrustStoreError(
        `trust store ${path} has an invalid decision for ${JSON.stringify(key)}: expected true, false or null`,
      );
    }
    entries[key] = value;
  }
  return entries;
}

// Stable, human-readable file: sorted keys, two-space JSON, trailing
// newline — a diff of two grants stays minimal.
function serializeTrustFile(entries: Record<string, boolean | null>): string {
  const sorted = Object.create(null) as Record<string, boolean>;
  for (const key of Object.keys(entries).sort()) {
    const value = entries[key];
    if (value === true || value === false) sorted[key] = value;
  }
  return `${JSON.stringify(sorted, null, 2)}\n`;
}

export class ProjectTrustStore {
  readonly file: string;

  constructor(file: string) {
    this.file = file;
  }

  // The decision for `cwd`; null when absent or when the store cannot be
  // read (fail closed — the caller refuses the project layer by name).
  get(cwd: string): ProjectTrustDecision {
    const read = this.readStore();
    return read.kind === 'entries' ? decisionOf(read.entries, cwd) : null;
  }

  // As `get`, plus the reason when the store exists but could not be used
  // (issue #228 review): the report and doctor then say "unreadable" or
  // "corrupt" instead of implying the user simply never decided.
  inspect(cwd: string): { decision: ProjectTrustDecision; error?: string } {
    const read = this.readStore();
    if (read.kind === 'unreadable' || read.kind === 'corrupt') {
      return { decision: null, error: read.error };
    }
    return {
      decision: read.kind === 'entries' ? decisionOf(read.entries, cwd) : null,
    };
  }

  // Records `decision`; null removes the entry (revoke). The read → update
  // → tmp+rename write runs under the exec lock, so concurrent grants to
  // different paths never lose an update.
  set(cwd: string, decision: ProjectTrustDecision): void {
    const key = canonicalTrustPath(cwd);
    updateFileLocked(this.file, (current) => {
      const entries =
        current === undefined ? {} : parseTrustFile(current, this.file);
      if (decision === null) delete entries[key];
      else entries[key] = decision;
      return serializeTrustFile(entries);
    });
  }

  // Every recorded boolean decision, sorted by path. Throws on a corrupt
  // store: the operator asked to see the records, so silence would lie. An
  // UNREADABLE store (EACCES/ELOOP) is not a corrupt one — it reads as
  // nothing recorded, never a throw (issue #228 review: `kubic trust` stays
  // the repair path even when the store cannot be read).
  entries(): ProjectTrustEntry[] {
    const read = this.readStore();
    if (read.kind === 'corrupt') throw new TrustStoreError(read.error);
    if (read.kind !== 'entries') return [];
    const out: ProjectTrustEntry[] = [];
    for (const [path, value] of Object.entries(read.entries)) {
      if (value === true || value === false)
        out.push({ path, decision: value });
    }
    out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    return out;
  }

  private readStore(): StoreRead {
    let text: string;
    try {
      if (!BRIDGE.exists(this.file)) return { kind: 'missing' };
      text = BRIDGE.readTextFile(this.file);
    } catch (error) {
      // A race with another writer's rename is "no file yet", not an error.
      if ((error as { code?: unknown } | null)?.code === 'ENOENT') {
        return { kind: 'missing' };
      }
      return { kind: 'unreadable', error: message(error) };
    }
    try {
      return { kind: 'entries', entries: parseTrustFile(text, this.file) };
    } catch (error) {
      return { kind: 'corrupt', error: message(error) };
    }
  }
}

// What one read of the store found. `get` collapses every non-entry outcome
// to "no decision" (fail closed); `inspect` keeps the reason so the report
// and doctor can name it; `entries` names a genuinely corrupt file but
// treats an unreadable one as "nothing recorded".
type StoreRead =
  | { kind: 'missing' }
  | { kind: 'unreadable'; error: string }
  | { kind: 'corrupt'; error: string }
  | { kind: 'entries'; entries: Record<string, boolean | null> };

function decisionOf(
  entries: Record<string, boolean | null>,
  cwd: string,
): ProjectTrustDecision {
  const value = entries[canonicalTrustPath(cwd)];
  return value === true || value === false ? value : null;
}

function envFlag(raw: string | undefined): boolean {
  return raw === '1' || raw === 'true';
}

// A per-path trust check for consumers that resolve the file they load by
// walking ancestors — the project `models.json` root and each skills
// ancestor (issue #228 review). The decision belongs to the tree the file
// lives in: a grant for /repo covers /repo's committed files when a run
// starts in /repo/pkg, while a grant for /repo/pkg never reaches /repo.
// `KUBIC_TRUST_PROJECT=1/true` is a global opt-in above the store.
export type ProjectTrustCheck = (path: string) => boolean;

export function projectTrustCheck(inputs: {
  home: string;
  env?: Record<string, string | undefined>;
  // The already-derived opt-in (the report's `envTrust`): callers holding a
  // report pass it instead of re-reading an env map.
  envTrust?: boolean;
  store?: ProjectTrustStore;
}): ProjectTrustCheck {
  const envTrust =
    inputs.envTrust ??
    envFlag(inputs.env?.[RUNTIME_ENV_OVERRIDES.trustProject]);
  let store = inputs.store;
  if (store === undefined) {
    try {
      store = new ProjectTrustStore(projectTrustStorePath(inputs.home));
    } catch {
      // An unusable home cannot record decisions: fail closed. The config
      // load names the refusal; the env opt-in still applies (it is global,
      // not keyed to a store).
      store = undefined;
    }
  }
  return (path) => envTrust || (store?.get(path) ?? false);
}

// The trust state of one project directory over the store + the documented
// env opt-in — the ONE derivation `kubic config`, `kubic doctor`, the TUI
// prompt and the config load consume, so they can never disagree.
export function projectTrustReport(inputs: {
  home: string;
  cwd: string;
  env?: Record<string, string | undefined>;
  store?: ProjectTrustStore;
}): ProjectTrustReport {
  const home = requireHome(inputs.home);
  const store =
    inputs.store ?? new ProjectTrustStore(projectTrustStorePath(home));
  const inspected = store.inspect(inputs.cwd);
  const envTrust = envFlag(inputs.env?.[RUNTIME_ENV_OVERRIDES.trustProject]);
  const root = resolve(inputs.cwd);
  const configPath = join(root, '.kubic', 'config.toml');
  return {
    home,
    key: canonicalTrustPath(inputs.cwd),
    configPath,
    present: presentFile(configPath),
    decision: inspected.decision,
    envTrust,
    trusted: inspected.decision === true || envTrust,
    storePath: store.file,
    ...(inspected.error === undefined ? {} : { storeError: inspected.error }),
  };
}

// A config-presence probe must never throw the command off its refusal path:
// an unsearchable `.kubic` reads as "not present", and the config load names
// the real failure when it tries the layer itself.
function presentFile(path: string): boolean {
  try {
    return BRIDGE.exists(path);
  } catch {
    return false;
  }
}
