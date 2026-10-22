// OIDC workload identity for CI: the job's OIDC token — requested from
// GitHub Actions, or read from a variable another CI system fills — becomes
// the credential of a cloud-hosted model, so no provider key is stored:
//
// - Amazon Bedrock: the token is written to a private file and the AWS SDK
//   assumes `awsRoleArn` with it (AWS_WEB_IDENTITY_TOKEN_FILE, AWS_ROLE_ARN);
// - Vertex AI: a workload identity federation config for `gcpAudience`
//   (optionally impersonating `gcpServiceAccount`) is written and named by
//   GOOGLE_APPLICATION_CREDENTIALS; on GitHub it fetches fresh tokens itself;
// - a gateway: a token for `gatewayAudience` is offered to models.json as
//   `$KUBIC_OIDC_TOKEN`, seen by the model catalogue only.
//
// On GitHub the AWS token file and the gateway token are refreshed every
// four minutes, before the job's tokens expire. The files live in a private
// temporary directory removed when the process exits.

import { join } from 'node:path';
import { createNodeFileBridge } from '@kubic/exec/file-bridge';
import { requestJson } from '../net/index.js';

type Env = Readonly<Record<string, string | undefined>>;

export interface RuntimeOidc {
  readonly provider: 'github' | 'env';
  // `provider = "env"`: the variable holding the job's token.
  readonly tokenEnv?: string;
  readonly awsRoleArn?: string;
  readonly gcpAudience?: string;
  readonly gcpServiceAccount?: string;
  readonly gatewayAudience?: string;
}

export interface OidcCredentials {
  // Set on this process: the AWS SDK and Google's auth library read them.
  readonly processEnv: Record<string, string>;
  // The token values, for the run's scrub.
  readonly secrets: () => string[];
  // Stops the refresh and removes the token files.
  readonly close: () => void;
}

const REQUEST_URL = 'ACTIONS_ID_TOKEN_REQUEST_URL';
const REQUEST_TOKEN = 'ACTIONS_ID_TOKEN_REQUEST_TOKEN';
const REFRESH_MS = 4 * 60 * 1000;

class OidcError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OidcError';
  }
}

function githubRequest(env: Env): { url: string; bearer: string } {
  const url = env[REQUEST_URL];
  const bearer = env[REQUEST_TOKEN];
  if (
    url === undefined ||
    url === '' ||
    bearer === undefined ||
    bearer === ''
  ) {
    throw new OidcError(
      'this job has no OIDC token to request: run it on GitHub Actions with `permissions: id-token: write`',
    );
  }
  return { url, bearer };
}

function withAudience(url: string, audience: string): string {
  return `${url}${url.includes('?') ? '&' : '?'}audience=${encodeURIComponent(audience)}`;
}

/**
 * The job's OIDC token for `audience`.
 * @internal
 */
export async function oidcToken(
  oidc: RuntimeOidc,
  audience: string,
  env: Env,
): Promise<string> {
  if (oidc.provider === 'env') {
    const name = oidc.tokenEnv ?? '';
    const value = env[name];
    if (value === undefined || value === '') {
      throw new OidcError(`[oidc] tokenEnv names ${name}, which is not set`);
    }
    return value;
  }
  const { url, bearer } = githubRequest(env);
  let answer: unknown;
  try {
    answer = await requestJson(
      {
        url: withAudience(url, audience),
        headers: { authorization: `bearer ${bearer}` },
        timeoutMs: 10_000,
      },
      'GET',
    );
  } catch (error) {
    throw new OidcError(
      `the OIDC token for ${audience} could not be requested: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const value = (answer as { value?: unknown } | null)?.value;
  if (typeof value !== 'string' || value === '') {
    throw new OidcError(
      `GitHub answered without an OIDC token for ${audience}`,
    );
  }
  return value;
}

// The token a Google workload identity provider expects: its resource name
// as an https URL.
function googleTokenAudience(audience: string): string {
  return audience.startsWith('//') ? `https:${audience}` : audience;
}

function googleConfig(
  oidc: RuntimeOidc,
  env: Env,
  tokenFile: string | undefined,
): Record<string, unknown> {
  const audience = oidc.gcpAudience as string;
  const source =
    oidc.provider === 'github'
      ? (() => {
          const { url, bearer } = githubRequest(env);
          return {
            url: withAudience(url, googleTokenAudience(audience)),
            headers: { Authorization: `Bearer ${bearer}` },
            format: { type: 'json', subject_token_field_name: 'value' },
          };
        })()
      : { file: tokenFile };
  return {
    type: 'external_account',
    audience,
    subject_token_type: 'urn:ietf:params:oauth:token-type:jwt',
    token_url: 'https://sts.googleapis.com/v1/token',
    credential_source: source,
    ...(oidc.gcpServiceAccount === undefined
      ? {}
      : {
          service_account_impersonation_url: `https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/${oidc.gcpServiceAccount}:generateAccessToken`,
        }),
  };
}

/**
 * Requests the job's tokens and writes what each cloud reads. The gateway
 * token is set (and refreshed) on `modelsEnv`, the environment the model
 * catalogue reads its keys from.
 */
export async function prepareOidc(
  oidc: RuntimeOidc,
  env: Env,
  modelsEnv: Record<string, string>,
): Promise<OidcCredentials> {
  const files = createNodeFileBridge('/');
  // Made on the first file: a gateway token alone needs none.
  let dir: string | undefined;
  const write = (name: string, text: string): string => {
    dir ??= files.createTempDir('kubic-oidc-');
    const path = join(dir, name);
    files.writeFile(path, text, { mode: 0o600 });
    return path;
  };
  const removeDir = (): void => {
    if (dir !== undefined) files.remove(dir, true, true);
  };
  const processEnv: Record<string, string> = {};
  const tokens = new Map<string, string>();
  const fetch = async (key: string, audience: string): Promise<string> => {
    const token = await oidcToken(oidc, audience, env);
    tokens.set(key, token);
    return token;
  };
  const writeAll = async (): Promise<void> => {
    if (oidc.awsRoleArn !== undefined) {
      write('aws-web-identity', await fetch('aws', 'sts.amazonaws.com'));
    }
    if (oidc.gatewayAudience !== undefined) {
      modelsEnv.KUBIC_OIDC_TOKEN = await fetch('gateway', oidc.gatewayAudience);
    }
  };
  try {
    await writeAll();
    if (oidc.awsRoleArn !== undefined && dir !== undefined) {
      processEnv.AWS_WEB_IDENTITY_TOKEN_FILE = join(dir, 'aws-web-identity');
      processEnv.AWS_ROLE_ARN = oidc.awsRoleArn;
      processEnv.AWS_ROLE_SESSION_NAME = `kubic-${process.pid}`;
    }
    if (oidc.gcpAudience !== undefined) {
      const tokenFile =
        oidc.provider === 'env'
          ? write(
              'gcp-subject-token',
              await fetch('gcp', googleTokenAudience(oidc.gcpAudience)),
            )
          : undefined;
      processEnv.GOOGLE_APPLICATION_CREDENTIALS = write(
        'gcp-external-account.json',
        `${JSON.stringify(googleConfig(oidc, env, tokenFile), null, 2)}\n`,
      );
    }
  } catch (error) {
    removeDir();
    throw error;
  }
  const refresh =
    oidc.provider === 'github'
      ? setInterval(() => {
          writeAll().catch(() => undefined);
        }, REFRESH_MS)
      : undefined;
  refresh?.unref();
  let closed = false;
  const close = (): void => {
    if (closed) return;
    closed = true;
    if (refresh !== undefined) clearInterval(refresh);
    removeDir();
  };
  process.once('exit', close);
  return {
    processEnv,
    secrets: () => [...tokens.values()],
    close,
  };
}
