import { describe, expect, it } from 'vitest';
import { otlpMetrics, otlpTraces, type RunTelemetry } from './otlp.js';
import { resolveTelemetryTarget } from './target.js';

const TARGET = {
  endpoint: 'http://localhost:4318',
  headers: {},
  serviceName: 'kubic',
  content: false,
};

const RUN: RunTelemetry = {
  sessionId: 's1',
  status: 'completed',
  model: { provider: 'anthropic', id: 'claude' },
  spans: [
    {
      id: 'span-0',
      name: 'kubic.agent.run',
      parentId: null,
      startMs: 1000,
      endMs: 5000,
    },
    {
      id: 'span-1',
      name: 'kubic.lane.drive',
      parentId: 'span-0',
      startMs: 1100,
      endMs: 4900,
    },
    {
      id: 'span-2',
      name: 'pi.tool.execute',
      parentId: 'span-1',
      startMs: 1200,
      endMs: 1300,
      toolName: 'bash',
      error: 'tool reported an error',
    },
  ],
  usage: {
    input: 120,
    output: 30,
    cacheRead: 10,
    cacheWrite: 0,
    costUsd: 0.25,
  },
  toolErrors: 1,
  approvals: { asked: 2, denied: 1 },
  startedAt: 1000,
  endedAt: 5000,
  prompt: 'deploy with token sk-live-0123456789abcdef',
  answer: 'done',
};

type Span = {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  attributes: Array<{ key: string; value: Record<string, unknown> }>;
  status: { code: number; message?: string };
};

function spansOf(body: unknown): Span[] {
  return (
    body as { resourceSpans: Array<{ scopeSpans: Array<{ spans: Span[] }> }> }
  ).resourceSpans[0]?.scopeSpans[0]?.spans as Span[];
}

function attribute(span: Span | undefined, key: string): unknown {
  return span?.attributes.find((entry) => entry.key === key)?.value;
}

describe('OTLP export', () => {
  it('keeps the span tree in one trace with the GenAI attributes and no content', () => {
    const spans = spansOf(otlpTraces(TARGET, RUN));
    expect(spans.map((span) => span.name)).toEqual([
      'kubic.agent.run',
      'kubic.lane.drive',
      'pi.tool.execute',
    ]);
    const [run, drive, tool] = spans;
    expect(new Set(spans.map((span) => span.traceId)).size).toBe(1);
    expect(run?.parentSpanId).toBeUndefined();
    expect(drive?.parentSpanId).toBe(run?.spanId);
    expect(tool?.parentSpanId).toBe(drive?.spanId);
    expect(attribute(run, 'gen_ai.request.model')).toEqual({
      stringValue: 'claude',
    });
    expect(attribute(run, 'gen_ai.usage.input_tokens')).toEqual({
      intValue: '120',
    });
    expect(attribute(run, 'kubic.cost.usd')).toEqual({ doubleValue: 0.25 });
    expect(attribute(tool, 'gen_ai.tool.name')).toEqual({
      stringValue: 'bash',
    });
    expect(tool?.status).toEqual({
      code: 2,
      message: 'tool reported an error',
    });
    expect(JSON.stringify(spans)).not.toContain('deploy with token');
  });

  it('carries the prompt and answer, redacted, only when content is on', () => {
    const spans = spansOf(otlpTraces({ ...TARGET, content: true }, RUN));
    expect(attribute(spans[0], 'kubic.prompt')).toEqual({
      stringValue: 'deploy with token [REDACTED]',
    });
    expect(attribute(spans[0], 'kubic.answer')).toEqual({
      stringValue: 'done',
    });
  });

  it('reports tokens by type, cost, tool errors and approvals as delta sums', () => {
    const metrics = (
      otlpMetrics(TARGET, RUN) as {
        resourceMetrics: Array<{
          scopeMetrics: Array<{
            metrics: Array<{
              name: string;
              sum: {
                aggregationTemporality: number;
                dataPoints: Array<{
                  asInt?: string;
                  asDouble?: number;
                  attributes: Array<{ key: string; value: unknown }>;
                }>;
              };
            }>;
          }>;
        }>;
      }
    ).resourceMetrics[0]?.scopeMetrics[0]?.metrics;
    expect(metrics?.map((metric) => metric.name)).toEqual([
      'gen_ai.client.token.usage',
      'kubic.cost',
      'kubic.tool.errors',
      'kubic.approvals',
    ]);
    expect(
      metrics?.every((metric) => metric.sum.aggregationTemporality === 1),
    ).toBe(true);
    const tokens = metrics?.[0]?.sum.dataPoints.map((point) => point.asInt);
    expect(tokens).toEqual(['120', '30', '10', '0']);
    expect(metrics?.[1]?.sum.dataPoints[0]?.asDouble).toBe(0.25);
    expect(metrics?.[3]?.sum.dataPoints.map((point) => point.asInt)).toEqual([
      '1',
      '1',
    ]);
  });
});

describe('telemetry target', () => {
  it('is off unless enabled, and off again under OTEL_SDK_DISABLED', () => {
    expect(resolveTelemetryTarget(undefined, {})).toBeUndefined();
    expect(resolveTelemetryTarget({ enabled: false }, {})).toBeUndefined();
    expect(
      resolveTelemetryTarget({ enabled: true }, { OTEL_SDK_DISABLED: 'true' }),
    ).toBeUndefined();
  });

  it('reads the standard variables under the config', () => {
    expect(
      resolveTelemetryTarget(
        { enabled: true },
        {
          OTEL_EXPORTER_OTLP_ENDPOINT: 'https://otel.example.com',
          OTEL_EXPORTER_OTLP_HEADERS: 'Authorization=Bearer%20abc,x-team=core',
          OTEL_SERVICE_NAME: 'kubic-ci',
          OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: 'https://traces.example.com/t',
        },
        '1.2.3',
      ),
    ).toEqual({
      endpoint: 'https://otel.example.com',
      tracesEndpoint: 'https://traces.example.com/t',
      headers: { authorization: 'Bearer abc', 'x-team': 'core' },
      serviceName: 'kubic-ci',
      serviceVersion: '1.2.3',
      content: false,
    });
    expect(
      resolveTelemetryTarget(
        { enabled: true, endpoint: 'http://collector:4318', content: true },
        {},
      ),
    ).toMatchObject({ endpoint: 'http://collector:4318', content: true });
  });

  it('refuses headers over plain http to another host, and a bad URL', () => {
    expect(
      resolveTelemetryTarget(
        { enabled: true, endpoint: 'http://collector:4318' },
        { OTEL_EXPORTER_OTLP_HEADERS: 'api-key=x' },
      ),
    ).toEqual({
      problem:
        'telemetry endpoint http://collector:4318 is plain http to another host: OTEL_EXPORTER_OTLP_HEADERS would travel unencrypted — use https',
    });
    expect(
      resolveTelemetryTarget({ enabled: true, endpoint: 'nope' }, {}),
    ).toEqual({ problem: 'telemetry endpoint nope is not a URL' });
  });
});
