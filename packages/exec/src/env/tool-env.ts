// The environment a tool child process gets: an allowlist of the caller's
// variables, with secrets and proxy credentials left out.
import { isSecretEnvKey } from '@kubic/core/secret-keys';

// "never inherit ambient authority": every child the exec seam spawns
// (the bash tool, host git calls) starts from this allowlist, never from
// kubic's whole environment — a provider API key in the parent must not be
// one `echo $X` away from the model. It carries the POSIX session basics a
// shell tool needs. No SSH_AUTH_SOCK / credential helpers: those are
// authority, not environment.
const TOOL_ENV_ALLOWLIST: readonly string[] = [
  'PATH',
  'HOME',
  'USER',
  'LOGNAME',
  'SHELL',
  'TERM',
  'LANG',
  'TMPDIR',
  'TZ',
  'CI',
  'NO_COLOR',
  'CLICOLOR',
  // Git behavior, not authority: a user who turns off system git config
  // wants every spawned git child (tools and tests) to honor it.
  'GIT_CONFIG_NOSYSTEM',
  // Network reachability and trust roots (not credentials): tools behind
  // a corporate proxy or custom CA must keep working. Both spellings of
  // the proxy vars are conventional — and their VALUES are scrubbed of
  // userinfo before they reach a child: a proxy URL's
  // `user:password@` is a credential the name does not reveal.
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'NO_PROXY',
  'http_proxy',
  'https_proxy',
  'no_proxy',
  'NODE_EXTRA_CA_CERTS',
  'SSL_CERT_FILE',
  'SSL_CERT_DIR',
  // Windows process basics (keys compared case-insensitively there).
  'SYSTEMROOT',
  'COMSPEC',
  'PATHEXT',
  'TEMP',
  'TMP',
  'USERPROFILE',
  'APPDATA',
  'LOCALAPPDATA',
  'WINDIR',
  'PROGRAMFILES',
  'PROGRAMFILES(X86)',
];

const ALLOWED_UPPER = new Set(TOOL_ENV_ALLOWLIST.map((k) => k.toUpperCase()));

// The proxy variables are allowlisted for reachability, but a
// proxy URL can carry userinfo — `http://user:password@proxy:3128` — which is
// a credential even though the NAME looks benign, so the secret-name check never sees
// it. A credential must never reach an agent-visible string, and the model's
// shell can read the child env. The
// value keeps its scheme, host and port and loses the userinfo; a proxy that
// REQUIRES that auth is therefore not usable from a tool child (Kubic does
// not broker proxy auth — see docs/architecture/journal-and-safety.md).
// Queried with the upper-cased key (Windows matches case-insensitively), so
// the set holds the upper-case names only.
const PROXY_VARS = new Set(['HTTP_PROXY', 'HTTPS_PROXY']);

// The value without its userinfo: scheme and everything from the host on
// survive verbatim, so no URL parser normalization (a trailing slash, a
// lower-cased host) creeps into a value other tools must match byte for byte.
// The scheme is anchored at position 0: searching the whole value for '://'
// let a scheme-less value whose PATH contains '://' slice the authority out
// of the path and return the credential untouched. The
// strip assumes a valid URL-shaped value; a raw '/' inside malformed
// userinfo still ends the authority early, exactly as `urlsplit` would.
const SCHEME_AT_START = /^[A-Za-z][A-Za-z0-9+.-]*:\/\//;

function stripProxyUserinfo(value: string): string {
  const scheme = SCHEME_AT_START.exec(value);
  const start = scheme === null ? 0 : scheme[0].length;
  let end = value.length;
  for (const separator of ['/', '?', '#']) {
    const at = value.indexOf(separator, start);
    if (at !== -1 && at < end) end = at;
  }
  const authority = value.slice(start, end);
  // The LAST '@' in the authority is the userinfo separator (an earlier one
  // belongs to percent-encoded userinfo).
  const at = authority.lastIndexOf('@');
  if (at === -1) return value;
  return `${value.slice(0, start)}${authority.slice(at + 1)}${value.slice(end)}`;
}

// Pure: the allowlisted subset of `base` (plus LC_* / XDG_* vars). A
// secret-shaped name is dropped even if it matches a pattern (LC_*_KEY), and
// a proxy URL loses its userinfo — the one credential an
// allowlisted NAME could hide.
export function toolSpawnEnv(
  base: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(base)) {
    if (value === undefined) continue;
    const upper = key.toUpperCase();
    const allowed =
      (process.platform === 'win32'
        ? ALLOWED_UPPER.has(upper)
        : TOOL_ENV_ALLOWLIST.includes(key)) ||
      key.startsWith('LC_') ||
      key.startsWith('XDG_');
    if (!allowed || isSecretEnvKey(key)) continue;
    out[key] = PROXY_VARS.has(upper) ? stripProxyUserinfo(value) : value;
  }
  return out;
}
