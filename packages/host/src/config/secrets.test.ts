// Request-time secrets, redaction and the secret-use audit.
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createNodeFileBridge } from '../../../exec/src/file-bridge.js';
import {
  MIN_MATCHABLE_SECRET_LENGTH,
  parseSecretRef,
  redactBridgeWrites,
  redactingSink,
  redactSecretValues,
  resolveSecretRef,
  type SecretAuditEvent,
  type SecretResolverDeps,
  withoutIdentity,
} from './secrets.js';

// NEVER real secrets in tests — [REDACTED]-style fixtures only.
const FIXTURE_KEY_A = '[REDACTED-test-key-a]';
const FIXTURE_KEY_B = '[REDACTED-test-key-b]';

function deps(overrides: Partial<SecretResolverDeps> = {}): {
  deps: SecretResolverDeps;
  audit: SecretAuditEvent[];
  commands: string[][];
} {
  const audit: SecretAuditEvent[] = [];
  const commands: string[][] = [];
  return {
    deps: {
      env: { KUBIC_TEST_KEY: FIXTURE_KEY_A },
      runCommand: (argv: string[]) => {
        commands.push(argv);
        return FIXTURE_KEY_B;
      },
      audit: (event: SecretAuditEvent): void => {
        audit.push(event);
      },
      now: () => 1_700_000_000_000,
      ...overrides,
    },
    audit,
    commands,
  };
}

describe('models.json secret refs (issue #38)', () => {
  it('resolves $ENV_VAR from the injected env', async () => {
    const { deps: d, audit } = deps();
    const value = await resolveSecretRef(parseSecretRef('$KUBIC_TEST_KEY'), d, {
      role: 'reviewer',
      purpose: 'provider-auth',
    });
    expect(value).toBe(FIXTURE_KEY_A);
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({
      role: 'reviewer',
      ref: '$KUBIC_TEST_KEY',
    });
  });

  it('fails closed on missing env vars', async () => {
    const { deps: d } = deps();
    await expect(
      resolveSecretRef(parseSecretRef('$KUBIC_MISSING_KEY'), d, {
        role: 'reviewer',
        purpose: 'provider-auth',
      }),
    ).rejects.toThrow(/KUBIC_MISSING_KEY/);
  });

  it('re-runs !command on every resolve (no TTL)', async () => {
    const { deps: d, commands } = deps();
    const ref = parseSecretRef('!pass show api-key');
    const ctx = { role: 'implementer', purpose: 'provider-auth' };
    await resolveSecretRef(ref, d, ctx);
    await resolveSecretRef(ref, d, ctx);
    expect(commands).toHaveLength(2);
    expect(commands[0]).toEqual(['pass', 'show', 'api-key']);
  });

  it('keeps escaped literals literal', async () => {
    const { deps: d, audit, commands } = deps();
    const ctx = { role: 'reviewer', purpose: 'probe' };
    expect(
      await resolveSecretRef(parseSecretRef('\\$KUBIC_TEST_KEY'), d, ctx),
    ).toBe('$KUBIC_TEST_KEY');
    expect(await resolveSecretRef(parseSecretRef('\\!literal'), d, ctx)).toBe(
      '!literal',
    );
    expect(commands).toHaveLength(0);
    expect(audit).toHaveLength(2);
  });

  it('rejects non-string refs', () => {
    expect(() => parseSecretRef(null)).toThrow(/string/);
    expect(() => parseSecretRef({ key: 1 })).toThrow(/string/);
  });
});

describe('redaction + audit (issue #38)', () => {
  it('redacts secret values out of config/trajectory/log payloads', () => {
    const payload = {
      provider: 'local',
      auth: FIXTURE_KEY_A,
      nested: { note: `key=${FIXTURE_KEY_B} ok` },
      list: [FIXTURE_KEY_A, 'public'],
    };
    const redacted = redactSecretValues(payload, [
      FIXTURE_KEY_A,
      FIXTURE_KEY_B,
    ]);
    expect(JSON.stringify(redacted)).not.toContain(FIXTURE_KEY_A);
    expect(JSON.stringify(redacted)).not.toContain(FIXTURE_KEY_B);
    expect(redacted).toEqual({
      provider: 'local',
      auth: '[REDACTED]',
      nested: { note: 'key=[REDACTED] ok' },
      list: ['[REDACTED]', 'public'],
    });
  });

  it('audits every secret use', async () => {
    const { deps: d, audit } = deps();
    const ref = parseSecretRef('$KUBIC_TEST_KEY');
    await resolveSecretRef(ref, d, { role: 'r1', purpose: 'p1' });
    await resolveSecretRef(ref, d, { role: 'r1', purpose: 'p2' });
    expect(audit).toHaveLength(2);
    expect(audit[1]).toMatchObject({ role: 'r1', purpose: 'p2' });
  });
});

describe('secret ref hardening (issue #69)', () => {
  it('rejects empty !command refs', () => {
    expect(() => parseSecretRef('!')).toThrow(/empty !command/);
    expect(() => parseSecretRef('!   ')).toThrow(/empty !command/);
  });

  it('treats near-miss env shapes as literals', () => {
    expect(parseSecretRef('$1bad')).toEqual({
      kind: 'literal',
      value: '$1bad',
    });
    expect(parseSecretRef('$')).toEqual({ kind: 'literal', value: '$' });
    expect(parseSecretRef('plain-value')).toEqual({
      kind: 'literal',
      value: 'plain-value',
    });
  });

  it('fails closed on empty env values', async () => {
    const { deps: d } = deps({ env: { KUBIC_EMPTY_KEY: '' } });
    await expect(
      resolveSecretRef(parseSecretRef('$KUBIC_EMPTY_KEY'), d, {
        role: 'reviewer',
        purpose: 'provider-auth',
      }),
    ).rejects.toThrow(/missing env secret/);
  });

  it('fails closed on empty command output', async () => {
    const { deps: d } = deps({ runCommand: () => '\n' });
    await expect(
      resolveSecretRef(parseSecretRef('!pass show api-key'), d, {
        role: 'implementer',
        purpose: 'provider-auth',
      }),
    ).rejects.toThrow(/empty output/);
  });

  it('audits literals under the [literal] ref without leaking values', async () => {
    const { deps: d, audit, commands } = deps();
    const value = await resolveSecretRef(parseSecretRef('just-a-value'), d, {
      role: 'reviewer',
      purpose: 'probe',
    });
    expect(value).toBe('just-a-value');
    expect(commands).toHaveLength(0);
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ ref: '[literal]' });
    expect(JSON.stringify(audit)).not.toContain('just-a-value');
  });

  it('pins SecretError names on every refusal', async () => {
    try {
      parseSecretRef(42);
      expect.unreachable();
    } catch (error) {
      expect((error as Error).name).toBe('SecretError');
    }
    const { deps: d } = deps();
    await expect(
      resolveSecretRef(parseSecretRef('$KUBIC_MISSING_KEY'), d, {
        role: 'r',
        purpose: 'p',
      }),
    ).rejects.toMatchObject({ name: 'SecretError' });
  });
});

describe('redaction hardening (issue #69)', () => {
  it('leaves payloads untouched with no live secrets', () => {
    expect(redactSecretValues({ a: FIXTURE_KEY_A }, [])).toEqual({
      a: FIXTURE_KEY_A,
    });
    expect(redactSecretValues(FIXTURE_KEY_A, ['', '  '])).toBe(FIXTURE_KEY_A);
  });

  it('passes non-string values through unchanged', () => {
    expect(redactSecretValues(42, [FIXTURE_KEY_A])).toBe(42);
    expect(redactSecretValues(true, [FIXTURE_KEY_A])).toBe(true);
    expect(redactSecretValues(null, [FIXTURE_KEY_A])).toBeNull();
    expect(redactSecretValues(undefined, [FIXTURE_KEY_A])).toBeUndefined();
  });

  it('redacts overlapping secrets and nested arrays exactly', () => {
    const out = redactSecretValues({ deep: [[`pre-${FIXTURE_KEY_A}-post`]] }, [
      FIXTURE_KEY_A,
    ]);
    expect(out).toEqual({ deep: [['pre-[REDACTED]-post']] });
  });
});

// A live value is matched as a SUBSTRING by the debug/persistence redaction
// and by the §60 ledger refusal. A short or dummy key (`gw`, `solo`, `1`, a
// key named like its provider) would redact every word it appears in and —
// on the ledger — refuse the very credential-use row that names the
// provider; below the minimum length the value is not matched at all.
describe('short live values are not substring-matched (issue #359)', () => {
  const AT_MIN = 'abcd1234';
  const BELOW_MIN = 'abcd123';

  it('pins the minimum at 8 characters', () => {
    expect(MIN_MATCHABLE_SECRET_LENGTH).toBe(8);
    expect(AT_MIN).toHaveLength(MIN_MATCHABLE_SECRET_LENGTH);
    expect(BELOW_MIN).toHaveLength(MIN_MATCHABLE_SECRET_LENGTH - 1);
  });

  it('redactSecretValues redacts a value at the minimum length and leaves a shorter one alone', () => {
    expect(redactSecretValues(`key ${AT_MIN} end`, [AT_MIN])).toBe(
      'key [REDACTED] end',
    );
    expect(redactSecretValues(`key ${BELOW_MIN} end`, [BELOW_MIN])).toBe(
      `key ${BELOW_MIN} end`,
    );
  });

  it('redacts the longest of overlapping values first, whatever the inventory order', () => {
    const line = 'x abcdefgh1234 y';
    expect(redactSecretValues(line, ['abcdefgh', 'abcdefgh1234'])).toBe(
      'x [REDACTED] y',
    );
    expect(redactSecretValues(line, ['abcdefgh1234', 'abcdefgh'])).toBe(
      'x [REDACTED] y',
    );
  });

  it('a dummy key does not blank the words it happens to spell', () => {
    const line = 'provider ollama solo mode gw 1';
    expect(redactSecretValues(line, ['ollama', 'solo', 'gw', '1'])).toBe(line);
  });

  it('a short value does not stop a real one in the same inventory from redacting', () => {
    expect(redactSecretValues(`a ${AT_MIN} b gw`, ['gw', AT_MIN])).toBe(
      'a [REDACTED] b gw',
    );
  });
});

describe('redactingSink (issue #359: the debug channel)', () => {
  it('scrubs a secret-bearing line before the sink sees it, reading the inventory per line', () => {
    const seen: string[] = [];
    let live: string[] = [];
    const sink = redactingSink(
      (line) => seen.push(line),
      () => live,
    );
    sink('before the key resolved: sk-live-abcdef123456');
    live = ['sk-live-abcdef123456'];
    sink('provider said: bad key sk-live-abcdef123456!');
    sink('a clean line');
    expect(seen).toEqual([
      'before the key resolved: sk-live-abcdef123456',
      'provider said: bad key [REDACTED]!',
      'a clean line',
    ]);
  });
});

describe('redactBridgeWrites (issue #359: session persistence)', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0))
      rmSync(dir, { recursive: true, force: true });
  });
  const KEY = 'sk-live-abcdef123456';

  function fixture(secrets: () => string[]) {
    const dir = mkdtempSync(join(tmpdir(), 'kubic-359-bridge-'));
    dirs.push(dir);
    const inner = createNodeFileBridge(dir);
    return {
      dir,
      bridge: redactBridgeWrites(inner, secrets),
      read: (name: string) => readFileSync(join(dir, name), 'utf8'),
    };
  }

  it('scrubs text written, appended and appended durably; leaves clean text and reads alone', () => {
    const { bridge, read } = fixture(() => [KEY]);
    bridge.writeFile('w.txt', `write ${KEY} end`);
    bridge.appendFile('a.txt', `append ${KEY}\n`);
    bridge.appendFile('a.txt', 'clean line\n');
    bridge.appendDurably?.('d.txt', `durable ${KEY}\n`);
    expect(read('w.txt')).toBe('write [REDACTED] end');
    expect(read('a.txt')).toBe('append [REDACTED]\nclean line\n');
    expect(read('d.txt')).toBe('durable [REDACTED]\n');
    expect(bridge.readTextFile('w.txt')).toBe('write [REDACTED] end');
  });

  it('matches the JSON-escaped form a JSONL line carries', () => {
    const tricky = 'sk-"quoted"\\slash-123456';
    const { bridge, read } = fixture(() => [tricky]);
    bridge.appendFile(
      's.jsonl',
      `${JSON.stringify({ text: `bad ${tricky}` })}\n`,
    );
    const line = read('s.jsonl');
    expect(line).not.toContain('quoted');
    expect(JSON.parse(line)).toEqual({ text: 'bad [REDACTED]' });
  });

  // A value ending in a backslash: its raw form is a PREFIX of its JSON-escaped
  // form (`k\\` vs `k\\\\`), so replacing the raw form first leaves a dangling
  // escape that breaks the session line. Longest form first.
  it('keeps a JSONL line parseable for a key ending in a backslash and for one containing a quote', () => {
    for (const tricky of [
      'sk-tail-1234567\\',
      'sk-"quo"-1234567',
      'sk-mid\\-"-12345',
    ]) {
      const { bridge, read } = fixture(() => [tricky]);
      bridge.appendFile(
        's.jsonl',
        `${JSON.stringify({ text: `bad ${tricky}`, after: 'ok' })}\n`,
      );
      const line = read('s.jsonl');
      expect(JSON.parse(line)).toEqual({ text: 'bad [REDACTED]', after: 'ok' });
    }
  });

  it('reads the inventory at write time, and never rewrites binary content', () => {
    let live: string[] = [];
    const { bridge, read, dir } = fixture(() => live);
    bridge.appendFile('l.txt', `early ${KEY}\n`);
    live = [KEY];
    bridge.appendFile('l.txt', `late ${KEY}\n`);
    bridge.writeFile('b.bin', new TextEncoder().encode(`bin ${KEY}`));
    expect(read('l.txt')).toBe(`early ${KEY}\nlate [REDACTED]\n`);
    expect(readFileSync(join(dir, 'b.bin'), 'utf8')).toBe(`bin ${KEY}`);
  });

  it('a value below the minimum length is not matched', () => {
    const { bridge, read } = fixture(() => ['gw']);
    bridge.writeFile('short.txt', 'gw stays gw');
    expect(read('short.txt')).toBe('gw stays gw');
  });
});

// Identity words are not secrets (issue #359): a dummy key that IS its
// provider's name (`lm-studio`) or sits inside a provider/model id must not
// be scrubbed or refuse a ledger row, or the run's own identity is rewritten.
describe('withoutIdentity', () => {
  it('drops a value equal to an identity word, case-insensitively', () => {
    expect(withoutIdentity(['lm-studio'], ['lm-studio'])).toEqual([]);
    expect(withoutIdentity(['LM-Studio'], ['lm-studio'])).toEqual([]);
    expect(withoutIdentity(['lm-studio'], ['LM-STUDIO'])).toEqual([]);
  });

  it('drops a value contained in an identity word, keeps one that merely contains it', () => {
    expect(withoutIdentity(['studio-l'], ['my-studio-local'])).toEqual([]);
    expect(withoutIdentity(['lm-studio-real-key'], ['lm-studio'])).toEqual([
      'lm-studio-real-key',
    ]);
  });

  it('keeps unrelated values, in order, and every value with no identity or only blank words', () => {
    expect(
      withoutIdentity(
        ['sk-live-abcdef', 'lm-studio', 'other-key-1'],
        ['lm-studio'],
      ),
    ).toEqual(['sk-live-abcdef', 'other-key-1']);
    expect(withoutIdentity(['sk-live-abcdef'], [])).toEqual(['sk-live-abcdef']);
    expect(withoutIdentity(['sk-live-abcdef'], ['', ''])).toEqual([
      'sk-live-abcdef',
    ]);
  });
});
