// Approval-state authenticity (issue #149; §41.2, §41.3).
//
// The files a run writes under its approvals state are exactly the files a
// worker would like to write itself: `{"approved":true,"by":"user"}` in an
// answer file IS an approval, a planted `decisions.json` entry pre-approves
// the operation it names, and a planted `skip-records.json` entry turns the
// posture off for the session. The worker runs with bash and the user's own
// authority, so no directory is out of its reach — what it cannot do is sign.
//
// Every one of those files is therefore a SEALED value: the payload plus a
// `mac` produced by a key this process generates and keeps in memory only.
// The child VERIFIES answers with the public half alone, which is why the
// seal is an Ed25519 signature and not a symmetric HMAC: a shared secret
// handed to the child would travel into the worker's own bash environment and
// hand the forgery straight back. A verification key grants no signing power.
//
// Loading is fail-closed and loud: an unsealed, foreign-signed or tampered
// value verifies as `undefined`, so the caller drops it and audits the drop
// instead of trusting it.
//
// Honest limit (§59.1): a key that lives only in the parent process cannot
// authenticate state an EARLIER process wrote. State this process did not
// sign is dropped and audited, so a resumed run re-asks rather than
// inheriting an approval (§41.2: the user decides).
import {
  createPublicKey,
  sign as cryptoSign,
  verify as cryptoVerify,
  generateKeyPairSync,
  type KeyObject,
} from 'node:crypto';

/** A payload plus the MAC (base64 signature) that authenticates it. */
export interface SealedValue<T> {
  readonly payload: T;
  readonly mac: string;
}

export interface ApprovalSigner {
  /**
   * The base64 SPKI public key a verifier needs. Safe to hand to a child: it
   * verifies this manager's seals and cannot produce one.
   */
  readonly verifyKey: string;
  seal<T>(payload: T): SealedValue<T>;
}

// Stable serialization: object keys sorted, recursively, so the bytes signed
// are the bytes verified whatever order the JSON round-trip preserved.
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalJson(entry)).join(',')}]`;
  }
  if (typeof value === 'object' && value !== null) {
    const record = value as Record<string, unknown>;
    const fields = Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`);
    return `{${fields.join(',')}}`;
  }
  const text = JSON.stringify(value);
  return text === undefined ? 'null' : text;
}

function spkiBase64(key: KeyObject): string {
  const der = key.export({ type: 'spki', format: 'der' }) as Buffer;
  return Buffer.from(der).toString('base64');
}

export function createApprovalSigner(): ApprovalSigner {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const verifyKey = spkiBase64(publicKey);
  return {
    verifyKey,
    seal: <T>(payload: T): SealedValue<T> => ({
      payload,
      mac: cryptoSign(
        null,
        Buffer.from(canonicalJson(payload), 'utf8'),
        privateKey,
      ).toString('base64'),
    }),
  };
}

// `undefined` for anything the signer behind `verifyKey` did not produce: a
// missing/blank MAC, an unparsable key, a tampered payload. Never throws —
// corrupt state must read as untrusted, not crash the run that reads it.
export function verifySealed<T>(
  verifyKey: string,
  value: unknown,
): SealedValue<T> | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return undefined;
  }
  const candidate = value as { payload?: unknown; mac?: unknown };
  if (!('payload' in candidate)) return undefined;
  if (typeof candidate.mac !== 'string' || candidate.mac === '') {
    return undefined;
  }
  let key: KeyObject;
  try {
    key = createPublicKey({
      key: Buffer.from(verifyKey, 'base64'),
      format: 'der',
      type: 'spki',
    });
  } catch {
    return undefined;
  }
  try {
    const valid = cryptoVerify(
      null,
      Buffer.from(canonicalJson(candidate.payload), 'utf8'),
      key,
      Buffer.from(candidate.mac, 'base64'),
    );
    if (!valid) return undefined;
  } catch {
    return undefined;
  }
  return { payload: candidate.payload as T, mac: candidate.mac };
}
