// The session's branches. pi-durable forks a conversation inside one storage
// (the fork inherits its parent's history through one entry), so a session is
// a tree of conversations: the lane runs one branch, and the TUI's `/tree`
// moves it to another — the branch whose history already ends at the chosen
// entry, or a new fork there. The branch left behind stays whole in the same
// storage. Labels on entries are a session document, not entries, so naming
// an entry never moves a branch's tip.
import {
  type Context,
  type Conversation,
  type ConversationId,
  defineDoc,
  type EntryId,
  type EntryRecord,
  type Harness,
  ROOT_CONVERSATION_ID,
} from '../pi-boundary.js';
import { KubicSessionDoc } from './session-store/meta.js';

/** One branch: a conversation, where it forked from, and its own entries. */
/** @internal */
export interface SessionBranch {
  readonly id: number;
  /** The branch it forked from and the entry it inherits history through. */
  readonly parent?: { readonly branch: number; readonly at: number };
  /** The entries this branch added, oldest first (inherited ones excluded). */
  readonly entries: readonly EntryRecord[];
}

interface EntryLabel {
  readonly text: string;
  /** When the label was set, ISO 8601. */
  readonly at: string;
}

export interface SessionTree {
  /** The branch the lane runs. */
  readonly lane: number;
  readonly branches: readonly SessionBranch[];
  /** Labels by entry id. */
  readonly labels: Readonly<Record<string, EntryLabel>>;
}

const KubicLabelsDoc = defineDoc<{
  labels: Record<string, { text: string; at: string }>;
}>({
  kind: 'kubic.labels',
  version: 1,
  scope: 'session',
  initial: () => ({ labels: {} }),
});

type BranchLane = {
  readonly harness: Pick<Harness, 'createConversation'>;
  readonly conversation: Pick<Conversation, 'id' | 'commit' | 'agent'>;
};

/** Where the lane goes: after entry `at` (seen from branch `from`), or to
 * an empty branch before the first entry (`at: null`). */
export type LaneTarget =
  | { readonly at: number; readonly from: number }
  | { readonly at: null };

type Tx = Parameters<Parameters<Conversation['commit']>[0]>[0];
type ConversationRecord = Awaited<
  ReturnType<Tx['scanConversations']>
>['items'][number];

const PAGE = 256;

// The lane's branches: conversations nobody owns. A task-owned conversation
// is a task's own transcript, never a branch the operator can move to.
async function branchRecords(tx: Tx): Promise<ConversationRecord[]> {
  const records: ConversationRecord[] = [];
  let page = await tx.scanConversations({}, PAGE);
  for (;;) {
    records.push(...page.items.filter((record) => record.owner === undefined));
    if (page.next === undefined) return records;
    page = await tx.scanConversations({}, PAGE, page.next);
  }
}

// A branch's own entries, oldest first. Its history is the parent's through
// the fork point plus what it added since, so the scan starts past the fork
// point; the ownership check keeps a stray inherited entry out.
async function ownEntries(
  tx: Tx,
  record: ConversationRecord,
): Promise<EntryRecord[]> {
  const query = {
    conversationId: record.id,
    ...(record.parent === undefined
      ? {}
      : { minEntryId: (Number(record.parent.at) + 1) as EntryId }),
  };
  const newestFirst: EntryRecord[] = [];
  let page = await tx.scanEntries(query, PAGE);
  for (;;) {
    newestFirst.push(...page.items);
    if (page.next === undefined) break;
    page = await tx.scanEntries(query, PAGE, page.next);
  }
  return newestFirst
    .filter((entry) => entry.conversationId === record.id)
    .reverse();
}

function branchOf(
  record: ConversationRecord,
  entries: readonly EntryRecord[],
): SessionBranch {
  return {
    id: Number(record.id),
    ...(record.parent === undefined
      ? {}
      : {
          parent: {
            branch: Number(record.parent.conversationId),
            at: Number(record.parent.at),
          },
        }),
    entries,
  };
}

/** Every branch of the lane's session, with the labels. */
export async function readSessionTree(
  lane: BranchLane,
  context: Context,
): Promise<SessionTree> {
  return lane.conversation.commit(async (tx) => {
    const branches: SessionBranch[] = [];
    for (const record of await branchRecords(tx)) {
      branches.push(branchOf(record, await ownEntries(tx, record)));
    }
    // A document's values live only inside the transaction: copy them out.
    const labels: Record<string, EntryLabel> = {};
    for (const [id, label] of Object.entries(
      (await tx.doc(KubicLabelsDoc)).labels,
    )) {
      labels[id] = { text: label.text, at: label.at };
    }
    return { lane: Number(lane.conversation.id), branches, labels };
  }, context);
}

// The newest entry of a branch's whole history: its last own entry, else the
// entry it forked at.
async function tipOf(
  tx: Tx,
  record: ConversationRecord,
): Promise<number | undefined> {
  const newest = (await tx.scanEntries({ conversationId: record.id }, 1))
    .items[0];
  return newest === undefined ? undefined : Number(newest.id);
}

// Before the first entry: an empty branch of its own, which starts with the
// lane's model and thinking level (the boot configures the rest). One that is
// already there is reused.
async function emptyBranch(
  lane: BranchLane,
  context: Context,
): Promise<number> {
  const found = await lane.conversation.commit(async (tx) => {
    for (const record of await branchRecords(tx)) {
      if (
        record.parent === undefined &&
        (await tipOf(tx, record)) === undefined
      )
        return record.id;
    }
    return undefined;
  }, context);
  let branch = found;
  if (branch === undefined) {
    const agent = await lane.conversation.agent(context);
    branch = (
      await lane.harness.createConversation(
        {
          ownership: { kind: 'ownerless' },
          agent: {
            ...(agent.model === undefined ? {} : { model: agent.model }),
            ...(agent.thinkingLevel === undefined
              ? {}
              : { thinkingLevel: agent.thinkingLevel }),
          },
        },
        context,
      )
    ).id;
  }
  const chosen = branch;
  await lane.conversation.commit(async (tx) => {
    (await tx.doc(KubicSessionDoc)).conversation = Number(chosen);
  }, context);
  return Number(chosen);
}

/**
 * Point the session's lane at the branch whose history ends at entry `at`,
 * forking one from branch `from` (which must see `at`) when none does.
 * Returns the branch; the lane runs it from its next boot. A branch that
 * added entries is preferred over an empty fork with the same tip.
 */
export async function moveLaneTo(
  lane: BranchLane,
  target: LaneTarget,
  context: Context,
): Promise<number> {
  if (target.at === null) return emptyBranch(lane, context);
  const { at, from } = target;
  return lane.conversation.commit(async (tx) => {
    let empty: ConversationId | undefined;
    let found: ConversationId | undefined;
    for (const record of await branchRecords(tx)) {
      if ((await tipOf(tx, record)) !== at) continue;
      // A tip past the fork point is an entry the branch added itself.
      if (Number(record.parent?.at ?? -1) < at) {
        found = record.id;
        break;
      }
      empty ??= record.id;
    }
    const branch =
      found ??
      empty ??
      (
        await tx.forkConversation(from as ConversationId, at as EntryId, {
          ownership: { kind: 'ownerless' },
        })
      ).id;
    const doc = await tx.doc(KubicSessionDoc);
    // The reserved root needs no record: a session without one runs it.
    if (branch === ROOT_CONVERSATION_ID) delete doc.conversation;
    else doc.conversation = Number(branch);
    return Number(branch);
  }, context);
}

/** Label an entry; `undefined` (or blank text) removes its label. */
export async function writeEntryLabel(
  lane: BranchLane,
  entryId: number,
  text: string | undefined,
  context: Context,
): Promise<void> {
  await lane.conversation.commit(async (tx) => {
    const doc = await tx.doc(KubicLabelsDoc);
    const key = String(entryId);
    const trimmed = text?.trim() ?? '';
    if (trimmed === '') delete doc.labels[key];
    else doc.labels[key] = { text: trimmed, at: new Date().toISOString() };
  }, context);
}
