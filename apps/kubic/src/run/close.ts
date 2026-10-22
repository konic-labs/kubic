// The close of a `kubic run`, on every exit path: in-flight work is drained
// first, then the guard stops, then the session closes with the span
// artifact, the prompt guarantee and the trajectory's entries written while
// it is still open.
import { join } from 'node:path';
import { abortLane, forgetLaneKills } from '@kubic/agent/lane/abort';
import type { Lane } from '@kubic/agent/lane/boot';
import {
  laneConversationIdOf,
  type SessionHandle,
} from '@kubic/agent/lane/session-store';
import {
  entriesToTranscript,
  readConversationEntries,
  readSessionEntries,
} from '@kubic/agent/lane/transcript';
import {
  BACKGROUND_CONTEXT,
  type Context,
  createModels,
  createRegistry,
  type EntryRecord,
  Harness,
  UserEntry,
  withCancel,
} from '@kubic/agent/pi-boundary';
import { serializeSpanArtifact } from '@kubic/host/run';
import type { SessionBoot } from '../session/bootstrap.js';
import type { RunGuard } from './guard.js';
import type { RunState } from './state.js';

// How long the end-of-run lane abort may take before the run gives up on it.
// The kills have already run by then; this bounds a harness that is waiting
// on a task that ignores cancellation (a provider that never settles its
// stream), so the run always reports its own result.
const LANE_ABORT_BOUND_MS = 2_000;

export async function closeRun(
  state: RunState,
  boot: SessionBoot,
  guard: RunGuard,
): Promise<void> {
  const report = (message: string): void =>
    guardedReport(state.sinks.debug, message);
  // Drain in-flight work FIRST — the sweep must observe the
  // tree after orphaned tool processes are dead, or their late writes
  // land outside both the journal and the reconciliation. Runs on every
  // exit path (guard exhaustion, an abandoned turn, an unexpected throw,
  // plain completion); a completed or failed turn forgets its (dead) kill
  // handles. Failures only reach the debug channel: the mapped result
  // and the sweep both stand.
  const lane = boot.lane;
  if (lane !== undefined) {
    if (state.abandoned) {
      await abortAbandonedLane(lane, report);
    } else {
      forgetLaneKills(lane);
    }
  }
  guard.close();
  // The sweep, the policy's posture check and the session close, on every
  // exit path. While the session is still open: the span artifact, the
  // prompt guarantee and the trajectory's entries.
  const session = boot.session as SessionHandle;
  await boot.teardown({
    ...(state.abandoned ? { closeBoundMs: LANE_ABORT_BOUND_MS } : {}),
    beforeClose: async () => {
      flushSpans(state, boot);
      // The prompt guarantee first: a run that never admitted the prompt
      // still gets its one durable entry, and the transcript decides —
      // never a second copy for a prompt that is already carried. Done
      // before the capture below so the trajectory carries the fallback
      // write.
      try {
        await ensurePromptDurable(
          lane,
          session,
          state.effectivePrompt,
          state.context,
          report,
        );
      } catch (error) {
        report(
          `session: prompt not persisted: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      // The trajectory's entries, read while the session is still open
      // through the shared transcript adapter.
      state.capture.entries = await captureEntries(
        lane,
        session,
        state.context,
      );
    },
  });
  if (boot.secretsKeptOut > 0) {
    state.sinks.notice(
      `data policy: ${boot.secretsKeptOut} secret value(s) kept out of what the session stored`,
    );
  }
}

// The span artifact is written on every exit path (success or mapped
// failure) next to the session journal.
function flushSpans(state: RunState, boot: SessionBoot): void {
  state.spans.endRun(state.runSpan);
  try {
    boot.bridge.appendFile(
      join(boot.id, 'spans.jsonl'),
      serializeSpanArtifact(state.spans.trace(), state.runSpan, boot.id),
      { mode: 0o600 },
    );
  } catch {
    // Telemetry must never mask the run's own result: a failed artifact
    // write is not a run failure.
  }
}

// Best-effort conversation abort + kill drain on the divert paths (a guard
// or an interrupt abandoned a live turn): the durable stop is stated against
// a context that is NOT the cancelled bound, and the wait is bounded so the
// run's own result never hangs on it.
async function abortAbandonedLane(
  lane: Lane,
  report: (message: string) => void,
): Promise<void> {
  const cancel = withCancel(BACKGROUND_CONTEXT);
  const timer = setTimeout(
    () =>
      cancel.cancel(new Error(`lane abort exceeded ${LANE_ABORT_BOUND_MS}ms`)),
    LANE_ABORT_BOUND_MS,
  );
  try {
    await abortLane(lane, cancel.context);
  } catch (error) {
    report(
      `guard: drain failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  } finally {
    clearTimeout(timer);
  }
}

// The mapped result outranks telemetry: a throwing debug sink in the
// end-of-run cleanup must not replace the run's own HeadlessRunResult.
function guardedReport(
  report: ((message: string) => void) | undefined,
  message: string,
): void {
  try {
    report?.(message);
  } catch {
    // Swallowed by design — the mapped result stands.
  }
}

// Capture of the run's transcript (the readers): the live conversation
// while the lane is open, the session storage otherwise. A read failure
// leaves the trajectory without actions, never the run without its result.
async function captureEntries(
  lane: Lane | undefined,
  session: SessionHandle,
  context: Context,
): Promise<EntryRecord[]> {
  try {
    return lane === undefined
      ? await readSessionEntries(session.storage, context)
      : await readConversationEntries(lane.conversation, context);
  } catch {
    return [];
  }
}

// `submit` writes `pi.user` itself, so a run that reached its turn has
// exactly ONE user entry. Every other exit path — no model, a refused role,
// a signal between boot and the turn, a busy refusal — still keeps the
// prompt durable (the guarantee `kubic run -p` gives) through
// one plain entry write. The TRANSCRIPT decides, in both directions: a
// prompt already carried by an entry (the turn's own, a resumed run's, an
// earlier identical prompt) is never written twice, and a lane that booted
// but never admitted the prompt still gets its entry.
async function ensurePromptDurable(
  lane: Lane | undefined,
  session: SessionHandle,
  prompt: string,
  context: Context,
  report: (message: string) => void,
): Promise<void> {
  const entries = await captureEntries(lane, session, context);
  const present = entriesToTranscript(entries).some(
    (item) => item.kind === 'user' && item.text.trim() === prompt.trim(),
  );
  if (present) return;
  try {
    if (lane === undefined) {
      await appendPromptEntry(session, prompt, context);
    } else {
      await lane.conversation.commit(async (tx) => {
        await tx.appendEntry(UserEntry, lane.conversation.id, {
          model: [{ role: 'user', content: prompt, timestamp: Date.now() }],
        });
      }, context);
    }
  } catch (error) {
    report(
      `session: prompt not persisted: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

// One plain `pi.user` entry for a prompt no submission carried: a throwaway
// Harness over the session's own storage (no model layer is needed to write
// an entry), closed again immediately.
async function appendPromptEntry(
  session: SessionHandle,
  prompt: string,
  context: Context,
): Promise<void> {
  const harness = await Harness.open(
    session.adopt(),
    { models: createModels(), registry: createRegistry() },
    context,
  );
  try {
    // A forked session's prompt lands on its lane conversation.
    const conversation =
      session.meta.conversation === undefined
        ? await harness.root(context)
        : await harness.conversation(
            laneConversationIdOf(session.meta),
            context,
          );
    if (conversation === undefined)
      throw new Error(
        `session ${session.id}: its lane conversation is missing`,
      );
    await conversation.commit(async (tx) => {
      await tx.appendEntry(UserEntry, conversation.id, {
        model: [{ role: 'user', content: prompt, timestamp: Date.now() }],
      });
    }, context);
  } finally {
    await harness.close(context);
  }
}
