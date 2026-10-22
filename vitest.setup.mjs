// Hermetic provider configuration for every vitest file.
// Pi's built-in providers resolve auth from the process env (API keys,
// AWS profiles, Google ADC settings), and the assembled catalog reads the
// user-global ~/.kubic/models/models.json. A test must never find the
// developer's own credentials or models.json and dial a live provider, so
// every credential-shaped variable is removed and HOME points at a path
// that is never created by this file (nothing to clean up; a test that
// needs a home, a key or a global models.json passes its own).
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CREDENTIAL_NAME =
  /(_API_KEY|_TOKEN|_SECRET|_SECRET_ACCESS_KEY|_ACCESS_KEY_ID|_CREDENTIALS)$|^(AWS_|AZURE_OPENAI_|GOOGLE_CLOUD_|GCLOUD_|CLOUDFLARE_)/;

for (const name of Object.keys(process.env)) {
  if (CREDENTIAL_NAME.test(name)) delete process.env[name];
}

process.env.HOME = join(tmpdir(), 'kubic-vitest-home-absent');
