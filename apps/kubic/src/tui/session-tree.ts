// `/tree`: the session's branches as one tree, the way pi shows a session.
// The branches come from the session's own storage (a branch is a pi-durable
// fork of the lane inside it). Choosing an entry moves the lane there: onto
// the branch that already ends at it, or onto a new branch forked at it, and
// the session reboots on that branch in place. A prompt goes back into the
// editor, the branch cut just before it; any other entry is where the next
// prompt continues. The branch left behind stays whole in the session.
import { homedir } from 'node:os';
import type { SessionTree } from '@kubic/agent/lane/branches';
import type { EntryRecord } from '@kubic/agent/pi-boundary';
import type { TreeEntryLike } from '@kubic/tui/session-tree';
import type { TuiSubmitOutcome } from '@kubic/tui/tui-app';
import {
  busyRefusal,
  refuse,
  type TuiCommandTable,
} from './commands/handler.js';
import type { TuiContext } from './context.js';
import { rebootSession } from './session-switch.js';

// The longest command a tool row shows before it is cut.
const BASH_CHARS = 50;
const ARGS_CHARS = 40;
// The longest error a failed reply's row shows.
const ERROR_CHARS = 80;

interface ToolCall {
  readonly name: string;
  readonly args: Record<string, unknown>;
}

type MessageLike = {
  readonly content?: unknown;
  readonly stopReason?: unknown;
  readonly errorMessage?: unknown;
  readonly toolCallId?: unknown;
  readonly toolName?: unknown;
};

function messageOf(entry: EntryRecord): MessageLike | undefined {
  return entry.model?.[0] as MessageLike | undefined;
}

function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((part: { type?: unknown; text?: unknown }) =>
      part.type === 'text' && typeof part.text === 'string' ? part.text : '',
    )
    .join('');
}

function shortPath(path: string, home: string): string {
  return home !== '' && path.startsWith(home)
    ? `~${path.slice(home.length)}`
    : path;
}

/** A tool call on one line, as pi's tree shows it: `bash: ls`. */
/** @internal */
export function toolCallText(call: ToolCall, home: string = homedir()): string {
  const { name, args } = call;
  const path = shortPath(String(args.path ?? args.file_path ?? '.'), home);
  switch (name) {
    case 'read': {
      const offset = typeof args.offset === 'number' ? args.offset : undefined;
      const limit = typeof args.limit === 'number' ? args.limit : undefined;
      if (offset === undefined && limit === undefined) return `read: ${path}`;
      const start = offset ?? 1;
      return `read: ${path}:${start}${limit === undefined ? '' : `-${start + limit - 1}`}`;
    }
    case 'write':
    case 'edit':
    case 'ls':
      return `${name}: ${path}`;
    case 'bash': {
      const command = String(args.command ?? '')
        .replace(/\s+/g, ' ')
        .trim();
      const cut = [...command].slice(0, BASH_CHARS).join('');
      return `bash: ${cut}${cut.length < command.length ? '…' : ''}`;
    }
    case 'grep':
      return `grep: /${String(args.pattern ?? '')}/ in ${path}`;
    case 'find':
      return `find: ${String(args.pattern ?? '')} in ${path}`;
    default: {
      const json = JSON.stringify(args);
      return `${name}: ${json.slice(0, ARGS_CHARS)}${json.length > ARGS_CHARS ? '…' : ''}`;
    }
  }
}

// The tool calls of every reply, by call id: a result's row names its call.
function toolCallsOf(entries: readonly EntryRecord[]): Map<string, ToolCall> {
  const calls = new Map<string, ToolCall>();
  for (const entry of entries) {
    if (entry.kind !== 'pi.assistant') continue;
    const content = messageOf(entry)?.content;
    if (!Array.isArray(content)) continue;
    for (const part of content as Array<Record<string, unknown>>) {
      if (part.type !== 'toolCall' || typeof part.id !== 'string') continue;
      calls.set(part.id, {
        name: String(part.name ?? 'tool'),
        args: (part.arguments as Record<string, unknown> | undefined) ?? {},
      });
    }
  }
  return calls;
}

// One stored entry as a tree row's facts.
function treeFacts(
  entry: EntryRecord,
  calls: ReadonlyMap<string, ToolCall>,
): Pick<TreeEntryLike, 'kind' | 'text' | 'state' | 'copyText'> {
  const message = messageOf(entry);
  const text = textOf(message?.content);
  const copy = text.trim() === '' ? {} : { copyText: text };
  switch (entry.kind) {
    case 'pi.user':
      return { kind: 'user', text, ...copy };
    case 'pi.assistant': {
      if (text.trim() !== '') return { kind: 'assistant', text, ...copy };
      if (message?.stopReason === 'aborted') {
        return { kind: 'assistant', text: '', state: 'aborted' };
      }
      if (typeof message?.errorMessage === 'string') {
        const error = message.errorMessage.replace(/\s+/g, ' ').trim();
        return {
          kind: 'assistant',
          text: error.slice(0, ERROR_CHARS),
          state: 'error',
          copyText: message.errorMessage,
        };
      }
      return { kind: 'assistant', text: '', state: 'empty' };
    }
    case 'pi.tool-result': {
      const id =
        typeof message?.toolCallId === 'string' ? message.toolCallId : '';
      const call = calls.get(id);
      const name =
        typeof message?.toolName === 'string' ? message.toolName : 'tool';
      return {
        kind: 'tool',
        text: call === undefined ? name : toolCallText(call),
        ...copy,
      };
    }
    case 'pi.system':
      return { kind: 'system', text: '' };
    case 'pi.compaction': {
      const reason = (entry.data as { reason?: unknown } | undefined)?.reason;
      return {
        kind: 'compaction',
        text: typeof reason === 'string' ? reason : '',
        ...copy,
      };
    }
    case 'pi.reset':
      return { kind: 'reset', text, ...copy };
    default:
      return { kind: 'custom', text: entry.kind };
  }
}

interface SessionTreeEntries {
  /** Parents first. */
  readonly entries: readonly TreeEntryLike[];
  /** The entry the lane is at. */
  readonly currentId: string | null;
  /** Which branch each entry belongs to. */
  readonly branchOf: ReadonlyMap<string, number>;
}

/** The session's branches as the tree's entries. */
/** @internal */
export function sessionTreeEntries(tree: SessionTree): SessionTreeEntries {
  const branchOf = new Map<string, number>();
  const parentOf = new Map<string, string | null>();
  const records: EntryRecord[] = [];
  let currentId: string | null = null;
  for (const branch of tree.branches) {
    let previous =
      branch.parent === undefined ? null : String(branch.parent.at);
    for (const entry of branch.entries) {
      const id = String(entry.id);
      branchOf.set(id, branch.id);
      parentOf.set(id, previous);
      records.push(entry);
      previous = id;
    }
    if (branch.id === tree.lane) currentId = previous;
  }
  records.sort((a, b) => Number(a.id) - Number(b.id));
  const calls = toolCallsOf(records);
  const entries = records.map((entry): TreeEntryLike => {
    const id = String(entry.id);
    const label = tree.labels[id];
    return {
      id,
      parentId: parentOf.get(id) ?? null,
      ...treeFacts(entry, calls),
      ...(label === undefined ? {} : { label: label.text, labelAt: label.at }),
    };
  });
  return { entries, currentId, branchOf };
}

// Where the lane goes for a chosen entry: a prompt is retried from just
// before it (its text back in the editor), anything else is continued from.
function destination(entry: TreeEntryLike): {
  readonly at: string | null;
  readonly prefill?: string;
} {
  if (entry.kind !== 'user') return { at: entry.id };
  return { at: entry.parentId, prefill: entry.copyText ?? entry.text };
}

async function moveTo(
  ctx: TuiContext,
  shown: SessionTreeEntries,
  entry: TreeEntryLike,
): Promise<void> {
  const { at, prefill } = destination(entry);
  const loop = ctx.boot.loop;
  const tree = loop?.sessionTree;
  if (loop === undefined || tree === undefined) {
    throw new Error('this session has no tree');
  }
  // Before the first prompt is an empty branch of its own.
  if (at === null) {
    await tree.moveTo({ at: null }, loop.context);
    await rebootSession(ctx);
  } else if (at !== shown.currentId) {
    const from = shown.branchOf.get(at);
    if (from === undefined) {
      throw new Error(`entry #${at} is not in this session`);
    }
    await tree.moveTo({ at: Number(at), from }, loop.context);
    await rebootSession(ctx);
  }
  if (prefill !== undefined) ctx.app.editor.setText(prefill);
  ctx.app.setEditorFooter(
    prefill === undefined
      ? 'tree: at the selected point — the next prompt continues from here'
      : 'tree: at the selected point — edit the prompt and press enter',
  );
}

export const sessionTreeCommands: TuiCommandTable = {
  tree: {
    run(ctx, { busy }) {
      return openSessionTree(ctx, busy);
    },
  },
};

/** `/tree`: read the session's branches and open the tree on them. */
function openSessionTree(ctx: TuiContext, busy: boolean): TuiSubmitOutcome {
  if (busy) return busyRefusal(ctx, 'tree');
  const loop = ctx.boot.loop;
  const tree = loop?.sessionTree;
  if (loop === undefined || tree === undefined) {
    return refuse(ctx, 'tree: this session has no tree');
  }
  void tree
    .read(loop.context)
    .then((data) => {
      if (ctx.stopped) return;
      const shown = sessionTreeEntries(data);
      if (shown.entries.length === 0) {
        ctx.app.setEditorFooter('tree: nothing in this session yet');
        ctx.render();
        return;
      }
      ctx.app.openSessionTree({
        entries: shown.entries,
        currentId: shown.currentId,
        onSelect: (entry) => {
          if (entry.id === shown.currentId) {
            ctx.app.setEditorFooter('tree: already here');
            ctx.render();
            return;
          }
          void moveTo(ctx, shown, entry)
            .catch((error: unknown) => {
              if (ctx.stopped) return;
              ctx.app.setEditorFooter(
                `tree: ${error instanceof Error ? error.message : String(error)}`,
              );
            })
            .finally(() => ctx.render());
        },
        onLabel: (id, label) => {
          void tree
            .label(Number(id), label, loop.context)
            .catch((error: unknown) => {
              if (ctx.stopped) return;
              ctx.app.setEditorFooter(
                `tree: the label was not saved — ${error instanceof Error ? error.message : String(error)}`,
              );
              ctx.render();
            });
        },
      });
      ctx.render();
    })
    .catch((error: unknown) => {
      if (ctx.stopped) return;
      ctx.app.setEditorFooter(
        `tree: ${error instanceof Error ? error.message : String(error)}`,
      );
      ctx.render();
    });
  return 'accepted';
}
