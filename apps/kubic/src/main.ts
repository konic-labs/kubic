// kubic CLI composition root: argv in, exit code out. All logic lives in
// the packages; this file only wires.
import { runSessionsCommand } from '../../../packages/host/src/sessions-cli.js';

async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  if (command === 'sessions') {
    return runSessionsCommand(rest, { out: (line) => console.log(line) });
  }
  console.log('usage: kubic <sessions>');
  return 1;
}

const code = await main(process.argv.slice(2));
process.exit(code);
