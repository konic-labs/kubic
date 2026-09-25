// Run spans on the live headless path (issue #98; §49.3, §50, §61).
// Maps the real headless-run events (lane accept, lane drive, harness tool
// hooks) onto the §29 SpanRecorder, so a live `kubic run` records spans
// instead of leaving §49.3 unimplemented. Destination is documented in
// docs/packages/host.md and docs/cli/commands.md:
//   - durable artifact: <sessions-root>/<id>/spans.jsonl (one JSON record
//     per span, written by the composition root next to the journal),
//   - stderr debug lines on the existing §50 vocabulary (`[agent]` lane
//     lines, `[tool]` in/out lines) behind `kubic run --debug`.
// No new debug class is invented: DEBUG_CLASSES stays the pinned nine.
// Never blocks a tool call — the hook handlers are total and return
// undefined, so telemetry can only observe the lane, never fail it.

import {
  DebugLog,
  type DebugSink,
  type SpanRecord,
  SpanRecorder,
} from '../../spans.js';

export const RUN_SPAN_NAMES = {
  run: 'kubic.agent.run',
  accept: 'kubic.lane.accept',
  drive: 'kubic.lane.drive',
  tool: 'pi.tool.execute',
} as const;

export type RunSpanName = (typeof RUN_SPAN_NAMES)[keyof typeof RUN_SPAN_NAMES];

export interface RunSpanRecord extends SpanRecord {
  // Present on pi.tool.execute spans only: which tool the call ran.
  toolName?: string;
}

export interface ToolHookEvent {
  toolCallId: string;
  toolName: string;
  isError?: boolean;
}

// The minimal slice of the harness hook registry this module needs. The real
// `Hooks` seam (worker/pi-boundary) satisfies it structurally, so the
// composition root passes `harness.hooks` straight through.
export interface ToolHookRegistry {
  on(
    name: 'before_tool' | 'after_tool',
    handler: (event: ToolHookEvent) => undefined,
  ): () => void;
}

export class RunSpans {
  private readonly recorder: SpanRecorder;
  private readonly debug: DebugLog;
  private readonly lines: string[] = [];
  private readonly toolNames = new Map<string, string>();
  private readonly openCalls = new Map<string, string>();
  private readonly endMs = new Map<string, number | null>();
  private readonly startMs = new Map<string, number>();
  private runId: string | null = null;
  private laneId: string | null = null;

  constructor(clock?: () => number, sink?: DebugSink) {
    const debug = new DebugLog((line: string) => {
      this.lines.push(line);
      sink?.(line);
    });
    this.recorder = new SpanRecorder(clock);
    this.debug = debug;
  }

  startRun(): string {
    const id = this.recorder.start(RUN_SPAN_NAMES.run);
    this.runId = id;
    this.remember(id);
    this.debug.agent('run start');
    return id;
  }

  endRun(id: string, error?: string): void {
    const elapsed = this.close(id, error);
    this.debug.agent(`run end ms=${String(elapsed)}${this.suffix(error)}`);
  }

  startLane(name: 'accept' | 'drive'): string {
    const id = this.recorder.start(`kubic.lane.${name}`, this.runId);
    this.laneId = id;
    this.remember(id);
    this.debug.agent(`lane ${name} start`);
    return id;
  }

  endLane(id: string, error?: string): void {
    const elapsed = this.close(id, error);
    if (this.laneId === id) this.laneId = null;
    this.debug.agent(`lane end ms=${String(elapsed)}${this.suffix(error)}`);
  }

  startTool(toolCallId: string, toolName: string): string {
    const id = this.recorder.start(
      RUN_SPAN_NAMES.tool,
      this.laneId ?? this.runId,
    );
    this.remember(id);
    this.toolNames.set(id, toolName);
    this.openCalls.set(toolCallId, id);
    this.debug.tool('in', `${toolName} call=${toolCallId}`);
    return id;
  }

  // Idempotent and total: an unknown or already-closed call is ignored so a
  // repeated/absent harness event can never fail the lane.
  endTool(toolCallId: string, error?: string): void {
    const id = this.openCalls.get(toolCallId);
    if (id === undefined) return;
    this.openCalls.delete(toolCallId);
    const elapsed = this.close(id, error);
    const toolName = this.toolNames.get(id) ?? 'unknown';
    this.debug.tool(
      'out',
      `${toolName} call=${toolCallId} ms=${String(elapsed)} ` +
        `status=${error === undefined ? 'ok' : 'error'}${this.suffix(error)}`,
    );
  }

  trace(): RunSpanRecord[] {
    return this.recorder.trace().map((span) => {
      const toolName = this.toolNames.get(span.id);
      return toolName === undefined ? { ...span } : { ...span, toolName };
    });
  }

  debugLines(): string[] {
    return [...this.lines];
  }

  private remember(id: string): void {
    const span = this.recorder.trace().find((entry) => entry.id === id);
    this.startMs.set(id, span?.startMs ?? 0);
    this.endMs.set(id, null);
  }

  // Closes a span once and returns its duration; a repeat close is a no-op
  // returning the already-recorded duration (never throws).
  private close(id: string, error?: string): number {
    if (this.endMs.get(id) === null) {
      this.recorder.end(id, error);
      const span = this.recorder.trace().find((entry) => entry.id === id);
      this.endMs.set(id, span?.endMs ?? null);
    }
    const end = this.endMs.get(id);
    if (end === null || end === undefined) return 0;
    return end - (this.startMs.get(id) ?? end);
  }

  private suffix(error: string | undefined): string {
    return error === undefined ? '' : ` error=${error}`;
  }
}

export function serializeSpanArtifact(
  spans: readonly RunSpanRecord[],
  runId: string,
  sessionId: string,
): string {
  return `${spans
    .map((span) =>
      JSON.stringify({
        run: runId,
        sessionId,
        id: span.id,
        name: span.name,
        parentId: span.parentId,
        startMs: span.startMs,
        endMs: span.endMs,
        ...(span.error === undefined ? {} : { error: span.error }),
        ...(span.toolName === undefined ? {} : { toolName: span.toolName }),
      }),
    )
    .join('\n')}\n`;
}

// Harness hook attachment: opens a pi.tool.execute span on before_tool and
// closes it on after_tool. Returns the detach function the caller runs on
// the way out. Handlers resolve undefined — telemetry never blocks a call.
export function attachToolSpans(
  registry: ToolHookRegistry,
  spans: RunSpans,
): () => void {
  const offBefore = registry.on('before_tool', (event) => {
    spans.startTool(event.toolCallId, event.toolName);
    return undefined;
  });
  const offAfter = registry.on('after_tool', (event) => {
    spans.endTool(
      event.toolCallId,
      event.isError === true ? 'tool reported an error' : undefined,
    );
    return undefined;
  });
  return () => {
    offBefore();
    offAfter();
  };
}
