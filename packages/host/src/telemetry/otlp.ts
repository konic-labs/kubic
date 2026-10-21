// OpenTelemetry export: one run (or one settled TUI turn) as OTLP/HTTP JSON —
// its spans (the run, the lane phases, each tool call) with the GenAI
// semantic-convention attributes, and its metrics (tokens by type, cost, tool
// errors, approvals asked and denied) as delta sums. Sent once, when the run
// settles, bounded in time; a collector that does not answer costs the run
// nothing but a warning.
//
// No content leaves by default: the spans carry names, timing, the model,
// token counts and cost, never a prompt, an argument or an output. With
// `[telemetry] content = true` the run span also carries the prompt and the
// final answer, redacted of secret shapes.

import { randomBytes } from 'node:crypto';
import { redactSecrets } from '@kubic/core/secret-shapes';
import { postJson } from '../net/index.js';

export interface TelemetryTarget {
  // The OTLP/HTTP base URL (`…:4318`); the signals post to `/v1/traces` and
  // `/v1/metrics` under it unless their own endpoints are set.
  readonly endpoint: string;
  readonly tracesEndpoint?: string;
  readonly metricsEndpoint?: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly serviceName: string;
  readonly serviceVersion?: string;
  // Prompt and answer text on the run span.
  readonly content: boolean;
}

interface TelemetrySpan {
  readonly id: string;
  readonly name: string;
  readonly parentId: string | null;
  readonly startMs: number;
  readonly endMs: number | null;
  readonly error?: string;
  readonly toolName?: string;
}

export interface RunTelemetry {
  readonly sessionId: string;
  // The run's terminus (`completed`, `turn_limit`, …).
  readonly status: string;
  readonly model?: { readonly provider: string; readonly id: string };
  readonly spans: readonly TelemetrySpan[];
  readonly usage: {
    readonly input: number;
    readonly output: number;
    readonly cacheRead: number;
    readonly cacheWrite: number;
    readonly costUsd: number;
  };
  readonly toolErrors: number;
  readonly approvals: { readonly asked: number; readonly denied: number };
  readonly startedAt: number;
  readonly endedAt: number;
  readonly prompt?: string;
  readonly answer?: string;
}

type AttributeValue =
  | { stringValue: string }
  | { intValue: string }
  | { doubleValue: number }
  | { boolValue: boolean };

interface Attribute {
  key: string;
  value: AttributeValue;
}

function attr(key: string, value: string | number | boolean): Attribute {
  if (typeof value === 'boolean') return { key, value: { boolValue: value } };
  if (typeof value === 'number') {
    return Number.isInteger(value)
      ? { key, value: { intValue: String(value) } }
      : { key, value: { doubleValue: value } };
  }
  return { key, value: { stringValue: value } };
}

function nanos(ms: number): string {
  return `${BigInt(Math.round(ms)) * 1_000_000n}`;
}

function hex(bytes: number): string {
  return randomBytes(bytes).toString('hex');
}

function resource(target: TelemetryTarget): { attributes: Attribute[] } {
  return {
    attributes: [
      attr('service.name', target.serviceName),
      ...(target.serviceVersion === undefined
        ? []
        : [attr('service.version', target.serviceVersion)]),
    ],
  };
}

function modelAttributes(run: RunTelemetry): Attribute[] {
  return run.model === undefined
    ? []
    : [
        attr('gen_ai.provider.name', run.model.provider),
        attr('gen_ai.request.model', run.model.id),
      ];
}

/**
 * The run's spans as an OTLP/HTTP JSON traces request.
 * @internal
 */
export function otlpTraces(
  target: TelemetryTarget,
  run: RunTelemetry,
): unknown {
  const traceId = hex(16);
  const ids = new Map(run.spans.map((span) => [span.id, hex(8)]));
  const root = run.spans.find((span) => span.parentId === null);
  const spans = run.spans.map((span) => {
    const isRun = span === root;
    const attributes: Attribute[] = [attr('kubic.session.id', run.sessionId)];
    if (isRun) {
      attributes.push(
        attr('gen_ai.operation.name', 'invoke_agent'),
        ...modelAttributes(run),
        attr('gen_ai.usage.input_tokens', run.usage.input),
        attr('gen_ai.usage.output_tokens', run.usage.output),
        attr('kubic.usage.cache_read_tokens', run.usage.cacheRead),
        attr('kubic.usage.cache_write_tokens', run.usage.cacheWrite),
        attr('kubic.cost.usd', run.usage.costUsd),
        attr('kubic.run.status', run.status),
        attr('kubic.approvals.asked', run.approvals.asked),
        attr('kubic.approvals.denied', run.approvals.denied),
        attr('kubic.tool.errors', run.toolErrors),
      );
      if (target.content && run.prompt !== undefined) {
        attributes.push(attr('kubic.prompt', redactSecrets(run.prompt)));
      }
      if (target.content && run.answer !== undefined) {
        attributes.push(attr('kubic.answer', redactSecrets(run.answer)));
      }
    }
    if (span.toolName !== undefined) {
      attributes.push(
        attr('gen_ai.operation.name', 'execute_tool'),
        attr('gen_ai.tool.name', span.toolName),
      );
    }
    const parent = span.parentId === null ? undefined : ids.get(span.parentId);
    return {
      traceId,
      spanId: ids.get(span.id) as string,
      ...(parent === undefined ? {} : { parentSpanId: parent }),
      name: span.name,
      kind: 1,
      startTimeUnixNano: nanos(span.startMs),
      endTimeUnixNano: nanos(span.endMs ?? run.endedAt),
      attributes,
      status:
        span.error === undefined
          ? { code: 1 }
          : { code: 2, message: redactSecrets(span.error) },
    };
  });
  return {
    resourceSpans: [
      {
        resource: resource(target),
        scopeSpans: [{ scope: { name: 'kubic' }, spans }],
      },
    ],
  };
}

function sum(
  name: string,
  unit: string,
  description: string,
  points: ReadonlyArray<{ value: number; attributes: Attribute[] }>,
  run: RunTelemetry,
): unknown {
  return {
    name,
    unit,
    description,
    sum: {
      aggregationTemporality: 1,
      isMonotonic: true,
      dataPoints: points.map((point) => ({
        startTimeUnixNano: nanos(run.startedAt),
        timeUnixNano: nanos(run.endedAt),
        attributes: point.attributes,
        ...(Number.isInteger(point.value)
          ? { asInt: String(point.value) }
          : { asDouble: point.value }),
      })),
    },
  };
}

/**
 * The run's metrics as an OTLP/HTTP JSON metrics request (delta sums).
 * @internal
 */
export function otlpMetrics(
  target: TelemetryTarget,
  run: RunTelemetry,
): unknown {
  const base = modelAttributes(run);
  const tokens = (type: string, value: number) => ({
    value,
    attributes: [...base, attr('gen_ai.token.type', type)],
  });
  return {
    resourceMetrics: [
      {
        resource: resource(target),
        scopeMetrics: [
          {
            scope: { name: 'kubic' },
            metrics: [
              sum(
                'gen_ai.client.token.usage',
                '{token}',
                'Tokens the run used, by type',
                [
                  tokens('input', run.usage.input),
                  tokens('output', run.usage.output),
                  tokens('cache_read', run.usage.cacheRead),
                  tokens('cache_write', run.usage.cacheWrite),
                ],
                run,
              ),
              sum(
                'kubic.cost',
                'USD',
                'What the run cost, as its providers reported',
                [{ value: run.usage.costUsd, attributes: base }],
                run,
              ),
              sum(
                'kubic.tool.errors',
                '{call}',
                'Tool calls that ended in an error',
                [{ value: run.toolErrors, attributes: base }],
                run,
              ),
              sum(
                'kubic.approvals',
                '{ask}',
                'Approval asks, by outcome',
                [
                  {
                    value: run.approvals.asked - run.approvals.denied,
                    attributes: [attr('kubic.approval.outcome', 'approved')],
                  },
                  {
                    value: run.approvals.denied,
                    attributes: [attr('kubic.approval.outcome', 'denied')],
                  },
                ],
                run,
              ),
            ],
          },
        ],
      },
    ],
  };
}

function signal(base: string, path: string): string {
  return `${base.replace(/\/+$/, '')}${path}`;
}

/**
 * Sends the run's traces and metrics, each bounded by `timeoutMs`. Resolves
 * with what failed (empty when both were taken); never rejects.
 */
export async function exportRunTelemetry(
  target: TelemetryTarget,
  run: RunTelemetry,
  timeoutMs = 3_000,
): Promise<string[]> {
  const sends: Array<[string, string, unknown]> = [
    [
      'traces',
      target.tracesEndpoint ?? signal(target.endpoint, '/v1/traces'),
      otlpTraces(target, run),
    ],
    [
      'metrics',
      target.metricsEndpoint ?? signal(target.endpoint, '/v1/metrics'),
      otlpMetrics(target, run),
    ],
  ];
  const failures: string[] = [];
  await Promise.all(
    sends.map(async ([kind, url, body]) => {
      try {
        await postJson({ url, headers: target.headers, timeoutMs }, body);
      } catch (error) {
        failures.push(
          `${kind} to ${url}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }),
  );
  return failures;
}
