// The system prompt a session committed with its first turn.
import { PROMPT_SECTION } from '@kubic/agent/lane/boot';
import {
  attachSession,
  openSessionStore,
} from '@kubic/agent/lane/session-store';
import { readSessionEntries } from '@kubic/agent/lane/transcript';
import { BACKGROUND_CONTEXT, SystemEntry } from '@kubic/agent/pi-boundary';
import { createNodeFileBridge } from '@kubic/exec/file-bridge';

// The prompt the lane committed for this session (the reader).
export async function committedPrompt(
  root: string,
  sessionId: string,
): Promise<string> {
  const store = openSessionStore(root, createNodeFileBridge(root));
  const session = await attachSession(store, sessionId, BACKGROUND_CONTEXT);
  try {
    const entries = await readSessionEntries(
      session.storage,
      BACKGROUND_CONTEXT,
    );
    for (const entry of [...entries].reverse()) {
      if (!SystemEntry.is(entry)) continue;
      const messages = entry.model as unknown as
        | Array<{ sections?: Record<string, string | null> }>
        | undefined;
      const prompt = messages?.[0]?.sections?.[PROMPT_SECTION];
      if (typeof prompt === 'string' && prompt !== '') return prompt;
    }
    return '';
  } finally {
    await session.release(BACKGROUND_CONTEXT);
  }
}
