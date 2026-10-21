// Where the OpenTelemetry export goes: `[telemetry]` over the standard
// `OTEL_*` variables. Off unless `[telemetry] enabled = true`, and off again
// under `OTEL_SDK_DISABLED=true`.

import type { TelemetryConfig } from '../config/index.js';
import type { TelemetryTarget } from './otlp.js';

const DEFAULT_ENDPOINT = 'http://localhost:4318';

// `OTEL_EXPORTER_OTLP_HEADERS`: `key=value` pairs, comma-separated, values
// percent-encoded.
function parseHeaders(raw: string | undefined): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const pair of (raw ?? '').split(',')) {
    const at = pair.indexOf('=');
    if (at <= 0) continue;
    const key = pair.slice(0, at).trim();
    let value = pair.slice(at + 1).trim();
    try {
      value = decodeURIComponent(value);
    } catch {
      // A value that is not percent-encoded is taken as written.
    }
    if (key !== '') headers[key.toLowerCase()] = value;
  }
  return headers;
}

function local(url: URL): boolean {
  return ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
}

/**
 * The export target, `undefined` when telemetry is off, or the reason it
 * cannot be used (a malformed URL, headers over plain http off this machine).
 */
export function resolveTelemetryTarget(
  config: TelemetryConfig | undefined,
  env: Readonly<Record<string, string | undefined>>,
  serviceVersion?: string,
): TelemetryTarget | { problem: string } | undefined {
  if (config?.enabled !== true) return undefined;
  if (env.OTEL_SDK_DISABLED?.toLowerCase() === 'true') return undefined;
  const endpoint =
    config.endpoint ?? env.OTEL_EXPORTER_OTLP_ENDPOINT ?? DEFAULT_ENDPOINT;
  const headers = parseHeaders(env.OTEL_EXPORTER_OTLP_HEADERS);
  const urls = [
    endpoint,
    env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT,
    env.OTEL_EXPORTER_OTLP_METRICS_ENDPOINT,
  ].filter((url): url is string => url !== undefined && url !== '');
  for (const url of urls) {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return { problem: `telemetry endpoint ${url} is not a URL` };
    }
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
      return { problem: `telemetry endpoint ${url} is not http(s)` };
    }
    if (
      parsed.protocol === 'http:' &&
      !local(parsed) &&
      Object.keys(headers).length > 0
    ) {
      return {
        problem: `telemetry endpoint ${url} is plain http to another host: OTEL_EXPORTER_OTLP_HEADERS would travel unencrypted — use https`,
      };
    }
  }
  const traces = env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT;
  const metrics = env.OTEL_EXPORTER_OTLP_METRICS_ENDPOINT;
  return {
    endpoint,
    ...(traces === undefined || traces === ''
      ? {}
      : { tracesEndpoint: traces }),
    ...(metrics === undefined || metrics === ''
      ? {}
      : { metricsEndpoint: metrics }),
    headers,
    serviceName: env.OTEL_SERVICE_NAME ?? 'kubic',
    ...(serviceVersion === undefined ? {} : { serviceVersion }),
    content: config.content === true,
  };
}
