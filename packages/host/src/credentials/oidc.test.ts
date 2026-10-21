// OIDC workload identity against a loopback stand-in for GitHub's token
// endpoint: the token per audience, what Bedrock and Vertex AI read, the
// gateway token, a token from a variable, and a job with no token.
import { existsSync, readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { oidcToken, prepareOidc } from './oidc.js';

let server: Server | undefined;
const closers: Array<() => void> = [];

afterEach(async () => {
  for (const close of closers.splice(0)) close();
  await new Promise<void>((resolve) => {
    if (server === undefined) resolve();
    else server.close(() => resolve());
  });
  server = undefined;
});

// GitHub's token endpoint: a JWT naming the audience it was asked for, for
// the job's request token only.
async function github(): Promise<Record<string, string>> {
  server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://localhost');
    if (request.headers.authorization !== 'bearer job-request-token') {
      response.writeHead(401);
      response.end();
      return;
    }
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(
      JSON.stringify({ value: `jwt-for:${url.searchParams.get('audience')}` }),
    );
  });
  await new Promise<void>((resolve) =>
    (server as Server).listen(0, '127.0.0.1', resolve),
  );
  const { port } = (server as Server).address() as AddressInfo;
  return {
    ACTIONS_ID_TOKEN_REQUEST_URL: `http://127.0.0.1:${port}/token?api-version=2.0`,
    ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'job-request-token',
  };
}

describe('oidcToken', () => {
  it('requests the token for an audience from GitHub', async () => {
    const env = await github();
    expect(
      await oidcToken({ provider: 'github' }, 'sts.amazonaws.com', env),
    ).toBe('jwt-for:sts.amazonaws.com');
  });

  it('reads it from the variable another CI fills', async () => {
    expect(
      await oidcToken(
        { provider: 'env', tokenEnv: 'GITLAB_ID_TOKEN' },
        'ignored',
        { GITLAB_ID_TOKEN: 'gitlab-jwt' },
      ),
    ).toBe('gitlab-jwt');
  });

  it('names what a job without a token lacks', async () => {
    await expect(
      oidcToken({ provider: 'github' }, 'sts.amazonaws.com', {}),
    ).rejects.toThrow('permissions: id-token: write');
  });
});

describe('prepareOidc', () => {
  it('writes what Bedrock and Vertex AI read, and the gateway token', async () => {
    const env = await github();
    const modelsEnv: Record<string, string> = {};
    const prepared = await prepareOidc(
      {
        provider: 'github',
        awsRoleArn: 'arn:aws:iam::123456789012:role/kubic-ci',
        gcpAudience:
          '//iam.googleapis.com/projects/1/locations/global/workloadIdentityPools/ci/providers/github',
        gcpServiceAccount: 'kubic@proj.iam.gserviceaccount.com',
        gatewayAudience: 'https://llm-gateway.example',
      },
      env,
      modelsEnv,
    );
    closers.push(prepared.close);
    const aws = prepared.processEnv.AWS_WEB_IDENTITY_TOKEN_FILE as string;
    expect(readFileSync(aws, 'utf8')).toBe('jwt-for:sts.amazonaws.com');
    expect(prepared.processEnv.AWS_ROLE_ARN).toBe(
      'arn:aws:iam::123456789012:role/kubic-ci',
    );
    const google = JSON.parse(
      readFileSync(
        prepared.processEnv.GOOGLE_APPLICATION_CREDENTIALS as string,
        'utf8',
      ),
    );
    expect(google).toMatchObject({
      type: 'external_account',
      audience:
        '//iam.googleapis.com/projects/1/locations/global/workloadIdentityPools/ci/providers/github',
      credential_source: {
        url: expect.stringContaining(
          'audience=https%3A%2F%2Fiam.googleapis.com%2Fprojects%2F1',
        ),
        format: { type: 'json', subject_token_field_name: 'value' },
      },
      service_account_impersonation_url: expect.stringContaining(
        'kubic@proj.iam.gserviceaccount.com:generateAccessToken',
      ),
    });
    expect(modelsEnv.KUBIC_OIDC_TOKEN).toBe(
      'jwt-for:https://llm-gateway.example',
    );
    expect(prepared.secrets()).toContain('jwt-for:sts.amazonaws.com');
    prepared.close();
    expect(existsSync(aws)).toBe(false);
  });
});
