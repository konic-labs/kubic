// Typed telemetry spans (issue #29; §49.3, §61): nesting
// kubic.agent.run→pi.harness.hook→pi.tool.execute→kubic.worker.start→rpc
// with the kubic.worker.startup span isolated from tool ms. Host-side
// recorder only — Pi owns its own telemetry; this module never imports
// worker implementation or Pi modules.

export const SPAN_NAMES = [
  'kubic.agent.run',
  'pi.harness.hook',
  'pi.tool.execute',
  'kubic.worker.start',
  'kubic.worker.startup',
  'rpc',
] as const;

export type SpanName = (typeof SPAN_NAMES)[number] | string;

export interface SpanRecord {
  id: string;
  name: SpanName;
  parentId: string | null;
  startMs: number;
  endMs: number | null;
  error?: string;
}

export class SpanRecorder {
  private spans: SpanRecord[] = [];
  // Issue #243: O(1) lookup by id. The array keeps insertion order for
  // `trace()`; the map serves the per-span hot path (`end`, `get`) so a
  // run with N spans costs O(N), not O(N^2).
  private readonly byId = new Map<string, SpanRecord>();
  private seq = 0;
  private readonly clock: () => number;

  constructor(clock?: () => number) {
    this.clock = clock ?? Date.now;
  }

  start(name: SpanName, parentId?: string | null): string {
    const id = `span-${this.seq}`;
    this.seq += 1;
    const record: SpanRecord = {
      id,
      name,
      parentId: parentId ?? null,
      startMs: this.clock(),
      endMs: null,
    };
    this.spans.push(record);
    this.byId.set(id, record);
    return id;
  }

  end(id: string, error?: string): void {
    const span = this.byId.get(id);
    if (span === undefined) throw new Error(`unknown span ${id}`);
    span.endMs = this.clock();
    if (error !== undefined) span.error = error;
  }

  // Issue #290: close a span at a measured-elsewhere end time. The
  // manager-side startup span reports the registry's startupMs, not a
  // second wall-clock read, so the artifact duration equals it exactly.
  endAt(id: string, endMs: number, error?: string): void {
    const span = this.byId.get(id);
    if (span === undefined) throw new Error(`unknown span ${id}`);
    span.endMs = endMs;
    if (error !== undefined) span.error = error;
  }

  // Issue #243: read one span without copying the trace. The copy keeps
  // the ledger tamper-proof: a reader mutating the return never rewrites
  // a stored record (pinned by test).
  get(id: string): SpanRecord | undefined {
    const span = this.byId.get(id);
    return span === undefined ? undefined : { ...span };
  }

  trace(): SpanRecord[] {
    return this.spans.map((span) => ({ ...span }));
  }

  private durationMs(span: SpanRecord): number {
    return span.endMs === null ? 0 : span.endMs - span.startMs;
  }

  // §61: worker startup is reported apart — never folded into tool ms.
  startupMs(): number | null {
    const startup = this.spans.find(
      (span) => span.name === 'kubic.worker.startup',
    );
    if (startup === undefined || startup.endMs === null) return null;
    return this.durationMs(startup);
  }

  // Per-tool time only: pi.tool.execute spans, startup excluded.
  toolMsTotal(): number {
    return this.spans
      .filter((span) => span.name === 'pi.tool.execute')
      .reduce((total, span) => total + this.durationMs(span), 0);
  }
}

// --debug stderr vocabulary (§50): exactly 8 line classes —
// [policy]/[worker]/[session]/[tool]/[model]/[agent] + [exit] +
// handler_error. Tool lines carry the in/out/cached phase;
// model lines carry in/out/cached token counts. Constructed with a sink
// (stderr in prod, an array in tests) so TUI code never touches io here.
// Issue #246: the `[handles]` class is dropped — nothing ever measured a
// leak count, so the vocabulary carries no leak line.
export const DEBUG_CLASSES = [
  '[policy]',
  '[worker]',
  '[session]',
  '[tool]',
  '[model]',
  '[agent]',
  '[exit]',
  'handler_error',
] as const;

export type DebugSink = (line: string) => void;

export type ToolPhase = 'in' | 'out' | 'cached';

// Issue #246: the two line shapes other paths reuse without owning a
// DebugLog — the methods below delegate to these, so the headless lane
// sink and the TUI runner emit byte-identical lines.
export function hookErrorLine(hook: string, error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return `handler_error hook=${hook} error=${message} verdict=deny`;
}

export function modelLine(
  input: number,
  output: number,
  cached: number,
  detail: string,
): string {
  return `[model] in=${input} out=${output} cached=${cached} ${detail}`;
}

export class DebugLog {
  private readonly sink: DebugSink;

  constructor(sink: DebugSink) {
    this.sink = sink;
  }

  policy(detail: string): void {
    this.sink(`[policy] ${detail}`);
  }

  worker(detail: string): void {
    this.sink(`[worker] ${detail}`);
  }

  session(detail: string): void {
    this.sink(`[session] ${detail}`);
  }

  tool(phase: ToolPhase, detail: string): void {
    this.sink(`[tool] ${phase} ${detail}`);
  }

  model(input: number, output: number, cached: number, detail: string): void {
    this.sink(modelLine(input, output, cached, detail));
  }

  agent(detail: string): void {
    this.sink(`[agent] ${detail}`);
  }

  hookError(hook: string, error: unknown): void {
    this.sink(hookErrorLine(hook, error));
  }

  exit(code: number): void {
    this.sink(`[exit] code=${code} exited cleanly`);
  }
}

// Headless debug transcript (no VirtualTerminal in Pi 0.85.1): an
// array-backed sink the caller renders headlessly. The transcript must
// contain the [policy] and [worker] … exited lines (§50 acceptance).
export interface TranscriptSink {
  sink: DebugSink;
  lines: string[];
}

export function createTranscriptSink(): TranscriptSink {
  const lines: string[] = [];
  return { sink: (line: string) => lines.push(line), lines };
}

// ANSI path via PI_TUI_WRITE_LOG (§50): when the TUI log path is set,
// debug lines are appended there (raw, one per line) alongside stderr.
// Returns null when unset. File access stays behind the injected
// append callback so host code never touches node:fs directly.
export function makeWriteLogSink(
  env: Record<string, string | undefined>,
  append: (path: string, text: string) => void,
): DebugSink | null {
  const path = env.PI_TUI_WRITE_LOG;
  if (path === undefined || path === '') return null;
  return (line: string) => append(path, `${line}\n`);
}
