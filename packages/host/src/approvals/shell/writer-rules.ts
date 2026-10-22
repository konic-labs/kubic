import { shellUnquote } from './lexer.js';
import {
  lastOf,
  names,
  type OptionSpec,
  parseOptions,
  valuesOf,
} from './options.js';

// The writer table: for each command that writes files, the arguments that
// name what it writes. A rule reads the command's arguments — its comment and
// redirections already dropped — and returns the target words as written.

export type Rule = (args: readonly string[]) => readonly string[];

const TARGET_DIRECTORY: OptionSpec = {
  short: 'tS',
  long: names('target-directory suffix'),
};

// cp and install write their destination: `-t DIR`, else the last argument.
// mv also takes its sources away from where they were, and ln makes a path to
// everything it names — a link to an outside path is a way out of the
// workspace — so every argument of those two counts.
function copyRule(verb: string, spec: OptionSpec): Rule {
  return (args) => {
    const parsed = parseOptions(args, spec);
    const into = valuesOf(parsed, 't', 'target-directory');
    if (verb === 'mv' || verb === 'ln') return [...into, ...parsed.positionals];
    if (
      verb === 'install' &&
      (parsed.given.has('d') || parsed.given.has('directory'))
    ) {
      return [...into, ...parsed.positionals];
    }
    if (into.length > 0) return into;
    return parsed.positionals.length >= 2 ? lastOf(parsed.positionals) : [];
  };
}

function positionalsRule(spec: OptionSpec): Rule {
  return (args) => parseOptions(args, spec).positionals;
}

function valuesRule(spec: OptionSpec, keys: readonly string[]): Rule {
  return (args) => valuesOf(parseOptions(args, spec), ...keys);
}

// chmod's first argument is its mode, unless the mode was given in an
// option's shape (`chmod -x f`) or taken from `--reference`.
function chmodRule(args: readonly string[]): readonly string[] {
  const parsed = parseOptions(args, { long: ['reference'] });
  const modeAsOption = args.some((word) =>
    /^-[rwxXst]+$/.test(shellUnquote(word)),
  );
  return parsed.values.has('reference') || modeAsOption
    ? parsed.positionals
    : parsed.positionals.slice(1);
}

// chown/chgrp's first argument is the owner, unless `--reference` gives it.
function chownRule(args: readonly string[]): readonly string[] {
  const parsed = parseOptions(args, { long: names('reference from') });
  return parsed.values.has('reference')
    ? parsed.positionals
    : parsed.positionals.slice(1);
}

// sed and perl write only in place (`-i`, `--in-place`), into the files after
// the script — or into every argument when `-e`/`-f` gives the script.
function inPlaceRule(spec: OptionSpec, scriptOptions: readonly string[]): Rule {
  return (args) => {
    const parsed = parseOptions(args, spec);
    if (!parsed.given.has('i') && !parsed.given.has('in-place')) return [];
    return scriptOptions.some((name) => parsed.given.has(name))
      ? parsed.positionals
      : parsed.positionals.slice(1);
  };
}

const RSYNC_VALUE = names(
  'rsh filter exclude include exclude-from include-from files-from temp-dir ' +
    'partial-dir backup-dir suffix chmod chown password-file log-file ' +
    'log-file-format out-format compare-dest copy-dest link-dest rsync-path ' +
    'max-size min-size bwlimit timeout contimeout port block-size address ' +
    'iconv info debug usermap groupmap remote-option',
);

// rsync writes its destination (the last argument) and the directories and
// files its options name.
function rsyncRule(args: readonly string[]): readonly string[] {
  const parsed = parseOptions(args, { short: 'efTB', long: RSYNC_VALUE });
  return [
    ...(parsed.positionals.length >= 2 ? lastOf(parsed.positionals) : []),
    ...valuesOf(
      parsed,
      'T',
      'temp-dir',
      'partial-dir',
      'backup-dir',
      'log-file',
    ),
  ];
}

const TAR_VALUE = 'fCbTXLVNHIKg';
const TAR_LONG_VALUE = names(
  'file directory files-from exclude-from exclude blocking-factor ' +
    'tape-length label newer newer-mtime format use-compress-program ' +
    'starting-file listed-incremental owner group mode mtime transform suffix',
);
const TAR_LONG_MODE: ReadonlyMap<string, string> = new Map([
  ['create', 'c'],
  ['extract', 'x'],
  ['get', 'x'],
  ['append', 'r'],
  ['update', 'u'],
  ['catenate', 'A'],
  ['concatenate', 'A'],
]);

// tar writes its archive (`-f`) when it creates or adds to one, and into
// `-C DIR` when it extracts. The first word may be an old-style bundle
// (`tar xzf a.tgz`), whose value letters take the next words in order.
function tarRule(args: readonly string[]): readonly string[] {
  const modes = new Set<string>();
  const files: string[] = [];
  const dirs: string[] = [];
  let next = 0;
  const bundle = shellUnquote(args[0] ?? '');
  if (/^[A-Za-z]+$/.test(bundle)) {
    next = 1;
    for (const letter of bundle) {
      modes.add(letter);
      if (!TAR_VALUE.includes(letter)) continue;
      const value = args[next];
      next += 1;
      if (value === undefined) continue;
      if (letter === 'f') files.push(value);
      if (letter === 'C') dirs.push(value);
    }
  }
  const parsed = parseOptions(args.slice(next), {
    short: TAR_VALUE,
    long: TAR_LONG_VALUE,
  });
  for (const name of parsed.given) modes.add(TAR_LONG_MODE.get(name) ?? name);
  files.push(...valuesOf(parsed, 'f', 'file'));
  dirs.push(...valuesOf(parsed, 'C', 'directory'));
  return [
    ...(['c', 'r', 'u', 'A'].some((mode) => modes.has(mode)) ? files : []),
    ...(modes.has('x') ? dirs : []),
  ];
}

const GIT_GLOBAL_VALUE = new Set(
  names('-C -c --git-dir --work-tree --namespace --super-prefix --config-env'),
);
const GIT_CLONE_VALUE = names(
  'branch origin config upload-pack jobs depth reference reference-if-able ' +
    'separate-git-dir template shallow-since shallow-exclude filter ' +
    'server-option bundle-uri',
);

// git writes a new repository: `clone`'s directory, `init`'s and
// `worktree add`'s path, a `--separate-git-dir`, and under a global `-C DIR`.
function gitRule(args: readonly string[]): readonly string[] {
  const dirs: string[] = [];
  let index = 0;
  for (; index < args.length; index += 1) {
    const text = shellUnquote(args[index] ?? '');
    if (!text.startsWith('-')) break;
    if (!GIT_GLOBAL_VALUE.has(text)) continue;
    const value = args[index + 1];
    if (text === '-C' && value !== undefined) dirs.push(value);
    index += 1;
  }
  const subcommand = shellUnquote(args[index] ?? '').toLowerCase();
  const rest = args.slice(index + 1);
  if (subcommand === 'clone') {
    const parsed = parseOptions(rest, {
      short: 'bocuj',
      long: GIT_CLONE_VALUE,
    });
    return [
      ...dirs,
      ...parsed.positionals.slice(1, 2),
      ...valuesOf(parsed, 'separate-git-dir'),
    ];
  }
  if (subcommand === 'init') {
    const parsed = parseOptions(rest, {
      short: 'b',
      long: names('separate-git-dir template object-format initial-branch'),
    });
    return [
      ...dirs,
      ...parsed.positionals.slice(0, 1),
      ...valuesOf(parsed, 'separate-git-dir'),
    ];
  }
  if (subcommand === 'worktree' && shellUnquote(rest[0] ?? '') === 'add') {
    const parsed = parseOptions(rest.slice(1), {
      short: 'bB',
      long: ['reason'],
    });
    return [...dirs, ...parsed.positionals.slice(0, 1)];
  }
  return [];
}

const CURL_SPEC: OptionSpec = {
  short: 'AbcCdDeEFHKmoPQrtTuUwxXYyz',
  long: names(
    'output output-dir dump-header cookie-jar trace trace-ascii stderr ' +
      'etag-save hsts alt-svc data data-binary data-raw data-urlencode ' +
      'header request user user-agent referer cookie form config max-time ' +
      'connect-timeout proxy range upload-file write-out url resolve ' +
      'connect-to cert key cacert retry limit-rate json',
  ),
};
const WGET_SPEC: OptionSpec = {
  short: 'OPoaetTwQUiBlDARXI',
  long: names(
    'output-document directory-prefix output-file append-output execute ' +
      'tries timeout wait quota user-agent input-file base level domains ' +
      'accept reject exclude-directories include-directories header user ' +
      'password post-data post-file load-cookies save-cookies referer ' +
      'limit-rate warc-file rejected-log',
  ),
};

export const WRITE_RULES: ReadonlyMap<string, Rule> = new Map<string, Rule>([
  ['cp', copyRule('cp', TARGET_DIRECTORY)],
  ['mv', copyRule('mv', TARGET_DIRECTORY)],
  ['ln', copyRule('ln', TARGET_DIRECTORY)],
  [
    'install',
    copyRule('install', {
      short: 'tSmog',
      long: names('target-directory suffix mode owner group'),
    }),
  ],
  ['tee', positionalsRule({})],
  ['touch', positionalsRule({ short: 'dtr', long: names('date reference') })],
  ['mkdir', positionalsRule({ short: 'm', long: ['mode'] })],
  ['truncate', positionalsRule({ short: 'sr', long: names('size reference') })],
  ['chmod', chmodRule],
  ['chown', chownRule],
  ['chgrp', chownRule],
  [
    'dd',
    (args) =>
      args.flatMap((word) => {
        const text = shellUnquote(word);
        return text.startsWith('of=') ? [text.slice(3)] : [];
      }),
  ],
  [
    'sed',
    inPlaceRule(
      {
        short: 'efl',
        attached: 'i',
        long: names('expression file line-length'),
      },
      names('e f expression file'),
    ),
  ],
  ['perl', inPlaceRule({ short: 'eEIMm', attached: 'il0xCdDF' }, names('e E'))],
  [
    'sort',
    valuesRule(
      {
        short: 'koStT',
        long: names(
          'output key field-separator buffer-size temporary-directory',
        ),
      },
      names('o output'),
    ),
  ],
  ['rsync', rsyncRule],
  ['tar', tarRule],
  ['unzip', valuesRule({ short: 'd' }, ['d'])],
  ['git', gitRule],
  [
    'curl',
    valuesRule(
      CURL_SPEC,
      names(
        'o output output-dir D dump-header c cookie-jar trace trace-ascii ' +
          'stderr etag-save hsts alt-svc',
      ),
    ),
  ],
  [
    'wget',
    valuesRule(
      WGET_SPEC,
      names(
        'O output-document P directory-prefix o output-file a append-output ' +
          'save-cookies warc-file rejected-log',
      ),
    ),
  ],
]);
