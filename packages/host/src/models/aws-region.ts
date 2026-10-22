// The AWS region a Bedrock request goes to, read the way the AWS SDK reads it.

import { join } from 'node:path';
import { createNodeFileBridge } from '@kubic/exec/file-bridge';

type Env = Readonly<Record<string, string | undefined>>;

// The AWS region Bedrock would use: AWS_REGION or AWS_DEFAULT_REGION, else
// the `region` of the active profile in the shared config file — the order
// the AWS SDK resolves it.
export function awsRegionOf(env: Env, home: string): string | undefined {
  const fromEnv = env.AWS_REGION || env.AWS_DEFAULT_REGION;
  if (fromEnv !== undefined && fromEnv !== '') return fromEnv;
  let text: string;
  try {
    text = createNodeFileBridge('/').readTextFile(
      env.AWS_CONFIG_FILE || join(home, '.aws', 'config'),
    );
  } catch {
    return undefined;
  }
  const profile = env.AWS_PROFILE || 'default';
  const sections =
    profile === 'default'
      ? ['default', 'profile default']
      : [`profile ${profile}`];
  let inProfile = false;
  for (const raw of text.split(/\r?\n/u)) {
    const line = raw.trim();
    const header = /^\[\s*(.+?)\s*\]$/u.exec(line);
    if (header !== null) {
      inProfile = sections.includes((header[1] ?? '').replace(/\s+/gu, ' '));
      continue;
    }
    const region = inProfile ? /^region\s*=\s*(\S+)/u.exec(line) : null;
    if (region?.[1] !== undefined) return region[1];
  }
  return undefined;
}
