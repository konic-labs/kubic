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

import { join, resolve } from 'node:path';
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
  return join(resolve(home), '.kubic', 'trust.json');
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
    const raw = this.readText();
    if (raw === undefined) return null;
    let entries: Record<string, boolean | null>;
    try {
      entries = parseTrustFile(raw, this.file);
    } catch {
      return null;
    }
    const value = entries[canonicalTrustPath(cwd)];
    return value === true || value === false ? value : null;
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
  // store: the operator asked to see the records, so silence would lie.
  entries(): ProjectTrustEntry[] {
    const raw = this.readText();
    const parsed = raw === undefined ? {} : parseTrustFile(raw, this.file);
    const out: ProjectTrustEntry[] = [];
    for (const [path, value] of Object.entries(parsed)) {
      if (value === true || value === false)
        out.push({ path, decision: value });
    }
    out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    return out;
  }

  private readText(): string | undefined {
    if (!BRIDGE.exists(this.file)) return undefined;
    try {
      return BRIDGE.readTextFile(this.file);
    } catch {
      return undefined;
    }
  }
}

function envFlag(raw: string | undefined): boolean {
  return raw === '1' || raw === 'true';
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
  const home = resolve(inputs.home);
  const store =
    inputs.store ?? new ProjectTrustStore(projectTrustStorePath(home));
  const decision = store.get(inputs.cwd);
  const envTrust = envFlag(inputs.env?.[RUNTIME_ENV_OVERRIDES.trustProject]);
  const root = resolve(inputs.cwd);
  const configPath = join(root, '.kubic', 'config.toml');
  return {
    home,
    key: canonicalTrustPath(inputs.cwd),
    configPath,
    present: BRIDGE.exists(configPath),
    decision,
    envTrust,
    trusted: decision === true || envTrust,
    storePath: store.file,
  };
}
