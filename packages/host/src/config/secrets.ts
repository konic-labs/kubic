// Request-time secrets (issue #38; design §36).
// Secrets are NEVER in config/trajectory/log: models.json holds refs only
// ($ENV_VAR, !command, escaped literals), resolved at request time with one
// audit event per use. Tool credentials travel as budget-bounded
// ScopedTokens revoked at settle/exit; substitution is host-restricted.
// Agent processes see allowlist env ∪ their role creds — no ambient leak.
//
// Zero network, zero real processes here: command execution is injected by
// the host composition root (faux in tests). Never imports worker impl.

import type { FileBridge } from '../../../exec/src/file-bridge.js';

export const REDACTED = '[REDACTED]';

export class SecretError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SecretError';
  }
}

export type SecretRef =
  | { kind: 'env'; name: string; raw: string }
  | { kind: 'command'; argv: string[]; raw: string }
  | { kind: 'literal'; value: string };

const ENV_REF = /^\$([A-Za-z_][A-Za-z0-9_]*)$/;

// models.json secret forms: $ENV_VAR, !command args (no TTL — always
// re-run), \$escaped / \!escaped literals, anything else literal.
export function parseSecretRef(raw: unknown): SecretRef {
  if (typeof raw !== 'string') {
    throw new SecretError(
      `secret ref must be a string (got ${raw === null ? 'null' : typeof raw})`,
    );
  }
  if (raw.startsWith('\\') && (raw[1] === '$' || raw[1] === '!')) {
    return { kind: 'literal', value: raw.slice(1) };
  }
  const env = ENV_REF.exec(raw);
  if (env) return { kind: 'env', name: env[1] as string, raw };
  if (raw.startsWith('!')) {
    const argv = raw
      .slice(1)
      .trim()
      .split(/\s+/)
      .filter((part) => part !== '');
    if (argv.length === 0) throw new SecretError('empty !command secret ref');
    return { kind: 'command', argv, raw };
  }
  return { kind: 'literal', value: raw };
}

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
export interface ModelKeyUse {
  provider: string;
  envVar: string;
  readEnv: (name: string) => Promise<string | undefined>;
}

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
}): ModelKeyResolver {
  const live = new Set<string>();
  return {
    resolve: async (use) => {
      const value = await use.readEnv(use.envVar);
      if (value === undefined || value === '') return undefined;
      // Registered BEFORE the audit event fires: a failure of that very
      // append (an error message naming a path, a sink's own text) must
      // already be redactable on the first use — not only from the second
      // (issue #359).
      live.add(value);
      const resolved = await resolveSecretRef(
        parseSecretRef(`$${use.envVar}`),
        {
          env: { [use.envVar]: value },
          runCommand: () => {
            throw new SecretError('apiKeyEnv never runs a command');
          },
          audit: (event) => options.audit({ ...event, provider: use.provider }),
          ...(options.now === undefined ? {} : { now: options.now }),
        },
        { role: options.role, purpose: `model-request:${use.provider}` },
      );
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

export function containsPlaintextSecret(
  text: string,
  secrets: readonly string[],
): boolean {
  return matchableSecrets(secrets).some((secret) => text.includes(secret));
}

export function assertNoPlaintextSecrets(
  entries: readonly string[],
  secrets: readonly string[],
): void {
  entries.forEach((entry, index) => {
    if (containsPlaintextSecret(entry, secrets)) {
      throw new SecretError(
        `plaintext secret in entry ${index} (redact before config/trajectory/log)`,
      );
    }
  });
}

export interface ScopedToken {
  readonly expiresAt: number;
  readonly hosts: string[];
  readonly maxUses: number;
  remainingUses: number;
  revoked: boolean;
  revoke(): void;
}

// The live secret is held in this module-private WeakMap, never assigned
// onto the token object: holding a ScopedToken grants no read access —
// property reads, spreads, and JSON cannot reach it. Only
// useScopedToken/substituteTokenHost resolve the value, enforcing
// revocation + expiry + host binding + budget in that order.
const tokenSecrets = new WeakMap<ScopedToken, string>();

// Brokered tool credential: budget-bounded (maxUses), host-bound, expiring.
// The secret is readable only via useScopedToken/substituteTokenHost, which
// enforce revocation + expiry + host binding + budget in that order.
export function issueScopedToken(
  secret: string,
  opts: { ttlMs: number; hosts: string[]; maxUses: number; now?: number },
): ScopedToken {
  if (opts.hosts.length === 0) {
    throw new SecretError('scoped token requires at least one host');
  }
  if (!Number.isInteger(opts.maxUses) || opts.maxUses < 1) {
    throw new SecretError('scoped token maxUses must be a positive integer');
  }
  const issuedAt = opts.now ?? Date.now();
  const token: ScopedToken = {
    expiresAt: issuedAt + opts.ttlMs,
    hosts: [...opts.hosts],
    maxUses: opts.maxUses,
    remainingUses: opts.maxUses,
    revoked: false,
    revoke: (): void => {
      token.revoked = true;
    },
  };
  tokenSecrets.set(token, secret);
  return token;
}

export function useScopedToken(
  token: ScopedToken,
  host: string,
  now: number = Date.now(),
): string {
  if (token.revoked) throw new SecretError('scoped token revoked');
  if (now >= token.expiresAt) throw new SecretError('scoped token expired');
  if (!token.hosts.includes(host)) {
    throw new SecretError(`scoped token not bound to host '${host}'`);
  }
  if (token.remainingUses < 1) {
    throw new SecretError('scoped token budget exhausted');
  }
  const secret = tokenSecrets.get(token);
  if (secret === undefined) {
    throw new SecretError('scoped token revoked');
  }
  token.remainingUses -= 1;
  return secret;
}

// Host-substitution (e.g. registry URLs) is host-restricted: the target
// host must be inside the token binding, and the use consumes budget.
export function substituteTokenHost(
  template: string,
  placeholder: string,
  token: ScopedToken,
  host: string,
  now: number = Date.now(),
): string {
  if (!template.includes(placeholder)) {
    throw new SecretError('token placeholder not found in template');
  }
  const value = useScopedToken(token, host, now);
  return template.split(placeholder).join(value);
}

// Settle/exit path: revoke every outstanding token for the run.
export function revokeAllTokens(tokens: readonly ScopedToken[]): void {
  for (const token of tokens) token.revoke();
}
