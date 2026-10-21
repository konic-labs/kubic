// The network command detector behind `network: none`: a literal-pattern
// heuristic with the destructive matcher's stated scope. A script the agent
// writes and runs, an interpreter (`python3 -c`, `node -e`), a build script
// (`go build`, `cargo build` fetching dependencies) and a tool not listed here
// reach the network unseen.
import { commandLead, commandWord, MAX_LEAD_WORDS } from './command-words.js';

// Clients that reach the network whatever they are asked to do: the literal
// word anywhere in the command, quoted context included.
const NETWORK_WORDS =
  /\b(?:curl|wget|ssh|scp|sftp|ftp|lftp|telnet|nc|ncat|netcat|socat|aria2c)\b/i;

// Tools whose network use depends on the subcommand: the first word after
// the tool's own options, each with the options of its own that take a
// separate value. A `git push` is `git-push`'s to raise, not this one's.
interface SubcommandTool {
  readonly values: readonly string[];
  readonly network: ReadonlySet<string>;
  // Subcommands that reach the network through their own next word
  // (`git remote update`, `go mod download`).
  readonly nested?: ReadonlyMap<string, ReadonlySet<string>>;
}

const set = (list: string): ReadonlySet<string> => new Set(list.split(' '));
const COMPOSE_NETWORK = set('up pull push build run create');
const DOCKER: SubcommandTool = {
  values: ['--context', '-c', '-H', '--host', '--config', '-l', '--log-level'],
  // `run` and `create` pull a missing image.
  network: set('pull push login search build buildx run create'),
  nested: new Map([
    ['image', set('pull push')],
    ['compose', COMPOSE_NETWORK],
  ]),
};
const NODE_REGISTRY = set(
  'view info show search audit publish unpublish deprecate owner dist-tag token access star login adduser ping outdated whoami',
);
const NODE_PACKAGE_VALUES = ['--prefix', '-C', '--dir', '--cwd', '-w'];
const PIP: SubcommandTool = {
  values: ['--python'],
  network: set('download index search'),
};
const TOOLS: ReadonlyMap<string, SubcommandTool> = new Map([
  [
    'git',
    {
      values: [
        '-C',
        '-c',
        '--git-dir',
        '--work-tree',
        '--namespace',
        '--super-prefix',
        '--config-env',
      ],
      network: set('clone fetch pull ls-remote'),
      nested: new Map([
        ['remote', set('update')],
        ['submodule', set('add update sync')],
        ['lfs', set('fetch pull push clone')],
      ]),
    },
  ],
  ['docker', DOCKER],
  ['podman', DOCKER],
  [
    'docker-compose',
    { values: ['-f', '--file', '-p'], network: COMPOSE_NETWORK },
  ],
  [
    'cargo',
    {
      values: ['-Z', '--config', '-C', '--color'],
      network: set('fetch update search publish login yank owner'),
    },
  ],
  ['gem', { values: [], network: set('push yank owner fetch search') }],
  ['poetry', { values: [], network: set('publish') }],
  ['uv', { values: [], network: set('publish') }],
  ['hatch', { values: [], network: set('publish') }],
  ['flit', { values: [], network: set('publish') }],
  ['twine', { values: [], network: set('upload register') }],
  ['ollama', { values: [], network: set('pull push run') }],
  [
    'dotnet',
    {
      values: [],
      network: new Set<string>(),
      nested: new Map([['nuget', set('push')]]),
    },
  ],
  [
    'go',
    {
      values: [],
      network: set('get'),
      nested: new Map([['mod', set('download')]]),
    },
  ],
  ['npm', { values: NODE_PACKAGE_VALUES, network: NODE_REGISTRY }],
  ['pnpm', { values: NODE_PACKAGE_VALUES, network: NODE_REGISTRY }],
  [
    'yarn',
    {
      values: NODE_PACKAGE_VALUES,
      network: NODE_REGISTRY,
      nested: new Map([['npm', set('info audit publish login whoami')]]),
    },
  ],
  ['pip', PIP],
  ['pip3', PIP],
  ['openssl', { values: [], network: set('s_client s_time') }],
]);

// gh talks to GitHub for everything but its own local housekeeping.
const GH_LOCAL = set('help version completion alias config --help --version');

// Clients that talk to a remote service for everything they do: database
// clients, deploy CLIs, network diagnostics and HTTP clients. Only asking one
// for its own help or version stays quiet.
const ALWAYS_REMOTE = set(
  [
    'psql mysql mariadb mongosh mongo redis-cli cqlsh sqlcmd clickhouse-client pgcli mycli usql snowsql bq',
    'gsutil fly flyctl vercel netlify heroku wrangler firebase supabase railway doctl eksctl ibmcloud oci linode-cli serverless sls cdk sam',
    'nslookup dig ping traceroute nmap whois grpcurl websocat mosquitto_pub mosquitto_sub',
    'http https xh xhs huggingface-cli hf',
  ].join(' '),
);
const HELP_OR_VERSION = set('help version --help --version -h -v');

// Cloud and cluster CLIs: remote by default, local for the subcommands that
// only read or write their own configuration or render files.
const LOCAL_SUBCOMMANDS: ReadonlyMap<string, ReadonlySet<string>> = new Map([
  ['aws', set('help configure --version')],
  ['gcloud', set('help version config info topic --help --version')],
  ['az', set('help version config --help --version')],
  ['kubectl', set('config completion kustomize plugin options help --help')],
  [
    'helm',
    set(
      'template lint create package completion env help version verify --help',
    ),
  ],
  ['terraform', set('fmt validate version console graph help -help -version')],
  ['tofu', set('fmt validate version console graph help -help -version')],
  ['pulumi', set('version help --help --version')],
]);

// A remote operand of rclone: `remote:path` (a configured remote's name).
const RCLONE_REMOTE = /^[A-Za-z0-9_][A-Za-z0-9_.-]*:/;

// An rsync operand on another host: `host:path`, `user@host:path`,
// `host::module` or an `rsync://` URL.
const RSYNC_REMOTE = /^(?:rsync:\/\/|[^/\s]+:)/i;

const COMMAND_BREAK = /[|;&\n\r]|(?<!\$)\(/;

// A word as the shell reads it, case-folded: `"FETCH"` is `fetch`.
function plain(word: string): string {
  return word.replace(/\\(.)/g, '$1').replace(/["']/g, '').toLowerCase();
}

// The words after a tool's own options: its subcommand first.
function afterOptions(
  words: readonly string[],
  values: readonly string[],
): readonly string[] {
  let index = 0;
  while (index < words.length) {
    const word = words[index] ?? '';
    if (!word.startsWith('-')) break;
    index += values.includes(word) ? 2 : 1;
  }
  return words.slice(index);
}

function segmentReachesNetwork(segment: string): boolean {
  const words = segment.split(/\s+/).filter((word) => word !== '');
  const lead = commandLead(words.slice(0, MAX_LEAD_WORDS + 1));
  if (lead === undefined || lead === 'unknown') return false;
  const verb = commandWord(words[lead.index] ?? '');
  const args = words.slice(lead.index + 1).map(plain);
  if (verb === 'gh') return !GH_LOCAL.has(args[0] ?? 'help');
  if (verb === 'rsync') return args.some((word) => RSYNC_REMOTE.test(word));
  if (ALWAYS_REMOTE.has(verb)) {
    return !(
      args.length > 0 && args.every((word) => HELP_OR_VERSION.has(word))
    );
  }
  const local = LOCAL_SUBCOMMANDS.get(verb);
  if (local !== undefined) {
    const [subcommand] = args.filter((word) => !word.startsWith('-'));
    // `kubectl version --client` reads only the binary's own version.
    if (verb === 'kubectl' && subcommand === 'version') {
      return !args.includes('--client');
    }
    return !local.has(subcommand ?? args[0] ?? 'help');
  }
  if (verb === 'rclone') {
    return args.some((word) => RCLONE_REMOTE.test(word));
  }
  if (verb === 'deno') {
    return args.some((word) => /^https?:\/\//.test(word));
  }
  // Maven and Gradle publish through a goal or task anywhere on the line.
  if (verb === 'mvn' || verb === 'mvnw') return args.includes('deploy');
  if (verb === 'gradle' || verb === 'gradlew') {
    return args.some((word) => word.startsWith('publish'));
  }
  const tool = TOOLS.get(verb);
  if (tool === undefined) return false;
  const [subcommand = '', next = ''] = afterOptions(args, tool.values);
  return (
    tool.network.has(subcommand) ||
    tool.nested?.get(subcommand)?.has(next) === true
  );
}

export function isNetworkCommand(command: string): boolean {
  return (
    NETWORK_WORDS.test(command) ||
    command.split(COMMAND_BREAK).some(segmentReachesNetwork)
  );
}
