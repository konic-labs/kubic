import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ExecutionEnv, Provenance } from './contracts.js';
import { NodeExecutionEnv } from './node-env.js';
import { MAX_CHILD_OUTPUT_BYTES } from './node-shell.js';
import { toolSpawnEnv } from './tool-env.js';

const PROV: Provenance = {
  sessionId: 's1',
  agentId: 'a1',
  toolCallId: 't1',
  turnId: 1,
  operation: 'bash',
};

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

function makeNodeEnv(): { env: ExecutionEnv; cwd: string } {
  const cwd = mkdtempSync(join(tmpdir(), 'exec-env-'));
  tempDirs.push(cwd);
  return { env: new NodeExecutionEnv(cwd), cwd };
}

// A child that blocks until the test drops a `go` file into its cwd — a
// deterministic handshake in place of a fixed sleep.
const AWAIT_GO =
  "const t=setInterval(()=>{if(require('node:fs').existsSync('go')){clearInterval(t);";

const AWAIT_GO_END = '}},5)';

// The cap is documented in BYTES, but the accumulator compared
// UTF-16 code units — so CJK/emoji output admitted up to ~3x the intended
// memory (a 3-byte character cost 1 unit), the header misstated the dropped
// size, and slice(-cap) could start the kept tail with half a surrogate
// pair (a lone low surrogate, which reaches the model and the session store
// as U+FFFD). Bytes are the bound; code points are the trim boundary.
const CAP_HEADER =
  /^\[kubic: output truncated — dropped (\d+) leading bytes, kept the last (\d+)\]\n/;

function cappedTail(stdout: string): {
  dropped: number;
  kept: number;
  tail: string;
} {
  const match = stdout.match(CAP_HEADER);
  expect(match).not.toBeNull();
  const head = match as RegExpMatchArray;
  return {
    dropped: Number(head[1]),
    kept: Number(head[2]),
    tail: stdout.slice(head[0].length),
  };
}

describe('execution env spawn failures', () => {
  it('settles wait() with a named error instead of crashing on a missing binary', async () => {
    // A spawn that cannot start the child emits 'error' (ENOENT) and never
    // 'close'. Without a handler Node re-throws it as an uncaught
    // exception, so the caller dies raw: no
    // exit code, no exit code line. wait() must settle with exit 127 and
    // the reason on stderr instead.
    const { env } = makeNodeEnv();
    const handle = env.shell.spawn('kubic-no-such-binary-xyz', [], {
      provenance: PROV,
    });
    const result = await handle.wait();
    expect(result.exitCode).toBe(127);
    expect(result.stderr).toMatch(/ENOENT/);
    expect(result.stderr).toMatch(/kubic-no-such-binary-xyz/);
    expect(result.provenance).toEqual(PROV);
  });

  it('reports the spawn reason through onUpdate as well', async () => {
    const { env } = makeNodeEnv();
    const seen: string[] = [];
    const handle = env.shell.spawn('kubic-no-such-binary-xyz', [], {
      provenance: PROV,
      onUpdate: (snapshot) => {
        if (snapshot.stderr !== '') seen.push(snapshot.stderr);
      },
    });
    await handle.wait();
    expect(seen.join('\n')).toMatch(/ENOENT/);
  });
});

// Child output is capped per stream at the shell seam. A
// chatty child (`yes`, a verbose build, a giant cat) must not OOM the
// run: accumulation keeps the TAIL (endings carry the error) and names
// the dropped leading bytes in a header on the final result.
describe('child output caps', () => {
  it('caps stdout at the default bound, keeps the tail, and names the drop', async () => {
    const { env } = makeNodeEnv();
    const total = MAX_CHILD_OUTPUT_BYTES + 2 * 1024 * 1024;
    const handle = env.shell.spawn(
      process.execPath,
      [
        '-e',
        `process.stdout.write('a'.repeat(${total})); process.stdout.write('TAIL-END')`,
      ],
      { provenance: PROV },
    );
    const result = await handle.wait();
    expect(result.exitCode).toBe(0);
    // Header line + kept tail: never more than the cap plus the header.
    expect(result.stdout.length).toBeLessThanOrEqual(
      MAX_CHILD_OUTPUT_BYTES + 200,
    );
    expect(result.stdout).toMatch(
      new RegExp(
        `^\\[kubic: output truncated — dropped ${total + 'TAIL-END'.length - MAX_CHILD_OUTPUT_BYTES} leading bytes, kept the last`,
      ),
    );
    // The tail is the whole point: the sentinel survives.
    expect(result.stdout.endsWith('TAIL-END')).toBe(true);
  });

  it('honours a per-spawn maxOutputBytes override on both streams independently', async () => {
    const { env } = makeNodeEnv();
    const snapshotLengths: number[] = [];
    const handle = env.shell.spawn(
      process.execPath,
      [
        '-e',
        `process.stdout.write('o'.repeat(3000)); process.stdout.write('OUT-TAIL'); ` +
          `process.stderr.write('e'.repeat(4000)); process.stderr.write('ERR-TAIL')`,
      ],
      {
        provenance: PROV,
        maxOutputBytes: 500,
        onUpdate: (snapshot) => {
          // The final close-path update announces the SETTLED result (header
          // + tail) — the interim snapshots (exitCode null) are the live
          // accumulator, and THAT is what the cap must bound.
          if (snapshot.exitCode === null) {
            snapshotLengths.push(
              snapshot.stdout.length,
              snapshot.stderr.length,
            );
          }
        },
      },
    );
    const result = await handle.wait();
    // Final results: header + tail, capped.
    expect(result.stdout).toMatch(
      /^\[kubic: output truncated — dropped 2508 leading bytes, kept the last 500\]/,
    );
    expect(result.stdout.endsWith('OUT-TAIL')).toBe(true);
    expect(result.stderr).toMatch(
      /^\[kubic: output truncated — dropped 3508 leading bytes, kept the last 500\]/,
    );
    expect(result.stderr.endsWith('ERR-TAIL')).toBe(true);
    // Even the live accumulation never exceeded the cap (the accumulator
    // is the thing the cap exists to bound — progress snapshots included).
    for (const length of snapshotLengths) {
      expect(length).toBeLessThanOrEqual(500);
    }
  });

  // Past the cap a snapshot keeps its length while its head
  // moves; the dropped count says where it starts, so a reader following
  // the stream (the agent fact scanner) never misses or repeats output.
  it('says how much of each stream a live snapshot dropped', async () => {
    const { env } = makeNodeEnv();
    const positions: Array<{ end: number; text: string; dropped: number }> = [];
    const handle = env.shell.spawn(
      process.execPath,
      [
        '-e',
        `let i = 0; const t = setInterval(() => { process.stdout.write('line ' + i + '\\n'); if (++i === 200) clearInterval(t); }, 1);`,
      ],
      {
        provenance: PROV,
        maxOutputBytes: 300,
        onUpdate: (snapshot) => {
          if (snapshot.exitCode !== null) return;
          const dropped = snapshot.dropped?.stdout ?? 0;
          positions.push({
            end: dropped + snapshot.stdout.length,
            text: snapshot.stdout,
            dropped,
          });
        },
      },
    );
    await handle.wait();
    const last = positions.at(-1);
    expect(last?.dropped ?? 0).toBeGreaterThan(0);
    // The stream position only grows, and the kept text is the true tail of
    // everything written up to it.
    const written = Array.from({ length: 200 }, (_, i) => `line ${i}\n`).join(
      '',
    );
    for (let i = 0; i < positions.length; i += 1) {
      const at = positions[i];
      if (at === undefined) continue;
      expect(written.slice(at.dropped, at.end)).toBe(at.text);
      if (i > 0) expect(at.end).toBeGreaterThan(positions[i - 1]?.end ?? 0);
    }
  });

  it('leaves under-cap output byte-identical with no header', async () => {
    const { env } = makeNodeEnv();
    const handle = env.shell.spawn('echo', ['tiny'], { provenance: PROV });
    const result = await handle.wait();
    expect(result.stdout).toBe('tiny\n');
    expect(result.stdout).not.toMatch(/\[kubic: output truncated/);
  });
});

describe('child output caps count bytes', () => {
  it('keeps at most maxOutputBytes of UTF-8, not of UTF-16 units', async () => {
    const { env } = makeNodeEnv();
    // 100 three-byte characters: 300 UTF-8 bytes, 100 UTF-16 units.
    const handle = env.shell.spawn(
      process.execPath,
      ['-e', `process.stdout.write('日'.repeat(100))`],
      { provenance: PROV, maxOutputBytes: 10 },
    );
    const result = await handle.wait();
    const { kept, tail } = cappedTail(result.stdout);
    expect(Buffer.byteLength(tail, 'utf8')).toBeLessThanOrEqual(10);
    // 3 whole characters fit; the tenth byte would cut one in half.
    expect(kept).toBe(9);
    expect(tail).toBe('日日日');
    expect(tail).not.toContain('\uFFFD');
  });

  it("reports the header's dropped and kept counts in bytes", async () => {
    const { env } = makeNodeEnv();
    const total = Buffer.byteLength('日'.repeat(100), 'utf8');
    const handle = env.shell.spawn(
      process.execPath,
      ['-e', `process.stdout.write('日'.repeat(100))`],
      { provenance: PROV, maxOutputBytes: 10 },
    );
    const result = await handle.wait();
    const { dropped, kept, tail } = cappedTail(result.stdout);
    const tailBytes = Buffer.byteLength(tail, 'utf8');
    // Both numbers describe the same units the cap does: bytes.
    expect(kept).toBe(tailBytes);
    expect(dropped).toBe(total - tailBytes);
  });

  it('never starts the kept tail with half a surrogate pair', async () => {
    const { env } = makeNodeEnv();
    // 100 four-byte emoji: 4 UTF-8 bytes, 2 UTF-16 units each.
    const four = env.shell.spawn(
      process.execPath,
      ['-e', `process.stdout.write('😀'.repeat(100))`],
      { provenance: PROV, maxOutputBytes: 4 },
    );
    const fourResult = await four.wait();
    const whole = cappedTail(fourResult.stdout);
    // Exactly one complete code point fits in four bytes.
    expect(whole.tail).toBe('😀');
    expect(whole.kept).toBe(4);
    // A cap of three cannot hold an emoji: the tail is empty, never a
    // dangling low surrogate, as slice(-3) would produce.
    const three = env.shell.spawn(
      process.execPath,
      ['-e', `process.stdout.write('😀'.repeat(100))`],
      { provenance: PROV, maxOutputBytes: 3 },
    );
    const threeResult = await three.wait();
    const partial = cappedTail(threeResult.stdout);
    expect(partial.tail).toBe('');
    expect(partial.dropped).toBe(400);
    expect(/^[\uDC00-\uDFFF]/.test(partial.tail)).toBe(false);
  });
});

// Pipe chunks are arbitrary byte slices. Decoding each chunk
// with Buffer.toString() independently corrupts any multi-byte UTF-8
// codepoint split across a chunk boundary (U+FFFD on both sides of the
// split). The seam must decode through one StringDecoder per stream — the
// decoder carries split codepoints across writes — and flush a trailing
// incomplete sequence via decoder.end() on settle.
describe('multi-byte UTF-8 chunk boundaries', () => {
  // One emoji as two explicit Buffer halves. The child writes the second
  // half only after the parent has seen the first as its own `data` event
  // (the `go` handshake) — back-to-back writes can coalesce into a single
  // chunk and never exercise the boundary at all.
  const EMOJI = '\u{1F600}';
  const emojiBytes = [...Buffer.from(EMOJI, 'utf8')]; // f0 9f 98 80
  const firstHalf = emojiBytes.slice(0, 2);
  const secondHalf = emojiBytes.slice(2);
  const splitWrite = (stream: 'stdout' | 'stderr'): string =>
    `process.${stream}.write(Buffer.from([${firstHalf.join(',')}]));` +
    `${AWAIT_GO}process.${stream}.write(Buffer.from([${secondHalf.join(',')}]))${AWAIT_GO_END}`;
  // Release the child on the first data event (the first half, alone).
  const releaseOnFirstChunk = (cwd: string) => () => {
    const go = join(cwd, 'go');
    if (!existsSync(go)) writeFileSync(go, '');
  };

  it('reassembles a stdout codepoint split across two data events', async () => {
    const { env, cwd } = makeNodeEnv();
    const handle = env.shell.spawn(
      process.execPath,
      ['-e', splitWrite('stdout')],
      { provenance: PROV, onUpdate: releaseOnFirstChunk(cwd) },
    );
    const result = await handle.wait();
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe(EMOJI);
    expect(result.stdout).not.toContain('\uFFFD');
  });

  it('reassembles a stderr codepoint split across two data events', async () => {
    const { env, cwd } = makeNodeEnv();
    const handle = env.shell.spawn(
      process.execPath,
      ['-e', splitWrite('stderr')],
      { provenance: PROV, onUpdate: releaseOnFirstChunk(cwd) },
    );
    const result = await handle.wait();
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe(EMOJI);
    expect(result.stderr).not.toContain('\uFFFD');
  });

  it('flushes a trailing incomplete byte sequence at exit without throwing', async () => {
    // The child ends mid-codepoint (the exit-time case of a mid-write kill):
    // the decoder still holds the two partial bytes at 'close' and must
    // flush them via decoder.end() — as U+FFFD — instead of dropping them
    // or throwing.
    const { env } = makeNodeEnv();
    const handle = env.shell.spawn(
      process.execPath,
      [
        '-e',
        `process.stdout.write("ok");process.stdout.write(Buffer.from([${firstHalf.join(',')}]))`,
      ],
      { provenance: PROV },
    );
    const result = await handle.wait();
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('ok\uFFFD');
  });
});

// Tool processes never inherit ambient authority. A provider key in
// kubic's own environment must not reach a spawned child.
describe('tool child env allowlist', () => {
  const planted = [
    'FAKE_PROVIDER_API_KEY',
    'ANTHROPIC_API_KEY',
    'GITHUB_TOKEN',
    'AWS_SECRET_ACCESS_KEY',
    'LC_SECRET_KEY',
  ];
  const saved = new Map<string, string | undefined>();

  afterEach(() => {
    for (const [k, v] of saved) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    saved.clear();
  });

  it('a spawned child sees the allowlisted base, never credentials', async () => {
    for (const k of [...planted, 'LC_TIME']) saved.set(k, process.env[k]);
    for (const k of planted) process.env[k] = 'sk-leak';
    process.env.LC_TIME = 'C';
    const { env } = makeNodeEnv();
    const handle = env.shell.spawn(
      process.execPath,
      ['-e', 'process.stdout.write(JSON.stringify(process.env))'],
      { provenance: PROV },
    );
    const result = await handle.wait();
    const childEnv = JSON.parse(result.stdout) as Record<string, string>;
    for (const k of planted) expect(childEnv[k]).toBeUndefined();
    expect(JSON.stringify(childEnv)).not.toContain('sk-leak');
    expect(childEnv.PATH).toBe(process.env.PATH);
    expect(childEnv.LC_TIME).toBe('C');
    if (process.env.HOME !== undefined)
      expect(childEnv.HOME).toBe(process.env.HOME);
  });
});

describe('toolSpawnEnv allowlist coverage', () => {
  it('passes proxy, CA and XDG settings; secret suffixes still win', () => {
    const out = toolSpawnEnv({
      HTTP_PROXY: 'h',
      https_proxy: 'h2',
      NO_PROXY: 'n',
      no_proxy: 'n2',
      NODE_EXTRA_CA_CERTS: 'ca',
      SSL_CERT_FILE: 'f',
      SSL_CERT_DIR: 'd',
      XDG_CONFIG_HOME: 'x',
      GIT_CONFIG_NOSYSTEM: '1',
      XDG_SECRET_KEY: 'leak',
      OPENAI_API_KEY: 'leak',
    });
    expect(out).toEqual({
      HTTP_PROXY: 'h',
      https_proxy: 'h2',
      NO_PROXY: 'n',
      no_proxy: 'n2',
      NODE_EXTRA_CA_CERTS: 'ca',
      SSL_CERT_FILE: 'f',
      SSL_CERT_DIR: 'd',
      XDG_CONFIG_HOME: 'x',
      GIT_CONFIG_NOSYSTEM: '1',
    });
  });

  // `LC_*` travels over SSH (`AcceptEnv LANG LC_*`), so the prefix alone is
  // no reason to pass a variable: only the locale categories and the XDG
  // base directories get through.
  it('passes the locale and XDG directory names, nothing else under their prefixes', () => {
    const allowed = [
      'LC_ALL',
      'LC_CTYPE',
      'LC_COLLATE',
      'LC_MESSAGES',
      'LC_MONETARY',
      'LC_NUMERIC',
      'LC_TIME',
      'LC_ADDRESS',
      'LC_IDENTIFICATION',
      'LC_MEASUREMENT',
      'LC_NAME',
      'LC_PAPER',
      'LC_TELEPHONE',
      'XDG_CONFIG_HOME',
      'XDG_DATA_HOME',
      'XDG_STATE_HOME',
      'XDG_CACHE_HOME',
      'XDG_RUNTIME_DIR',
      'XDG_CONFIG_DIRS',
      'XDG_DATA_DIRS',
    ];
    const withheld = [
      'LC_PGPASSWORD',
      'LC_DATABASE_URL',
      'LC_KUBECONFIG',
      'XDG_SECRET_URL',
    ];
    const base = Object.fromEntries(
      [...allowed, ...withheld].map((key) => [key, 'value']),
    );
    expect(Object.keys(toolSpawnEnv(base)).sort()).toEqual([...allowed].sort());
  });
});

// The workload-identity federation keys carry no secret suffix; only the
// explicit name list in core keeps them out of a tool child.
describe('federation identity keys in the tool env', () => {
  it('never passes the workload-identity keys to a tool child', () => {
    const out = toolSpawnEnv({
      PATH: '/usr/bin',
      ANTHROPIC_IDENTITY_TOKEN_FILE: '/run/secrets/token',
      ANTHROPIC_FEDERATION_RULE_ID: 'rule-1',
      ANTHROPIC_ORGANIZATION_ID: 'org-1',
      ANTHROPIC_SERVICE_ACCOUNT_ID: 'sa-1',
      ANTHROPIC_WORKSPACE_ID: 'ws-1',
    });
    expect(out).toEqual({ PATH: '/usr/bin' });
  });
});

// A proxy URL's userinfo (`http://user:password@proxy:3128`) is a
// credential in the sense, but the NAME looks benign, so the secret-name
// check never sees it and it reached every tool child — where the model can read it
// with `echo $HTTPS_PROXY`. The value keeps its scheme, host
// and port and loses the userinfo; a proxy that REQUIRES that auth is not
// usable from a tool child (Kubic does not broker proxy auth).
describe('proxy credentials in the tool env', () => {
  it('strips the userinfo, keeping scheme, host and port', () => {
    const out = toolSpawnEnv({
      HTTPS_PROXY: 'http://user:sekret-pass@proxy.corp:3128',
      http_proxy: 'http://u:p@h:1',
    });
    expect(out.HTTPS_PROXY).toBe('http://proxy.corp:3128');
    expect(out.http_proxy).toBe('http://h:1');
    expect(JSON.stringify(out)).not.toContain('sekret-pass');
    expect(JSON.stringify(out)).not.toContain('@');
  });

  it('passes a proxy URL without userinfo through unchanged', () => {
    const out = toolSpawnEnv({
      HTTPS_PROXY: 'http://proxy.corp:3128',
      http_proxy: 'socks5h://proxy.corp:1080',
      NO_PROXY: 'localhost,127.0.0.1',
      no_proxy: 'localhost,127.0.0.1',
    });
    expect(out).toEqual({
      HTTPS_PROXY: 'http://proxy.corp:3128',
      http_proxy: 'socks5h://proxy.corp:1080',
      NO_PROXY: 'localhost,127.0.0.1',
      no_proxy: 'localhost,127.0.0.1',
    });
  });

  it('handles the shapes a proxy value can take', () => {
    const out = toolSpawnEnv({
      // No scheme: the whole value is the authority.
      HTTP_PROXY: 'user:sekret@proxy.corp:3128',
      // Userinfo with no password.
      http_proxy: 'http://user@proxy.corp:3128',
      // Path and query survive the strip.
      HTTPS_PROXY: 'http://u:sekret@proxy.corp:3128/path?x=1',
      // An '@' that is not userinfo stays put.
      NO_PROXY: 'proxy.corp/@scope',
      // Percent-encoded userinfo is still userinfo.
      https_proxy: 'http://u%40x:sekret@proxy.corp:3128',
    });
    expect(out).toEqual({
      HTTP_PROXY: 'proxy.corp:3128',
      http_proxy: 'http://proxy.corp:3128',
      HTTPS_PROXY: 'http://proxy.corp:3128/path?x=1',
      NO_PROXY: 'proxy.corp/@scope',
      https_proxy: 'http://proxy.corp:3128',
    });
    expect(JSON.stringify(out)).not.toContain('sekret');
  });

  it('strips a scheme-less value whose path contains :// (never fails open)', () => {
    // Anchoring the scheme at position 0 is what keeps this from returning
    // the value untouched: searching the whole string for '://' sliced the
    // "authority" out of the path and missed the '@' entirely.
    const out = toolSpawnEnv({
      HTTP_PROXY: 'user:sekret@proxy.corp:3128/path://x',
    });
    expect(out.HTTP_PROXY).toBe('proxy.corp:3128/path://x');
    expect(JSON.stringify(out)).not.toContain('sekret');
  });
});

describe('kill escalation reaches the whole group', () => {
  it.runIf(process.platform !== 'win32')(
    'SIGKILLs group members that ignore SIGTERM even after the leader exits',
    async () => {
      const { env, cwd } = makeNodeEnv();
      let stdout = '';
      // Leader dies on SIGTERM; its grandchild ignores SIGTERM and has its
      // stdio detached, so the leader's close settles the handle early.
      const handle = env.shell.spawn(
        process.execPath,
        [
          '-e',
          "const c=require('child_process').spawn(process.execPath,['-e',\"process.on('SIGTERM',()=>{});require('fs').writeFileSync('gc-ready','');setInterval(()=>{},1000)\"],{stdio:'ignore'});process.stdout.write(String(c.pid));setInterval(()=>{},1000)",
        ],
        {
          provenance: PROV,
          killGraceMs: 50,
          onUpdate: (snap) => (stdout = snap.stdout),
        },
      );
      const groupId = handle.pid as number;
      const alive = (pid: number): boolean => {
        try {
          process.kill(pid, 0);
          return true;
        } catch {
          return false;
        }
      };
      try {
        const grandchild = await vi.waitFor(
          () => {
            const pid = Number(stdout);
            if (!(pid > 0)) throw new Error('no pid yet');
            return pid;
          },
          { timeout: 5000, interval: 5 },
        );
        // The grandchild's SIGTERM handler is installed before the kill.
        await vi.waitFor(
          () => {
            if (!existsSync(join(cwd, 'gc-ready')))
              throw new Error('not ready');
          },
          { timeout: 5000, interval: 5 },
        );
        expect(alive(grandchild)).toBe(true);
        handle.kill();
        await handle.wait();
        await vi.waitFor(
          () => {
            if (alive(grandchild)) throw new Error('grandchild survived');
          },
          { timeout: 3000, interval: 20 },
        );
      } finally {
        try {
          process.kill(-groupId, 'SIGKILL');
        } catch {
          // Gone.
        }
      }
    },
  );
});
