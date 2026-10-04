// Credential-path detector (issue #275; §41.1, §40 `credentials` class).
//
// The §40 permission classes include `credentials`, whose installed default
// is `none`, and §41.1 lists "credential access beyond what the role
// declares" as an approval trigger. Until this module there was no detector,
// so the class was informational: `cat ~/.aws/credentials` and a read of a
// committed `.env` ran with no approval. The home paths in a bash command
// are the remaining gap — the read/ls/grep tools are confined to the
// workspace (CONFINED_TOOLS, worker/src/lane/interceptors.ts) — and
// in-workspace credential files are exposed to both the shell and the tools.
//
// Scope and honesty (§59.1): this is a LEXICAL DETECTOR, not enforcement.
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
// original is the same secret), except `.ssh`, where only key material
// matches — `known_hosts` is not a credential.
const HOME_CREDENTIAL_PATHS = [
  String.raw`\.aws(?:\/|(?![-\w]))`,
  String.raw`\.ssh\/(?:id_[^\/\s"']*|config|(?:[^\/\s"']*)\.(?:pem|key))`,
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

// Token start: the prefix must not be glued to a longer word.
const HOME_CREDENTIAL = new RegExp(
  String.raw`(?:^|[\s"'=(])` +
    HOME_PREFIX +
    String.raw`\/` +
    String.raw`(?:` +
    HOME_CREDENTIAL_PATHS +
    String.raw`)`,
);

// `.env.example` and its siblings are templates, not credentials; every
// other `.env` / `.env.<suffix>` is (the safe direction: `.env.example.local`
// is not on the exemption list and asks).
const ENV_TEMPLATE = /^\.env\.(?:example|sample|template)$/;

// Project-level credential files: `*.pem` and `*.key` of any name, and the
// conventional private-key names (`id_rsa.pub` included — flagging a public
// half costs an ask, missing a private half costs the key).
function credentialFileBase(base: string): boolean {
  if (base === '.env') return true;
  if (base.startsWith('.env.')) return !ENV_TEMPLATE.test(base);
  return /^(?:id_rsa.*|id_ed25519.*|.+?\.(?:pem|key))$/.test(base);
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
// runs BEFORE the worker's confine rewrite, so a home path is seen here as
// typed even though the tool itself could never open it; a workspace `.env`
// passes confinement unchanged and is the case that actually reaches a file.
export function credentialAccessInPath(path: string): string | undefined {
  const home = HOME_CREDENTIAL.exec(path);
  if (home !== null) return home[0].trim();
  return credentialFileBase(baseName(path)) ? path : undefined;
}
