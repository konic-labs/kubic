// Request-time secrets (issue #38; design §36).
// Secrets are NEVER in config/trajectory/log: models.json holds refs only
// ($ENV_VAR, !command, escaped literals), resolved at request time with one
// audit event per use.
//
// Zero network, zero real processes here: command execution is injected by
// the host composition root (faux in tests). Never imports worker impl.

import {
  type SecretRef as CoreSecretRef,
  SecretRefError as CoreSecretRefError,
  parseSecretRef as parseCoreSecretRef,
} from '../../../core/src/secret-refs.js';
import type { FileBridge } from '../../../exec/src/file-bridge.js';
import { SecretCommandError } from '../../../exec/src/secret-runner.js';

export const REDACTED = '[REDACTED]';

export class SecretError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SecretError';
  }
}

export type SecretRef = CoreSecretRef;

// The parse table lives in @kubic/core (issue #224) so the worker's
// models.json parser shares it — same direction as secret-shapes.ts. Kept
// as a same-path export so the host call sites, the tests and the
// export-surface gate do not move; core refusals cross the package edge as
// SecretError with the message intact (the name is pinned).
export const parseSecretRef = (raw: unknown): SecretRef => {
  try {
    return parseCoreSecretRef(raw);
  } catch (error) {
    if (error instanceof CoreSecretRefError) {
      throw new SecretError(error.message);
    }
    throw error;
  }
};

export interface SecretAuditEvent {
  ref: string;
  role: string;
  purpose: string;
  at: string;
}

export interface SecretResolverDeps {
  env: Record<string, string | undefined>;
  runCommand: (argv: string[]) => string | Promise<string>;
  audit: (event: SecretAuditEvent) => void;
  now?: () => number;
}

// Request-time resolve: every call re-resolves (commands have no TTL) and
// appends exactly one audit event. Fails closed on missing/empty secrets.
export async function resolveSecretRef(
  ref: SecretRef,
  deps: SecretResolverDeps,
  ctx: { role: string; purpose: string },
): Promise<string> {
  let value: string;
  let auditRef: string;
  if (ref.kind === 'env') {
    const hit = deps.env[ref.name];
    if (hit === undefined || hit === '') {
      throw new SecretError(`missing env secret: ${ref.name}`);
    }
    value = hit;
    auditRef = ref.raw;
  } else if (ref.kind === 'command') {
    const out = String(await deps.runCommand(ref.argv)).replace(/\r?\n$/, '');
    if (out === '') {
      throw new SecretError(
        `empty output from secret command: ${ref.argv.join(' ')}`,
      );
    }
    value = out;
    auditRef = ref.raw;
  } else {
    value = ref.value;
    auditRef = '[literal]';
  }
  deps.audit({
    ref: auditRef,
    role: ctx.role,
    purpose: ctx.purpose,
    at: new Date(deps.now?.() ?? Date.now()).toISOString(),
  });
  return value;
}

// The models.json provider-key resolver (issue #359; §36.1 rules 3-4): the
// provider's `apiKeyEnv` IS a `$ENV` ref, resolved through resolveSecretRef
// at every request (Pi calls it per request), emitting exactly one audit
// event per use — ref, role, purpose, never the value. Every resolved value
// is remembered in `live` so the persistence paths can redact it.
//
// Issue #224 widens the use to a parsed secret ref: an explicit `$VAR` /
// `!command` ref fails closed (a missing variable or failed command
// rejects, naming it), while the legacy `apiKeyEnv` name keeps its pinned
// skip — a missing variable leaves the provider unconfigured. The shapes
// are told apart by field (`envVar` vs `ref`); a literal never reaches the
// resolver (literals touch no env, runner, audit, or inventory).
export type ModelKeyUse =
  | {
      provider: string;
      envVar: string;
      readEnv: (name: string) => Promise<string | undefined>;
    }
  | {
      provider: string;
      ref: SecretRef;
      readEnv: (name: string) => Promise<string | undefined>;
    };

export interface ModelKeyResolver {
  resolve: (use: ModelKeyUse) => Promise<string | undefined>;
  /** Every value resolved so far, for redactSecretValues. */
  live: () => string[];
}

export function createModelKeyResolver(options: {
  role: string;
  audit: (event: SecretAuditEvent & { provider: string }) => void;
  now?: () => number;
  /**
   * The run's provider and model ids (issue #359). A resolved value that is —
   * or sits inside — one of them is identity, not a secret (LM Studio's
   * documented dummy key is its own provider name), so `live()` leaves it
   * out and nothing scrubs or refuses on it.
   */
  identity?: () => readonly string[];
  /**
   * Runs a `!command` secret ref (issue #224): invoked with the parsed argv
   * on every command-ref resolve — rerun per request, never cached. Absent,
   * a command ref is a named refusal (fail closed, never a silent drop).
   */
  runCommand?: (argv: string[]) => string | Promise<string>;
}): ModelKeyResolver {
  const live = new Set<string>();
  const audit = (event: SecretAuditEvent, provider: string): void => {
    options.audit({ ...event, provider });
  };
  const context = (provider: string): { role: string; purpose: string } => ({
    role: options.role,
    purpose: `model-request:${provider}`,
  });
  const base = {
    runCommand: () => {
      throw new SecretError('apiKeyEnv never runs a command');
    },
    ...(options.now === undefined ? {} : { now: options.now }),
  };
  return {
    resolve: async (use) => {
      // The legacy name (pinned skip): a missing variable is not a use.
      if ('envVar' in use) {
        const value = await use.readEnv(use.envVar);
        if (value === undefined || value === '') return undefined;
        // Registered BEFORE the audit event fires: a failure of that very
        // append (an error message naming a path, a sink's own text) must
        // already be redactable on the first use — not only from the second
        // (issue #359).
        live.add(value);
        return resolveSecretRef(
          parseSecretRef(`$${use.envVar}`),
          {
            ...base,
            env: { [use.envVar]: value },
            audit: (event) => audit(event, use.provider),
          },
          context(use.provider),
        );
      }
      // Explicit refs fail closed instead (issue #224). Refusals name the
      // provider as well as the ref: in a multi-provider run the error
      // must say whose command or variable failed.
      const ref = use.ref;
      if (ref.kind === 'literal') {
        throw new SecretError(
          'model key resolution needs an env or command ref',
        );
      }
      const fail = (message: string): SecretError =>
        new SecretError(`provider '${use.provider}': ${message}`);
      if (ref.kind === 'env') {
        const value = await use.readEnv(ref.name);
        if (value === undefined || value === '') {
          throw fail(`missing env secret: ${ref.name}`);
        }
        live.add(value);
        return resolveSecretRef(
          ref,
          {
            ...base,
            env: { [ref.name]: value },
            audit: (event) => audit(event, use.provider),
          },
          context(use.provider),
        );
      }
      const runCommand =
        options.runCommand ??
        (() => {
          throw new SecretError('no secret-command runner');
        });
      let resolved: string;
      try {
        resolved = await resolveSecretRef(
          ref,
          {
            ...base,
            env: {},
            runCommand,
            audit: (event) => audit(event, use.provider),
          },
          context(use.provider),
        );
      } catch (error) {
        // Runner failures carry their own message (naming the command) but
        // no provider — without it a multi-provider run cannot say whose
        // credential failed. SecretError refusals keep their name.
        if (error instanceof SecretError || error instanceof SecretCommandError)
          throw fail(error.message);
        throw fail(
          `secret command failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      // Post-add: the value is unknowable before the run. The audited event
      // carries the ref, never the value, so nothing in it needs redacting.
      live.add(resolved);
      return resolved;
    },
    live: () => {
      const values = [...live];
      return values.length === 0
        ? values
        : withoutIdentity(values, options.identity?.() ?? []);
    },
  };
}

// The values that are not identity (issue #359): a live value equal to, or
// contained in, an identity word (a provider or model id), compared
// case-insensitively, is a name the run legitimately carries everywhere —
// scrubbing it rewrites the envelope and the session rows, refusing on it
// drops the credential-use row that names the provider. A value that merely
// CONTAINS an identity word (a real key that starts with the provider's
// name) is still a secret.
export function withoutIdentity(
  secrets: readonly string[],
  identity: readonly string[],
): string[] {
  const words = identity
    .map((word) => word.toLowerCase())
    .filter((word) => word !== '');
  return secrets.filter((secret) => {
    const value = secret.toLowerCase();
    return !words.some((word) => word.includes(value));
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// The shortest live value matched as a SUBSTRING (issue #359): the debug and
// persistence redaction and the §60 ledger refusal all search text for the
// resolved values, and a short or dummy key (`gw`, `solo`, `1`, a key named
// like its provider) would blank every word it spells and refuse the
// credential-use row that names the provider. Real provider keys are far
// longer; below this length a value is not matched at all.
export const MIN_MATCHABLE_SECRET_LENGTH = 8;

// The inventory the substring paths may search for.
export function matchableSecrets(secrets: readonly string[]): string[] {
  return secrets.filter(
    (secret) => secret.length >= MIN_MATCHABLE_SECRET_LENGTH,
  );
}

// Deep-redact every occurrence of live secret values (config, trajectory,
// and log payloads pass through this before persistence).
export function redactSecretValues(
  value: unknown,
  secrets: readonly string[],
): unknown {
  // Longest first: one value can be the prefix of another form of itself (a
  // key ending in `\` and its JSON-escaped `\\`), and replacing the short
  // form first would leave the tail of the long one behind.
  const live = matchableSecrets(secrets).sort((a, b) => b.length - a.length);
  if (typeof value === 'string') {
    let out = value;
    for (const secret of live) {
      if (out.includes(secret)) out = out.split(secret).join(REDACTED);
    }
    return out;
  }
  if (Array.isArray(value)) {
    return value.map((item) => redactSecretValues(item, secrets));
  }
  if (isRecord(value)) {
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      out[key] = redactSecretValues(entry, secrets);
    }
    return out;
  }
  return value;
}

// A line sink that scrubs the live values out of every line before it
// reaches `sink` (issue #359: the debug channel). The inventory is read per
// line — the values are known only once the request-time resolver has run.
export function redactingSink(
  sink: (line: string) => void,
  secrets: () => readonly string[],
): (line: string) => void {
  return (line) => sink(String(redactSecretValues(line, secrets())));
}

// The session/trajectory persistence choke point (issue #359): a FileBridge
// whose text writes and appends scrub the live values first, so a provider
// echoing a key in an error body (or a tool printing one) cannot land in the
// session JSONL. Strings inside JSONL are JSON-escaped, so each value is also
// matched in that form. Reads and binary writes pass through untouched.
export function redactBridgeWrites(
  bridge: FileBridge,
  secrets: () => readonly string[],
): FileBridge {
  const scrub = (content: string | Uint8Array): string | Uint8Array => {
    if (typeof content !== 'string') return content;
    const live = matchableSecrets(secrets());
    if (live.length === 0) return content;
    const escaped = live.map((secret) => JSON.stringify(secret).slice(1, -1));
    return String(redactSecretValues(content, [...live, ...escaped]));
  };
  const durable = bridge.appendDurably?.bind(bridge);
  return {
    ...bridge,
    writeFile: (path, content, options) =>
      bridge.writeFile(path, scrub(content), options),
    appendFile: (path, content) => bridge.appendFile(path, scrub(content)),
    ...(durable === undefined
      ? {}
      : {
          appendDurably: (path: string, content: string | Uint8Array) =>
            durable(path, scrub(content)),
        }),
  };
}
