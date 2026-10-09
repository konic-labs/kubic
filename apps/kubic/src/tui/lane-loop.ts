// The durable loop surface over one booted lane.
import { runCompactCommand } from '@kubic/agent/compaction';
import { abortLane, forgetLaneKills } from '@kubic/agent/lane/abort';
import type { Lane } from '@kubic/agent/lane/boot';
import { subscribeLaneEvents } from '@kubic/agent/lane/events';
import { readConversationEntries } from '@kubic/agent/lane/transcript';
import { runTurn } from '@kubic/agent/lane/turn';
import type { Context } from '@kubic/agent/pi-boundary';
import { BACKGROUND_CONTEXT } from '@kubic/agent/pi-boundary';
import type { TuiLaneLoop } from './types.js';

// The durable loop surface over one booted lane — exactly what
// bootTuiLane installs. Exported so the prod boot, embedders and the tests
// share ONE wiring: a lane member the loop needs cannot be forgotten in a
// hand-spread fake (the failure mode that hides a dropped dep).
export function tuiLoop(
  lane: Lane,
  context: Context = BACKGROUND_CONTEXT,
): TuiLaneLoop {
  return {
    runTurn: (prompt, opts) => runTurn(lane, prompt, opts),
    // The live model's own input modalities. The boot
    // model is what this closure can see; `bootTuiLane` overrides it with
    // the catalog read so a `/model` switch moves the verdict with it.
    supportsImages: async () => lane.model.input.includes('image'),
    subscribe: (sink, loopContext) =>
      subscribeLaneEvents(
        lane.harness,
        lane.conversation.id,
        sink,
        loopContext,
      ),
    entries: (loopContext) =>
      readConversationEntries(lane.conversation, loopContext),
    // `/compact [focus]` — Pi's manual compaction task with Kubic's compact
    // prompt as the summarizer instructions, under the manual keep window.
    compact: (focus, loopContext, options) =>
      runCompactCommand(lane, focus, loopContext, options),
    // The shared abort+drain (conversation.abort, every kill
    // attempted, failures aggregated) and the settled-turn forget.
    abort: async (loopContext) => {
      await abortLane(lane, loopContext);
    },
    forgetKills: () => forgetLaneKills(lane),
    killsKey: String(lane.conversation.id),
    kills: lane.kills,
    // The lane's own context: every member is called with it, so an embedder
    // that booted the lane on a bounded context is never silently
    // un-cancellable.
    context,
  };
}

// The model the conversation actually runs: the committed
// `pi.agent` document first, the boot model as the fallback for the window
// before the first configure.
export async function liveModelOf(
  lane: Lane,
  context: Context,
): Promise<{ provider: string; id: string }> {
  const agent = await lane.conversation.agent(context);
  const live = agent.model;
  if (live !== undefined) {
    return { provider: live.provider, id: live.modelId };
  }
  return { provider: lane.model.provider, id: lane.model.id };
}
