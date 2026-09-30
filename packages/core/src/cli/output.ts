// The `--json` rule: a `--json` invocation prints exactly one JSON document
// on stdout and nothing else there — diagnostics go to stderr through the
// logger, colour and tables are off, prompts never run. `formatJson` is the
// one serializer, so every command's document has the same shape on the
// wire (two-space indent, trailing newline added by `out`).

export function formatJson(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

// Per-invocation output mode, derived once from the global flags and the
// real streams, and handed to command actions.
export interface OutputMode {
  readonly json: boolean;
  // stdin AND stdout are TTYs and not --json: prompts/spinners allowed.
  readonly interactive: boolean;
  // Fancy (box-drawn, coloured) rendering allowed on stdout.
  readonly fancy: boolean;
}

export function outputModeFor(state: {
  readonly json: boolean;
  readonly stdinTTY: boolean;
  readonly stdoutTTY: boolean;
  readonly colorEnabled: boolean;
}): OutputMode {
  const interactive = !state.json && state.stdinTTY && state.stdoutTTY;
  return {
    json: state.json,
    interactive,
    fancy: !state.json && state.stdoutTTY && state.colorEnabled,
  };
}
