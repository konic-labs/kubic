// Kubic operations as pi-durable tools.
// One ToolRegistration per OPERATIONS entry: name/description/replay map
// straight across (alignment is structural, not coincidental) — the
// Kubic `never`/`safe` vocabulary becomes pi-durable's `unsafe`/`safe`, so
// an interrupted `never` call is never rerun and reaches the model as an
// `interrupted` error result carrying the output it had already committed.
// Every tool carries its real parameter schema
// from ops/registry.ts (OPERATION_PARAMETERS — the single source) and
// declares json_schema constrained sampling with strict 'prefer', so capable
// providers enforce valid arguments; pi-durable validates against the same
// schema before execute, and Kubic's validators stay authoritative after it.
// read/bash/grep results reach the model as plain text under a short header
// (raw lines, never JSON-escaped); the other ops keep their JSON result.
// Structured op errors are returned as model-readable content; only
// unexpected throws propagate to the harness, which turns them into its own
// error result.
//
// Pi 1.0 surface: the durable execute signature is
// `execute(args, api, context)`, so the Kubic context
// (env, sessionId, agentId, journal, kills) is captured in this closure:
//
// - identity: `api.callId` is the invocationId (and the journal's
//   `toolCallId`), `api.taskId` is the operationId, and `context` carries
//   cancellation. The durable task IS the call's identity: operationId and
//   turnId both name it.
// - cancellation: `context.abortSignal` becomes `OpContext.signal`, so an
//   aborted lane run kills in-flight children through the same op code path
//   as a timeout (bash's own abort listener). The kill registry stays as the
//   TUI's best-effort backstop and is keyed by the conversation id — the
//   durable scope of the one live run — so a lane abort can drain it.
// - memos: `ToolInvocation.getMemo`/`setMemo`/`memoOnce` are `api.memo`, so
//   an op that memoizes something gets the durable, first-writer-wins store
//   of its own task. `keepEffectMemo: false` tells `callOperation` not to
//   copy a never-replay RESULT into a memo: pi-durable's `replay: 'unsafe'`
//   never re-enters `execute`, so that copy could never be read and would
//   cost one extra durable write (and a second copy) per effect.
// - running output: `api.output(chunk)` feeds the live view. Kubic's own
//   caps stay authoritative for the model-visible result (see
//   OUTPUT_BACKSTOP and BASH_OUTPUT_LIMITS), so semantics do not
//   move into the harness.
import type {
  CheckpointStore,
  ExecutionEnv,
  ProcessSnapshot,
} from '@kubic/exec/env';
import type { FileJournalStore } from '@kubic/exec/journal';
import { BASH_RESULT_MAX_CHARS, type BashResult } from '../ops/bash.js';
import type { ToolDisplay } from '../ops/display-diff.js';
import type { GrepResult } from '../ops/grep.js';
import { GREP_MAX_LINE_LENGTH } from '../ops/grep.js';
import type { ReadResult } from '../ops/read.js';
import {
  callOperation,
  OPERATION_PARAMETERS,
  OPERATIONS,
  type OperationName,
} from '../ops/registry.js';
import type { OpContext, ToolInvocation } from '../ops/types.js';
import {
  type Context,
  defineTool,
  type JsonValue,
  type ToolExecutionApi,
  type ToolRegistration,
} from '../pi-boundary.js';
import type { SpillSink } from '../spill.js';
import type { OperationKillRegistry } from './abort.js';

export interface KubicToolContext {
  env: ExecutionEnv;
  sessionId: string;
  agentId: string;
  kills: OperationKillRegistry;
  checkpointStore?: CheckpointStore;
  // Session journal for interception: when set, write/edit
  // record every mutation. Wired by the lane in; absent in tests
  // and journal-free contexts.
  journal?: FileJournalStore;
  // Interactive turn supplier: the lane installs its boot
  // option here; the adapter samples it per call into `OpContext.turn`.
  // A supplier returning `undefined` writes no field (unwired cell).
  currentTurn?: () => number | undefined;
  // Session-scoped spill sink: when set, a bash stream clipped
  // for the model's context window is written here in full and the result
  // names the path. Wired by the lane from its session directory; absent in
  // tests, where the clip notice names no path.
  spill?: SpillSink;
}

// What a tool result records beside the model's text: the call's ids, the
// failure code, and for edit and write the display record the TUI draws its
// inline diff from. A union, not optional fields: pi-durable types tool
// details as JsonValue, which has no `undefined` property.
type KubicToolDetails =
  | {
      readonly ok: true;
      readonly toolCallId: string;
      readonly invocationId: string;
    }
  | {
      readonly ok: true;
      readonly toolCallId: string;
      readonly invocationId: string;
      // The change's display record (edit/write) — the TUI's
      // inline diff. The model never sees details.
      readonly display: DisplayRecord;
    }
  | { readonly ok: false; readonly toolCallId: string; readonly code: string };

// The display record as plain JSON (no optional fields — details are
// JsonValue).
type DisplayRecord =
  | {
      readonly kind: 'diff';
      readonly text: string;
      readonly firstChangedLine: number;
      readonly added: number;
      readonly removed: number;
      readonly truncated: boolean;
    }
  | {
      readonly kind: 'write';
      readonly newFile: boolean;
      readonly lines: number;
      readonly preview: string;
    };

function displayRecord(display: ToolDisplay): DisplayRecord {
  return display.kind === 'diff'
    ? {
        kind: 'diff',
        text: display.text,
        firstChangedLine: display.firstChangedLine,
        added: display.added,
        removed: display.removed,
        truncated: display.truncated === true,
      }
    : display;
}

// The durable harness bounds whatever a tool reports (2000 lines / 50 KiB by
// default) and appends its own `truncated` diagnostic — which would edit
// model-visible text Kubic already bounded itself (bash 64 KiB per
// stream; read 51200B, exactly the harness default). These limits sit
// an order of magnitude above every Kubic cap, so the harness's trimming can
// never be the binding bound and the model sees exactly what the op
// rendered; they exist only as a memory backstop for the running-output
// buffer. Pinned by test so lowering them is a deliberate, visible act.
const OUTPUT_BACKSTOP = {
  maxBytes: 8 * 1024 * 1024,
  maxLines: 100_000,
  retain: 'head',
} as const;

// bash is the one op that STREAMS (api.output), and on the interrupted path
// pi-durable hands the model the retained live output as the result content —
// `renderBashText` never runs, so its cap cannot apply there. Retaining
// the tail within four times the per-stream cap keeps that content the same
// order of magnitude as a normal bash result (two capped streams plus their
// markers stay well inside the window, so the head/tail choice never edits a
// completed call), while a command that streams megabytes before a crash cannot
// put the 8 MiB backstop into the model's context. `retain: 'tail'`
// matches `clip()`: endings carry the error.
const BASH_OUTPUT_LIMITS = {
  maxBytes: 4 * BASH_RESULT_MAX_CHARS,
  maxLines: 100_000,
  retain: 'tail',
} as const;

/** The deferred-answer channel an op reads and writes through its invocation. */
function toInvocation(api: ToolExecutionApi, context: Context): ToolInvocation {
  return {
    invocationId: api.callId,
    operationId: String(api.taskId),
    turnId: String(api.taskId),
    // pi-durable settles an interrupted `unsafe` call without re-entering
    // execute, so the registry's never-replay memo would be an unreadable
    // second durable copy of the result.
    keepEffectMemo: false,
    getMemo: (name: string) => api.memo<JsonValue>(name, context),
    setMemo: async (name, value) => {
      // pi-durable memos hold JSON and have no delete; nothing in Kubic
      // writes `undefined` (registry.ts stores an OpResult), and dropping
      // such a write is safer than storing `null`, which a later getMemo
      // would hand back as a result.
      if (value === undefined) return;
      await api.memo(name, value, context);
    },
    // First-writer-wins in the durable task record — atomic across a crash
    // and a recovery rerun.
    memoOnce: (name, candidate) => api.memo(name, candidate, context),
  };
}

/** The appended part of a cumulative snapshot, or all of a trimmed stream. */
function appended(previous: string, next: string): string {
  // env.ts keeps the tail once its 10 MiB per-stream cap trims the head, so
  // the retained text stops being an extension of the previous snapshot and
  // the live view restarts from what the seam still holds.
  return next.startsWith(previous) ? next.slice(previous.length) : next;
}

// Running output for the live view: pi-durable exposes one
// append-only output stream per call, while a Kubic ProcessSnapshot is two
// cumulative streams. Only what was appended is pushed, each stream
// announced once so the live text reads like the tail of the final result.
function createOutputStreamer(
  api: ToolExecutionApi,
): (snapshot: ProcessSnapshot) => void {
  let stdout = '';
  let stderr = '';
  let stdoutOpen = false;
  let stderrOpen = false;
  return (snapshot) => {
    const nextOut = appended(stdout, snapshot.stdout);
    const nextErr = appended(stderr, snapshot.stderr);
    stdout = snapshot.stdout;
    stderr = snapshot.stderr;
    if (nextOut !== '') {
      api.output(`${stdoutOpen ? '' : '--- stdout ---\n'}${nextOut}`);
      stdoutOpen = true;
    }
    if (nextErr !== '') {
      api.output(`${stderrOpen ? '' : '--- stderr ---\n'}${nextErr}`);
      stderrOpen = true;
    }
  };
}

function lineCount(text: string): number {
  if (text.length === 0) return 0;
  const lines = text.split('\n');
  return lines[lines.length - 1] === '' ? lines.length - 1 : lines.length;
}

function withNewline(text: string): string {
  return text.length === 0 || text.endsWith('\n') ? text : `${text}\n`;
}

// `[read <path>: lines a-b of N]` + the raw lines. `of at least N` when the
// read was cut (totalLines is then a lower bound); `more: offset=K` whenever
// lines remain past the window, so the model knows how to continue. A
// refusal or cut notice rides the same header — or replaces
// the empty-window text, since "no lines at offset K" would misname a line
// that exists but exceeds the output cap.
function renderReadText(result: ReadResult): string {
  const shown = lineCount(result.content);
  const total = `${result.truncated ? 'at least ' : ''}${result.totalLines}`;
  if (shown === 0) {
    if (result.notice !== undefined) {
      return `[read ${result.path}: ${result.notice}]\n`;
    }
    return result.totalLines === 0 && !result.truncated
      ? `[read ${result.path}: empty (0 lines)]\n`
      : `[read ${result.path}: no lines at offset ${result.offset} (file has ${total} lines)]\n`;
  }
  const end = result.offset + shown - 1;
  const more =
    result.truncated || end < result.totalLines
      ? `; more: offset=${end + 1}`
      : '';
  const notice = result.notice === undefined ? '' : `; ${result.notice}`;
  return `[read ${result.path}: lines ${result.offset}-${end} of ${total}${more}${notice}]\n${withNewline(result.content)}`;
}

// `[grep /<pattern>/: N matches]` + one `path:line: text` per match.
/** @internal */
export function renderGrepText(result: GrepResult): string {
  const count = result.matches.length;
  // A cut result names WHICH cap stopped it: the walk's entry
  // cap with the directory it exhausted, the depth cap with where it pruned,
  // or maxMatches — the model narrows differently for each. The flags a
  // model must not miss ride along: clipped match text (a
  // partial line read as a whole one is a wrong answer) and the files grep
  // did not search.
  const flags: string[] = [];
  if (result.truncated) {
    flags.push('truncated (narrow pattern, root or include)');
  }
  if (result.linesTruncated === true) {
    flags.push(`lines clipped at ${GREP_MAX_LINE_LENGTH} chars`);
  }
  if ((result.skippedBinary ?? 0) > 0) {
    flags.push(`${result.skippedBinary} binary file(s) skipped`);
  }
  if ((result.skippedOversized ?? 0) > 0) {
    flags.push(`${result.skippedOversized} oversized file(s) skipped`);
  }
  const cut =
    flags.length === 0
      ? ''
      : `, ${flags.join(', ')}${
          result.notice === undefined ? '' : `: ${result.notice}`
        }`;
  const head = `[grep /${result.pattern}/: ${count} ${count === 1 ? 'match' : 'matches'}${cut}]\n`;
  return (
    head +
    result.matches
      .map((match) => `${match.path}:${match.line}: ${match.text}\n`)
      .join('')
  );
}

// `[bash exit <code> (<shell>)]` + the raw streams, each under its own
// marker; flags name a timeout, an abort, or a clipped stream.
function renderBashText(result: BashResult): string {
  const flags = [
    result.timedOut ? 'timed out' : undefined,
    result.aborted ? 'aborted' : undefined,
    result.truncated ? 'output truncated' : undefined,
  ].filter((flag): flag is string => flag !== undefined);
  const head = `[bash exit ${result.exitCode ?? 'none'} (${result.shell})${
    flags.length === 0 ? '' : `, ${flags.join(', ')}`
  }]\n`;
  const streams = [
    result.stdout.length === 0
      ? ''
      : `--- stdout ---\n${withNewline(result.stdout)}`,
    result.stderr.length === 0
      ? ''
      : `--- stderr ---\n${withNewline(result.stderr)}`,
  ].join('');
  return head + (streams.length === 0 ? '(no output)\n' : streams);
}

// The model-facing text for a successful op result.
function renderToolText(name: string, result: unknown): string {
  if (name === 'read') return renderReadText(result as ReadResult);
  if (name === 'grep') return renderGrepText(result as GrepResult);
  if (name === 'bash') return renderBashText(result as BashResult);
  return JSON.stringify(result);
}

export function kubicToolsToPiTools(
  context: KubicToolContext,
): ToolRegistration[] {
  return Object.values(OPERATIONS).map((op) =>
    defineTool({
      name: op.name,
      description: op.description,
      parameters: OPERATION_PARAMETERS[op.name as OperationName],
      constrainedSampling: { type: 'json_schema', strict: 'prefer' },
      replay: op.replay === 'never' ? 'unsafe' : 'safe',
      outputLimits: op.name === 'bash' ? BASH_OUTPUT_LIMITS : OUTPUT_BACKSTOP,
      execute: async (args, api, callContext) => {
        const inv = toInvocation(api, callContext);
        const opContext: OpContext = {
          env: context.env,
          sessionId: context.sessionId,
          agentId: context.agentId,
          checkpointStore: context.checkpointStore,
          // The pi-durable call id is the journal's attribution key: without
          // it, intercepted entries could not name their call.
          toolCallId: api.callId,
          journal: context.journal,
          // Sampled per call, so the entry shares the
          // numbering of the turn in flight — never a boot-time snapshot.
          turn: context.currentTurn?.(),
          spill: context.spill,
          signal: callContext.abortSignal,
          trackHandle: (kill) =>
            context.kills.track(String(api.conversationId), kill),
          onUpdate: createOutputStreamer(api),
          display: (record) => {
            display = record;
          },
        };
        let display: ToolDisplay | undefined;
        const out = await callOperation(op.name, args, inv, opContext);
        const details: KubicToolDetails = out.ok
          ? {
              ok: true,
              toolCallId: api.callId,
              invocationId: inv.invocationId,
              ...(display === undefined
                ? {}
                : { display: displayRecord(display) }),
            }
          : { ok: false, toolCallId: api.callId, code: out.error.code };
        const text = out.ok
          ? renderToolText(op.name, out.result)
          : `error ${out.error.code}: ${out.error.message}`;
        return { output: [{ type: 'text', text }], details };
      },
    }),
  );
}
