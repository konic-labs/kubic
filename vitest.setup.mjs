// Hermetic provider credentials for every vitest worker (issue #221).
// Pi's built-in providers resolve auth from the process env (API keys,
// AWS profiles, Google ADC settings). A test that assembles the real catalog
// must never find the developer's own credentials and dial a live provider,
// so every credential-shaped variable is removed before any test runs.
// Tests that need a key pass an explicit env (or vi.stubEnv) instead.

const CREDENTIAL_NAME =
  /(_API_KEY|_TOKEN|_SECRET|_SECRET_ACCESS_KEY|_ACCESS_KEY_ID|_CREDENTIALS)$|^(AWS_|AZURE_OPENAI_|GOOGLE_CLOUD_|GCLOUD_|CLOUDFLARE_)/;

for (const name of Object.keys(process.env)) {
  if (CREDENTIAL_NAME.test(name)) delete process.env[name];
}
