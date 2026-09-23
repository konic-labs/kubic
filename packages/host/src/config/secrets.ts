// Request-time secrets (issue #38; design §36).
// Secrets are NEVER in config/trajectory/log: models.json holds refs only
// ($ENV_VAR, !command, escaped literals), resolved at request time with one
// audit event per use. Tool credentials travel as budget-bounded
// ScopedTokens revoked at settle/exit; substitution is host-restricted.
// Agent processes see allowlist env ∪ their role creds — no ambient leak.
//
// Zero network, zero real processes here: command execution is injected by
// the host composition root (faux in tests). Never imports worker impl.

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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// Deep-redact every occurrence of live secret values (config, trajectory,
// and log payloads pass through this before persistence).
export function redactSecretValues(
  value: unknown,
  secrets: readonly string[],
): unknown {
  const live = secrets.filter((secret) => secret !== '');
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

export function containsPlaintextSecret(
  text: string,
  secrets: readonly string[],
): boolean {
  return secrets.some((secret) => secret !== '' && text.includes(secret));
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

export interface RoleCredentialSet {
  role: string;
  version: number;
  tokens: Record<string, ScopedToken>;
}

// Per-role injection: a worker receives ONLY its role's credentials as
// fresh tokens. A version bump re-resolves (never inherits another role's
// or a previous version's tokens).
export function resolveRoleCredentials(
  role: string,
  entries: Record<string, string>,
  opts: {
    version: number;
    ttlMs: number;
    hosts: string[];
    maxUses: number;
    now?: number;
  },
): RoleCredentialSet {
  const tokens: Record<string, ScopedToken> = {};
  for (const [name, secret] of Object.entries(entries)) {
    tokens[name] = issueScopedToken(secret, opts);
  }
  return { role, version: opts.version, tokens };
}

// Agent processes see the fixed allowlist plus their role credentials —
// ambient process env is never inherited wholesale.
export const AGENT_ENV_ALLOWLIST = [
  'PATH',
  'HOME',
  'TERM',
  'LANG',
  'TZ',
  'TMPDIR',
] as const;

export function buildAgentEnv(
  baseEnv: Record<string, string | undefined>,
  allowlist: readonly string[],
  roleSecrets: Record<string, string>,
): Record<string, string> {
  const allowed = new Set(allowlist);
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(baseEnv)) {
    if (allowed.has(key) && value !== undefined) out[key] = value;
  }
  for (const [key, value] of Object.entries(roleSecrets)) out[key] = value;
  return out;
}
