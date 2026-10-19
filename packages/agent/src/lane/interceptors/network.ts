// The network command detector behind `network: none`: a literal-pattern
// heuristic with the destructive matcher's stated scope. A script the agent
// writes and runs, an interpreter (`python3 -c`, `node -e`), a build script
// and a tool not listed here reach the network unseen.
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
const DOCKER: SubcommandTool = {
  values: ['--context', '-c', '-H', '--host', '--config', '-l', '--log-level'],
  network: set('pull push login search build buildx'),
  nested: new Map([['image', set('pull push')]]),
};
const NODE_REGISTRY = set(
  'view info show search audit publish login adduser ping outdated whoami',
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
        ['submodule', set('update sync')],
        ['lfs', set('fetch pull push clone')],
      ]),
    },
  ],
  ['docker', DOCKER],
  ['podman', DOCKER],
  [
    'cargo',
    {
      values: ['-Z', '--config', '-C', '--color'],
      network: set('fetch update search publish login'),
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
