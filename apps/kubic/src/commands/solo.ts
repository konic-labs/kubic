// Solo-mode commands (the architecture, not a mode): run, tui, doctor,
// models, config, sessions. Registered on the root program by
// ../dispatch.ts; this module is the one place their commander
// definitions live.

import type { CommandRegistrar } from '../cli/context.js';
import { registerForwarder } from '../cli/program.js';

export const registerSoloCommands: CommandRegistrar = (program, ctx) => {
  const { runners, config } = ctx;
  registerForwarder(program, ctx, 'run', (rest) => runners.run(rest, config), {
    summary: 'run one headless prompt (-p) in this repo',
  });
  registerForwarder(program, ctx, 'tui', (rest) => runners.tui(rest, config), {
    summary: 'open the interactive terminal UI',
  });
  registerForwarder(
    program,
    ctx,
    'doctor',
    (rest) => runners.doctor(rest, config),
    { summary: 'check dependencies, providers, policy and limits' },
  );
  registerForwarder(
    program,
    ctx,
    'models',
    (rest) => runners.models(rest, config),
    { summary: 'list or resolve models' },
  );
  registerForwarder(
    program,
    ctx,
    'config',
    (rest) => runners.config(rest, config),
    { summary: 'show the effective configuration' },
  );
  registerForwarder(
    program,
    ctx,
    'sessions',
    (rest) => runners.sessions(rest, config),
    { summary: 'list, show or prune sessions' },
  );
};
