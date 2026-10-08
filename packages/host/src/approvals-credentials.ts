// Credential-path detector (`credentials` class).
//
// The permission classes include `credentials`, whose installed default
// is `none`, and lists "credential access beyond what the role
// declares" as an approval trigger. Until this module there was no detector,
// so the class was informational: `cat ~/.aws/credentials` and a read of a
// committed `.env` ran with no approval. The home paths in a bash command
// are the remaining gap — the read/ls/grep tools are confined to the
// workspace (CONFINED_TOOLS, packages/agent/src/lane/interceptors.ts) — and
// in-workspace credential files are exposed to both the shell and the tools.
//
// Scope and honesty: this is a LEXICAL DETECTOR, not enforcement.
// It pattern-matches the listed locations in a bash command and in the
// read-family tool paths; a raised capability takes the normal ask path
// (denied headless, answered by the user in the TUI) and lands in the audit
// ledger with `trigger:credentials`. It does not open files, follow
// symlinks, expand variables or parse the shell, so a path the list does not
// name, a split or built up token (`p=~/.a; cat ${p}ws/x`), and quoted or
// backslash-obfuscated spellings are not detected — stated limits, exactly
// like the other lexical detectors here. Over-triggering is the safe
// direction and is deliberate: a raised capability becomes an ask, never a
// silent grant, so `*.pem` is flagged whether or not it holds a key and a
// credential-shaped command in an argument list still asks.

// A path prefix the shell would expand to a home directory: `~`, `$HOME`,
// `${HOME}`, `${HOME:-…}` (the same forms HOME_PREFIXED in approvals.ts
// accepts), or an absolute /Users/<user> or /home/<user> path. Lexical, so
// `~user`, `$HOMEDIR` and a `../..`-relative path are not homes here.
const HOME_PREFIX = String.raw`(?:~|\$HOME|\$\{HOME(?::?-[^}]*)?\}|\/Users\/[^\/\s"']+|\/home\/[^\/\s"']+)`;

// The credential locations the list fixes, as the part below the home
// directory. Directory entries match the directory itself and everything
// below it; file entries allow a trailing extension (a copy beside the
// original is the same secret). `~/.ssh` is key material by default: every
// child matches except the known-public files (`known_hosts*`,
// `authorized_keys*`, `*.pub`) — a common key name like `~/.ssh/github` and
// the `~/.ssh/*` glob are both matched. `config`
// stays in, as the pattern list names it; an over-trigger is an ask,
// never a grant.
const HOME_CREDENTIAL_PATHS = [
  String.raw`\.aws(?:\/|(?![-\w]))`,
  String.raw`\.ssh\/(?!known_hosts|authorized_keys)(?![^\/\s"']*\.pub(?![\-\w]))[^\/\s"']+`,
  String.raw`\.config\/gh(?:\/|(?![-\w]))`,
  String.raw`\.config\/gcloud(?:\/|(?![-\w]))`,
  String.raw`\.docker\/config\.json(?![-\w])`,
  String.raw`\.kube\/config(?![-\w])`,
  String.raw`\.netrc(?![-\w])`,
  String.raw`\.npmrc(?![-\w])`,
  String.raw`\.pypirc(?![-\w])`,
  String.raw`\.git-credentials(?![-\w])`,
  String.raw`\.azure(?:\/|(?![-\w]))`,
].join('|');

// Token start: the prefix must not be glued to a longer word. The `i` flag
// folds case, because the default macOS/Windows volumes open `.ENV` and
// `~/.AWS/credentials` exactly like their lower-case spellings — case-sensitive
// matching on a case-insensitive filesystem would be a silent miss, not a
// conservative one.
const HOME_CREDENTIAL = new RegExp(
  String.raw`(?:^|[\s"'=(])` +
    HOME_PREFIX +
    String.raw`\/` +
    String.raw`(?:` +
    HOME_CREDENTIAL_PATHS +
    String.raw`)`,
  'i',
);

// `.env.example` and its siblings are templates, not credentials; every
// other `.env` / `.env.<suffix>` is (the safe direction: `.env.example.local`
// is not on the exemption list and asks).
const ENV_TEMPLATE = /^\.env\.(?:example|sample|template)$/;

// Project-level credential files: `*.pem` and `*.key` of any name, and the
// conventional private-key names. Public material is not a credential —
// `*.pub` (the public half beside a private key), `known_hosts*` and
// `authorized_keys*` stay quiet, so a public half costs no ask and the
// detector still names the private half. Case-folded, for the same reason as
// HOME_CREDENTIAL.
function credentialFileBase(base: string): boolean {
  const name = base.toLowerCase();
  if (name.endsWith('.pub')) return false;
  if (name === '.env') return true;
  if (name.startsWith('.env.')) return !ENV_TEMPLATE.test(name);
  return /^(?:id_rsa.*|id_ed25519.*|.+?\.(?:pem|key))$/.test(name);
}

// A command's words, quote-stripped, with a leading `--flag=` removed.
// Splitting on whitespace and shell separators is deliberately shallow: a
// path with spaces inside one quoted argument splits, and both halves are
// still checked, so the miss direction stays the safe one.
function commandTokens(command: string): string[] {
  return command
    .split(/[\s|;&()<>]+/)
    .map((token) => token.replace(/^["']+|["']+$/g, ''))
    .map((token) => token.replace(/^--?[A-Za-z][\w-]*=/, ''))
    .filter((token) => token !== '');
}

function baseName(token: string): string {
  return token.slice(token.lastIndexOf('/') + 1);
}

// The credential name PARTS a name filter can select: a filter is matched by
// substring against the walked path (`grep.include`) or the base name
// (`find.nameContains`), so `env` reaches `.env` and `key` reaches `*.key`.
const CREDENTIAL_NAME_PARTS = [
  '.env',
  'id_rsa',
  'id_ed25519',
  '.pem',
  '.key',
] as const;

// A name filter shorter than this is not treated as a credential selector:
// `e` or `en` would match half a repository, and the ask cost of that is not
// worth the miss it closes. Stated bound, not a silent one.
const MIN_CREDENTIAL_FILTER = 3;

// The credential name a `grep.include` / `find.nameContains` filter can
// select, or undefined. Either direction counts: a needle inside a credential
// name (`env` in `.env`, `pem` in `*.pem`) and a credential name inside the
// needle (`my.pem.bak`, `src/.env.local`, whose base name is taken first).
// Case-folded like every other match here.
export function credentialAccessInNameFilter(
  value: string,
): string | undefined {
  const needle = baseName(value).toLowerCase();
  if (needle.length < MIN_CREDENTIAL_FILTER) return undefined;
  return CREDENTIAL_NAME_PARTS.some(
    (part) => needle.includes(part) || part.includes(needle),
  )
    ? value
    : undefined;
}

// The credential path a bash command names, or undefined. Bash cannot be
// confined, so this is the only guard between a model and `~/.aws`.
export function credentialAccessInCommand(command: string): string | undefined {
  const home = HOME_CREDENTIAL.exec(command);
  if (home !== null) return home[0].trim();
  for (const token of commandTokens(command)) {
    if (credentialFileBase(baseName(token))) return token;
  }
  return undefined;
}

// The credential path a read-family tool call names, or undefined. The ask
// runs BEFORE the agent's confine rewrite, so a home path is seen here as
// typed even though the tool itself could never open it; a workspace `.env`
// passes confinement unchanged and is the case that actually reaches a file.
export function credentialAccessInPath(path: string): string | undefined {
  const home = HOME_CREDENTIAL.exec(path);
  if (home !== null) return home[0].trim();
  return credentialFileBase(baseName(path)) ? path : undefined;
}
