// The state of one `kubic run`: what the phases share, in one object instead
// of closure-captured locals.
import type { SessionHandle } from '@kubic/agent/lane/session-store';
import type { RunMode } from '@kubic/agent/permissions';
import { BACKGROUND_CONTEXT, type Context } from '@kubic/agent/pi-boundary';
import { gitHeadOf } from '@kubic/exec/git-clean';
import { type RunOutcome, RunSpans } from '@kubic/host/run';
import type { SessionBoot } from '../session/bootstrap.js';
import type { HeadlessRunDeps, HeadlessRunOptions } from './options.js';
import { type RunSinks, runSinks } from './output.js';

// What the settled run leaves for its trajectory: filled
// as the run boots, read once after it settles.
export interface RunCapture {
  startedAt: number;
  sessionsRoot?: string;
  sessionId?: string;
  cwd?: string;
  model?: { provider: string; id: string };
  // The thinking level the lane actually booted with
  // (post-clamp) — the trajectory names the applied level, the same source
  // as the envelope, never the request that may have been clamped.
  thinking?: string;
  role?: string;
  skills: string[];
  entries: unknown[];
  lane?: RunOutcome['lane'];
  interrupted: boolean;
  // Every provider key the request-time resolver has handed out so far: what
  // the debug channel, the session writes, the result and the trajectory are
  // scrubbed of. Empty until a models.json key is used.
  liveSecrets: () => string[];
  // This run's own spend and tool errors, from its lane events: what the
  // OpenTelemetry export reports (a resumed session's earlier runs excluded).
  tally: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    costUsd: number;
    toolErrors: number;
  };
}

// The live lane model and the approval posture the lane was installed with
// travel on the result (and so the --json envelope), whatever path the run
// ends on.
export interface RunReport {
  model?: string;
  posture?: 'approvals' | 'full-access';
  // The run's mode, set from the session record once the session exists.
  mode?: RunMode;
}

export class RunState {
  readonly prompt: string;
  readonly options: HeadlessRunOptions;
  readonly deps: HeadlessRunDeps;
  readonly capture: RunCapture;
  readonly report: RunReport;
  // The base the run starts from: captured before any turn, so
  // an agent that commits mid-run cannot move the baseline it is judged by.
  readonly base: ReturnType<typeof gitHeadOf>;
  readonly context: Context;
  readonly sinks: RunSinks;
  // Spans on the live path: the run, its lane accept/drive
  // steps and every harness tool call are recorded on the SpanRecorder
  // and persisted to <root>/<id>/spans.jsonl when the run settles.
  readonly spans: RunSpans;
  readonly runSpan: string;
  // The turn prompt `--invoke-skill` expands to. Every downstream prompt
  // use reads this, never the operator's prompt.
  effectivePrompt: string;
  // Set when a guard or an interrupt abandoned a live turn: the close then
  // states the durable conversation abort (plus the kill drain) instead of
  // dropping handles for work that is still running.
  abandoned = false;

  constructor(
    prompt: string,
    options: HeadlessRunOptions,
    deps: HeadlessRunDeps,
  ) {
    this.prompt = prompt;
    this.options = options;
    this.deps = deps;
    this.capture = {
      startedAt: Date.now(),
      skills: [],
      entries: [],
      interrupted: false,
      liveSecrets: () => [],
      tally: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        costUsd: 0,
        toolErrors: 0,
      },
    };
    this.report = {};
    this.base = gitHeadOf(deps.env?.cwd ?? process.cwd());
    this.context = deps.context ?? BACKGROUND_CONTEXT;
    this.sinks = runSinks(options, deps, () => this.capture.liveSecrets());
    this.effectivePrompt = prompt;
    this.spans = new RunSpans(Date.now, this.sinks.debugSink);
    this.runSpan = this.spans.startRun();
  }

  // The session the run opened: its id names every ref. The result and
  // envelope name the session's recorded mode — a resumed or attached
  // session keeps the creating run's mode, and a record without one falls
  // back to this invocation's flag.
  attach(boot: SessionBoot): string {
    const session = boot.session as SessionHandle;
    this.capture.sessionId = session.id;
    this.capture.sessionsRoot = boot.root;
    this.report.mode =
      session.meta.mode ??
      (this.options.autonomous === true ? 'autonomous' : 'interactive');
    return session.id;
  }
}
