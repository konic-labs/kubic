// Destructive commands the journal cannot undo, read for the command a
// segment runs (past its wrappers): infrastructure and cloud teardown,
// container volumes, a published package, database drops and the user's
// crontab. A literal-pattern heuristic like the rest of the destructive
// matcher: a script, an interpreter or an unlisted tool is a stated miss.
import { commandLead, commandWord, MAX_LEAD_WORDS } from './command-words.js';

const COMMAND_BREAK = /[|;&\n\r]|(?<!\$)\(/;

// A word as the shell reads it, case-folded: `"Destroy"` is `destroy`.
function plain(word: string): string {
  return word.replace(/\\(.)/g, '$1').replace(/["']/g, '').toLowerCase();
}

type Rule = (args: readonly string[]) => boolean;

const terraformDestroys: Rule = (args) =>
  args.includes('destroy') ||
  (args.includes('apply') &&
    args.some((arg) => arg === '-destroy' || arg === '--destroy')) ||
  (args.includes('state') && args.includes('rm')) ||
  (args.includes('workspace') && args.includes('delete'));

// Volumes hold data; a prune removes whatever nothing references.
const containerDataDestroyed: Rule = (args) =>
  args.includes('prune') || (args.includes('volume') && args.includes('rm'));

const RULES: ReadonlyMap<string, Rule> = new Map([
  ['terraform', terraformDestroys],
  ['tofu', terraformDestroys],
  [
    'pulumi',
    (args) =>
      args.includes('destroy') ||
      (args.includes('stack') && args.includes('rm')) ||
      (args.includes('state') && args.includes('delete')),
  ],
  [
    'helm',
    (args) =>
      args.some((arg) => ['uninstall', 'delete', 'del', 'un'].includes(arg)),
  ],
  [
    'aws',
    (args) =>
      args.some(
        (arg) =>
          /^(delete-|remove-|terminate-|deregister-|revoke-|purge)/.test(arg) ||
          arg === 'rm' ||
          arg === 'rb',
      ),
  ],
  ['gsutil', (args) => args.some((arg) => arg === 'rm' || arg === 'rb')],
  [
    'gcloud',
    (args) => args.some((arg) => arg === 'delete' || arg === 'remove'),
  ],
  [
    'az',
    (args) =>
      args.some(
        (arg) => arg === 'delete' || arg === 'remove' || arg === 'purge',
      ),
  ],
  ['gh', (args) => args.includes('delete')],
  ['crontab', (args) => args.some((arg) => /^-[a-z]*r/.test(arg))],
  ['dropdb', () => true],
  ['dropuser', () => true],
  ['docker', containerDataDestroyed],
  ['podman', containerDataDestroyed],
  ['npm', (args) => args.includes('unpublish')],
]);

// SQL (and the key-value equivalents) that destroys data, through any of
// these clients — an argument, an inline script or a here-document.
const DATABASE_CLIENTS: ReadonlySet<string> = new Set([
  'psql',
  'mysql',
  'mariadb',
  'sqlite3',
  'mongosh',
  'mongo',
  'redis-cli',
  'sqlcmd',
  'clickhouse-client',
  'cqlsh',
  'pgcli',
  'mycli',
  'usql',
  'snowsql',
  'bq',
]);
const DESTRUCTIVE_SQL =
  /\b(drop\s+(table|database|schema|index|view|user|role|collection|keyspace)|truncate\b|delete\s+from\b|flushall\b|flushdb\b|dropdatabase\b|deletemany\b)/i;

export function infraDestructive(command: string): boolean {
  let databaseClient = false;
  for (const segment of command.split(COMMAND_BREAK)) {
    const words = segment.split(/\s+/).filter((word) => word !== '');
    const lead = commandLead(words.slice(0, MAX_LEAD_WORDS + 1));
    if (lead === undefined || lead === 'unknown') continue;
    const verb = commandWord(words[lead.index] ?? '');
    if (DATABASE_CLIENTS.has(verb)) {
      databaseClient = true;
      continue;
    }
    if (RULES.get(verb)?.(words.slice(lead.index + 1).map(plain)) === true) {
      return true;
    }
  }
  // The SQL may sit on a later line (a here-document), so it is read over the
  // whole command once a database client runs in it.
  return databaseClient && DESTRUCTIVE_SQL.test(command);
}
