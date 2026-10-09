// The parsers of the slash commands that take structured arguments.
import { parseCompactCommand } from '@kubic/agent/compaction';
import type { ModelSelection } from '@kubic/agent/model-select';
import { parseModelFlag } from '@kubic/agent/model-select';
import { isThinkingLevel, THINKING_LEVELS } from '@kubic/agent/models-config';
import type { ModelThinkingLevel } from '@kubic/agent/pi-boundary';

export const SKILL_COMMAND_USAGE = 'usage: /skill:<name> [instructions]';

export type TuiSkillInvokeCommand =
  | {
      readonly kind: 'invoke';
      readonly name: string;
      readonly instructions: string;
    }
  | { readonly kind: 'invalid'; readonly message: string };

// Explicit skill invocation: `/skill:<name>` names the
// skill, the rest is the operator's instructions. The registry owns the
// static `skill` entry for discovery; this parser owns the colon form the
// registry cannot enumerate. A bare `/skill` (or an empty name) is the
// usage error; anything else is not a skill command at all.
export function parseSkillInvokeCommand(
  prompt: string,
): TuiSkillInvokeCommand | undefined {
  const trimmed = prompt.trim();
  if (trimmed !== '/skill' && !trimmed.startsWith('/skill:')) {
    return undefined;
  }
  const rest = trimmed === '/skill' ? '' : trimmed.slice('/skill:'.length);
  const space = rest.search(/\s/);
  const name = (space === -1 ? rest : rest.slice(0, space)).trim();
  const instructions = space === -1 ? '' : rest.slice(space + 1).trim();
  if (name === '') return { kind: 'invalid', message: SKILL_COMMAND_USAGE };
  return { kind: 'invoke', name, instructions };
}

// The `/model` command of the interactive loop. One parser for the three forms
// the loop acts on — pick (bare: the picker), switch, invalid — so the submit
// path and its tests agree on what is a command and what is a prompt handed to
// the lane.
export type TuiModelCommand =
  | { kind: 'pick' }
  | { kind: 'switch'; selection: ModelSelection }
  | { kind: 'invalid'; message: string };

export function parseModelCommand(prompt: string): TuiModelCommand | undefined {
  const trimmed = prompt.trim();
  if (trimmed !== '/model' && !trimmed.startsWith('/model ')) return undefined;
  const argument =
    trimmed === '/model' ? '' : trimmed.slice('/model '.length).trim();
  if (argument === '') return { kind: 'pick' };
  try {
    return { kind: 'switch', selection: parseModelFlag(argument) };
  } catch (error) {
    return {
      kind: 'invalid',
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

// The `/escalate` command of the interactive loop: an
// explicit climb with a recorded reason. Unlike `/model` (the session
// override, which climbs silently), `/escalate` names WHY in the
// escalation event — the trajectory row and the transcript line carry it.
// A bare `/escalate` is a usage refusal, not a report: reporting the
// ladder is `/scoped-models`' successor's job, not this command's.
export type TuiEscalateCommand =
  | { kind: 'switch'; selection: ModelSelection; reason: string | undefined }
  | { kind: 'invalid'; message: string };

export function parseEscalateCommand(
  prompt: string,
): TuiEscalateCommand | undefined {
  const trimmed = prompt.trim();
  if (trimmed !== '/escalate' && !trimmed.startsWith('/escalate '))
    return undefined;
  const argument =
    trimmed === '/escalate' ? '' : trimmed.slice('/escalate '.length).trim();
  if (argument === '') {
    return {
      kind: 'invalid',
      message: 'usage: /escalate <provider/id> [reason]',
    };
  }
  const space = argument.search(/\s/);
  const ref = space === -1 ? argument : argument.slice(0, space);
  const reason =
    space === -1 ? undefined : argument.slice(space).trim() || undefined;
  try {
    return { kind: 'switch', selection: parseModelFlag(ref), reason };
  } catch (error) {
    return {
      kind: 'invalid',
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

// The `/compact [instructions]` command of the interactive loop. `undefined`
// means the draft is a prompt, not the command; the focus is the instructions
// Pi hands the summarizer (verbatim, via compaction.ts's compact prompt),
// absent when the operator typed `/compact` alone. One parser for the dispatch
// and its tests.
interface TuiCompactCommand {
  readonly focus: string | undefined;
}

export function parseTuiCompactCommand(
  prompt: string,
): TuiCompactCommand | undefined {
  const trimmed = prompt.trim();
  if (trimmed !== '/compact' && !trimmed.startsWith('/compact ')) {
    return undefined;
  }
  const focus = parseCompactCommand(trimmed).trim();
  return { focus: focus === '' ? undefined : focus };
}

// The `/thinking <level>` command of the interactive loop (thinking.cycle).
// `undefined` means the draft is a prompt, not the command; the level
// vocabulary is the config layer's own (`THINKING_LEVELS`), so `/thinking
// bogus` is refused by name with the levels that exist.
export type TuiThinkingCommand =
  | { kind: 'pick' }
  | { kind: 'switch'; level: ModelThinkingLevel }
  | { kind: 'invalid'; message: string };

export function parseThinkingCommand(
  prompt: string,
): TuiThinkingCommand | undefined {
  const trimmed = prompt.trim();
  if (trimmed !== '/thinking' && !trimmed.startsWith('/thinking ')) {
    return undefined;
  }
  const argument =
    trimmed === '/thinking' ? '' : trimmed.slice('/thinking '.length).trim();
  if (argument === '') return { kind: 'pick' };
  if (!isThinkingLevel(argument)) {
    return {
      kind: 'invalid',
      message: `unknown thinking level '${argument}' (levels: ${THINKING_LEVELS.join(', ')})`,
    };
  }
  return { kind: 'switch', level: argument };
}
