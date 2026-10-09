// The one submit path — Enter, Alt+Enter, and the palette's command rows:
// a skill invocation expands into the prompt, a slash command runs its
// registered handler and never reaches the model, and anything else is a turn.
import { parseSlashCommand } from '@kubic/tui/slash-commands';
import type { TuiSubmitOutcome } from '@kubic/tui/tui-app';
import {
  parseSkillInvokeCommand,
  SKILL_COMMAND_USAGE,
  type TuiSkillInvokeCommand,
} from './commands/parse.js';
import { TUI_COMMANDS } from './commands/registry.js';
import type { TuiContext } from './context.js';
import { startTurn } from './turns.js';
import type { TuiTurnDriver, TuiTurnOptions } from './types.js';

// `steer` marks the Alt+Enter form, which becomes a harness steer
// while a turn runs instead of a queued follow-up.
export function submitPrompt(
  ctx: TuiContext,
  draft: string,
  steer: boolean,
): TuiSubmitOutcome {
  if (ctx.stopped) return 'refused';
  const busy = ctx.busy();
  // `/skill:<name> [instructions]` expands to
  // the skill content plus instructions and submits AS the prompt —
  // the mode, busy and attachment rules below apply unchanged. An
  // unknown name refuses locally by name (withheld skills resolve
  // unknown too, so the refusal never leaks their existence) and
  // never reaches the model.
  const skill = parseSkillInvokeCommand(draft);
  let prompt = draft;
  if (skill !== undefined) {
    const expanded = expandSkill(ctx, skill);
    if (expanded === undefined) return 'refused';
    prompt = expanded;
  }
  // A slash command is never a prompt. An unknown one is
  // refused locally — it must not reach the model — and the registry's
  // own commands dispatch below. An expanded skill is
  // already a prompt, never a command — parsing it again would let a
  // skill body starting with `/` hijack the submit.
  const command = skill === undefined ? parseSlashCommand(prompt) : undefined;
  const handler =
    command === undefined ? undefined : TUI_COMMANDS.get(command.name);
  if (command !== undefined && handler === undefined) {
    ctx.say(`unknown command '/${command.name}' — /help lists the commands`);
    return 'refused';
  }
  // The lane commands answer before the lane check: each one refuses by
  // name when the session has no live lane.
  if (command !== undefined && handler?.lane === true) {
    return handler.run(ctx, { ...command, prompt, busy });
  }
  // A session booted without a lane refuses by name instead of
  // pretending the prompt ran.
  const driver = ctx.turn;
  if (driver === undefined) {
    ctx.say('error: the lane is unavailable in this session');
    return 'refused';
  }
  // The remaining registry commands answer locally.
  if (command !== undefined && handler !== undefined) {
    return handler.run(ctx, { ...command, prompt, busy });
  }
  return submitTurn(ctx, driver, prompt, steer, busy);
}

function expandSkill(
  ctx: TuiContext,
  skill: TuiSkillInvokeCommand,
): string | undefined {
  if (skill.kind === 'invalid') {
    ctx.say(SKILL_COMMAND_USAGE);
    return undefined;
  }
  const invocation = ctx.boot.skillInvocation;
  if (invocation === undefined) {
    ctx.say('skill: explicit invocation is unavailable in this session');
    return undefined;
  }
  try {
    return invocation.invoke(skill.name, skill.instructions);
  } catch (error) {
    ctx.say(`skill: ${error instanceof Error ? error.message : String(error)}`);
    return undefined;
  }
}

// A prompt turn, with the images armed for it.
function submitTurn(
  ctx: TuiContext,
  driver: TuiTurnDriver,
  prompt: string,
  steer: boolean,
  busy: boolean,
): TuiSubmitOutcome {
  const sentImages = ctx.pendingImages;
  const imageOptions: TuiTurnOptions =
    sentImages.length === 0 ? {} : { images: sentImages };
  const imagesSent = (): void => {
    ctx.pendingImages = [];
    // The app keeps the sent images on the echo until the lane's own
    // prompt cell replaces it; the composer itself is empty again.
    ctx.app.setPendingImages(sentImages);
    // ... but nothing is armed any more: a blank Enter between this
    // submit and the echo's replacement is a no-op again.
    ctx.app.setPendingAttachments(0);
  };
  if (busy) {
    // The lane queues the prompt in the conversation's OWN
    // inbox — a follow-up (placed when the run answers) for Enter, a
    // steer (placed after the current tool round, joining the running
    // work) for Alt+Enter.
    startTurn(
      ctx,
      driver,
      prompt,
      steer
        ? { whenBusy: 'steer', ...imageOptions }
        : {
            whenBusy: 'followUp',
            onSubmitted: (id) => {
              // The rows follow from the state: the id's text is what
              // the projector resolves against this map.
              ctx.queuedText.set(id, prompt);
              // The images of a queued draft are remembered
              // per submission id, so the echo that replaces the row
              // carries them too.
              if (sentImages.length > 0) ctx.queuedImages.set(id, sentImages);
              ctx.turn?.refreshPresentation();
            },
            ...imageOptions,
          },
    );
    imagesSent();
    return 'queued';
  }
  startTurn(ctx, driver, prompt, imageOptions);
  imagesSent();
  return 'accepted';
}
