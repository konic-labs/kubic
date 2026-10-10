// The session's branches over a real lane: a branch is a pi-durable fork
// inside the session's own storage. Moving the lane picks the branch whose
// history ends at the entry, or forks a new one there; labels live in a
// session document, so they never become entries.
import { afterEach, describe, expect, it } from 'vitest';
import {
  BACKGROUND_CONTEXT,
  type EntryRecord,
  fauxAssistantMessage,
} from '../pi-boundary.js';
import { bootFauxLane, type FauxLane } from '../test-support/lane-harness.js';
import {
  moveLaneTo,
  readSessionTree,
  type SessionBranch,
  writeEntryLabel,
} from './branches.js';
import { KubicSessionDoc } from './session-store/meta.js';

const lanes: FauxLane[] = [];

afterEach(async () => {
  for (const lane of lanes.splice(0)) await lane.cleanup();
});

async function threeTurns(): Promise<FauxLane> {
  const lane = await bootFauxLane({
    responses: [
      fauxAssistantMessage('one'),
      fauxAssistantMessage('two'),
      fauxAssistantMessage('three'),
    ],
  });
  lanes.push(lane);
  await lane.run('first');
  await lane.run('second');
  await lane.run('third');
  return lane;
}

function textOf(entry: EntryRecord): string {
  const message = entry.model?.[0] as { content?: unknown } | undefined;
  const content = message?.content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((part) => (part as { text?: unknown }).text)
    .filter((text): text is string => typeof text === 'string')
    .join('');
}

function entryWithText(branch: SessionBranch, text: string): EntryRecord {
  const entry = branch.entries.find((candidate) => textOf(candidate) === text);
  if (entry === undefined) throw new Error(`no entry says ${text}`);
  return entry;
}

async function laneDocument(lane: FauxLane): Promise<number | undefined> {
  return lane.lane.conversation.commit(
    async (tx) => (await tx.doc(KubicSessionDoc)).conversation,
    BACKGROUND_CONTEXT,
  );
}

describe('the session tree', () => {
  it('is one branch with every entry, oldest first, before anything forks', async () => {
    const lane = await threeTurns();
    const tree = await readSessionTree(lane.lane, BACKGROUND_CONTEXT);
    expect(tree.branches).toHaveLength(1);
    const [only] = tree.branches;
    expect(only?.id).toBe(tree.lane);
    expect(only?.parent).toBeUndefined();
    const prompts = (only?.entries ?? [])
      .filter((entry) => entry.kind === 'pi.user')
      .map(textOf);
    expect(prompts).toEqual(['first', 'second', 'third']);
    const ids = (only?.entries ?? []).map((entry) => Number(entry.id));
    expect(ids).toEqual([...ids].sort((a, b) => a - b));
    expect(tree.labels).toEqual({});
  });

  it('forks a new branch at an earlier entry, in the same storage', async () => {
    const lane = await threeTurns();
    const before = await readSessionTree(lane.lane, BACKGROUND_CONTEXT);
    const trunk = before.branches[0] as SessionBranch;
    const one = entryWithText(trunk, 'one');
    const moved = await moveLaneTo(
      lane.lane,
      { at: Number(one.id), from: trunk.id },
      BACKGROUND_CONTEXT,
    );
    expect(moved).not.toBe(trunk.id);
    expect(await laneDocument(lane)).toBe(moved);
    const after = await readSessionTree(lane.lane, BACKGROUND_CONTEXT);
    expect(after.branches).toHaveLength(2);
    const fork = after.branches.find((branch) => branch.id === moved);
    expect(fork?.parent).toEqual({ branch: trunk.id, at: Number(one.id) });
    expect(fork?.entries).toEqual([]);
  });

  it('switches to the branch that already ends at the entry instead of forking', async () => {
    const lane = await threeTurns();
    const trunk = (await readSessionTree(lane.lane, BACKGROUND_CONTEXT))
      .branches[0] as SessionBranch;
    const one = entryWithText(trunk, 'one');
    const fork = await moveLaneTo(
      lane.lane,
      { at: Number(one.id), from: trunk.id },
      BACKGROUND_CONTEXT,
    );
    // Back to the trunk's own tip: no third branch, and the root lane is
    // recorded as no fork at all.
    const tip = trunk.entries.at(-1) as EntryRecord;
    const back = await moveLaneTo(
      lane.lane,
      { at: Number(tip.id), from: trunk.id },
      BACKGROUND_CONTEXT,
    );
    expect(back).toBe(trunk.id);
    expect(await laneDocument(lane)).toBeUndefined();
    // And the empty fork is found again by its fork point.
    expect(
      await moveLaneTo(
        lane.lane,
        { at: Number(one.id), from: trunk.id },
        BACKGROUND_CONTEXT,
      ),
    ).toBe(fork);
    expect(
      (await readSessionTree(lane.lane, BACKGROUND_CONTEXT)).branches,
    ).toHaveLength(2);
  });

  it("starts an empty branch before the first entry, with the lane's model, and reuses it", async () => {
    const lane = await threeTurns();
    const empty = await moveLaneTo(lane.lane, { at: null }, BACKGROUND_CONTEXT);
    expect(await laneDocument(lane)).toBe(empty);
    const tree = await readSessionTree(lane.lane, BACKGROUND_CONTEXT);
    const branch = tree.branches.find((candidate) => candidate.id === empty);
    expect(branch?.parent).toBeUndefined();
    expect(branch?.entries).toEqual([]);
    const created = await lane.lane.harness.conversation(
      empty as never,
      BACKGROUND_CONTEXT,
    );
    expect((await created?.agent(BACKGROUND_CONTEXT))?.model).toEqual(
      (await lane.lane.conversation.agent(BACKGROUND_CONTEXT)).model,
    );
    expect(await moveLaneTo(lane.lane, { at: null }, BACKGROUND_CONTEXT)).toBe(
      empty,
    );
  });

  it('keeps labels in a session document, and clears one with nothing', async () => {
    const lane = await threeTurns();
    const trunk = (await readSessionTree(lane.lane, BACKGROUND_CONTEXT))
      .branches[0] as SessionBranch;
    const two = Number(entryWithText(trunk, 'two').id);
    await writeEntryLabel(lane.lane, two, 'checkpoint', BACKGROUND_CONTEXT);
    const labelled = await readSessionTree(lane.lane, BACKGROUND_CONTEXT);
    expect(labelled.labels[String(two)]?.text).toBe('checkpoint');
    expect(
      Number.isNaN(Date.parse(labelled.labels[String(two)]?.at ?? '')),
    ).toBe(false);
    // A label is not an entry: the branch's tip is unchanged.
    expect(labelled.branches[0]?.entries.at(-1)?.id).toBe(
      trunk.entries.at(-1)?.id,
    );
    await writeEntryLabel(lane.lane, two, undefined, BACKGROUND_CONTEXT);
    expect(
      (await readSessionTree(lane.lane, BACKGROUND_CONTEXT)).labels,
    ).toEqual({});
  });
});
