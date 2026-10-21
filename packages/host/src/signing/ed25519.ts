// Detached Ed25519 signatures: the base64 signature of a file's exact bytes,
// kept beside it as `<file>.sig`. A managed policy and a pre-approval file
// are both proven this way, against a public key in PEM form.

import {
  createPrivateKey,
  createPublicKey,
  type KeyObject,
  sign as signBytes,
  verify as verifyBytes,
} from 'node:crypto';

export class SignatureError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SignatureError';
  }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The Ed25519 public key in `pem` (read from `path`); refuses any other key. */
export function ed25519PublicKey(pem: string, path: string): KeyObject {
  let key: KeyObject;
  try {
    key = createPublicKey(pem);
  } catch (error) {
    throw new SignatureError(
      `${path} is not a public key in PEM form: ${message(error)}`,
    );
  }
  if (key.asymmetricKeyType !== 'ed25519') {
    throw new SignatureError(
      `${path} is a ${key.asymmetricKeyType ?? 'non-asymmetric'} key — signatures are checked with Ed25519`,
    );
  }
  return key;
}

/** Whether `signature` (base64) signs `text` under `key`. */
export function signatureMatches(
  key: KeyObject,
  text: string,
  signature: string,
): boolean {
  const bytes = Buffer.from(signature.trim(), 'base64');
  if (bytes.byteLength !== 64) return false;
  try {
    return verifyBytes(null, Buffer.from(text, 'utf8'), key, bytes);
  } catch {
    return false;
  }
}

/** The base64 Ed25519 signature of `text` with the private key `pem`. */
export function signText(pem: string, text: string): string {
  let key: KeyObject;
  try {
    key = createPrivateKey(pem);
  } catch (error) {
    throw new SignatureError(
      `not a private key in PEM form: ${message(error)}`,
    );
  }
  if (key.asymmetricKeyType !== 'ed25519') {
    throw new SignatureError(
      `a ${key.asymmetricKeyType ?? 'non-asymmetric'} key cannot sign — use an Ed25519 key`,
    );
  }
  return signBytes(null, Buffer.from(text, 'utf8'), key).toString('base64');
}
