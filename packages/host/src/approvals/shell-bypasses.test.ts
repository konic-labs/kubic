// Bypass attempts around the shell detectors. A literal `.kubic/journal` write
// stays refused even after a `cd` that does not really change the directory
// at the write. The rule pinned here: classify BOTH the token as typed
// (against the workspace) AND the cd-tracked resolution, and raise if EITHER
// is control-plane (or, for outside-write, outside) — phantom, conditional,
// subshell, quoted or echoed `cd`s can then only over-trigger, never hide a
// write. Production classifiers; no network.
// biome-ignore-all lint/suspicious/noTemplateCurlyInString: `${HOME}` here is bash syntax under test, not a template literal
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  confinePath,
  defaultIsDestructive,
  isNetworkCommand,
} from '@kubic/agent/lane/interceptors';
import { afterEach, describe, expect, it } from 'vitest';
import { controlPlaneRefusal } from './control-plane.js';
import { enableFullAccess } from './full-access.js';
import { installPolicy } from './install.js';
import { KUBIC_STATE_WRITE } from './policy.js';
import { FileApprovalStore } from './stores.js';
import type { TriggerContext } from './triggers.js';
import { detectTriggers } from './triggers.js';

const WS = '/work';
const HOME = '/home/tester';

const made: string[] = [];

function mkTmp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  made.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of made.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

function ctx(overrides: Partial<TriggerContext> = {}): TriggerContext {
  return {
    workspace: WS,
    network: 'none',
    isDestructive: defaultIsDestructive,
    isNetworkCommand,
    isOutsideWorkspace: (path: string) => confinePath(WS, path).rewritten,
    home: HOME,
    controlPlane: { home: HOME },
    ...overrides,
  };
}

function triggers(command: string, overrides: Partial<TriggerContext> = {}) {
  return detectTriggers('bash', { command }, ctx(overrides));
}

function refusal(command: string): string | undefined {
  return controlPlaneRefusal('bash', { command }, WS, { home: HOME });
}

const REFUSED = 'control-plane state';

describe('a cd that does not change the directory at the write cannot hide it', () => {
  it.each([
    ['a subshell cd', '(cd x); echo pwned > .kubic/journal/index.jsonl'],
    ['a conditional cd', 'false && cd x; echo p > .kubic/journal/y'],
    ['a quoted cd', ": ';cd x'; echo p > .kubic/journal/y"],
    ['an echoed cd', 'echo then cd x; echo p > .kubic/journal/y'],
    ['a redirect on the cd itself', 'cd sub > .kubic/journal/x'],
    ['a bare cd with a redirect', 'cd > .kubic/journal/x'],
  ])('%s: the literal journal write is still refused', (_name, command) => {
    expect(refusal(command), command).toContain(REFUSED);
    expect(triggers(command), command).toContain(KUBIC_STATE_WRITE);
  });

  it('cd with a redirect, then a write to ~/.kubic/config.toml, asks (never silent)', () => {
    const command = 'cd 2>/dev/null; echo "[approvals]" > .kubic/config.toml';
    expect(triggers(command)).toContain(KUBIC_STATE_WRITE);
    expect(refusal(command)).toBeUndefined();
  });

  it('full access does not approve any of them', async () => {
    const root = mkTmp('kubic-rev-full-');
    const workspace = mkTmp('kubic-rev-ws-');
    enableFullAccess(new FileApprovalStore(root), 'test');
    const policy = installPolicy({
      workspace,
      sessionDir: root,
      home: mkTmp('kubic-rev-home-'),
    });
    for (const command of [
      '(cd x); echo pwned > .kubic/journal/index.jsonl',
      'false && cd x; echo p > .kubic/journal/y',
      ": ';cd x'; echo p > .kubic/journal/y",
      'echo then cd x; echo p > .kubic/journal/y',
      'cd sub > .kubic/journal/x',
      'cd > .kubic/journal/x',
      'cd 2>/dev/null; echo "[approvals]" > .kubic/config.toml',
    ]) {
      const verdict = await policy.ask({
        toolName: 'bash',
        args: { command },
        toolCallId: 't',
      });
      expect(verdict, command).toMatchObject({ approved: false });
      expect(JSON.stringify(verdict), command).toMatch(
        /kubic-state-write|control-plane state/,
      );
    }
  });

  it('a really-changed directory is still followed (the tracked resolution is added, not dropped)', () => {
    expect(refusal('cd .kubic/journal && echo x > index.jsonl')).toContain(
      REFUSED,
    );
    expect(triggers('cd .kubic/roles && echo x > r.md')).toContain(
      KUBIC_STATE_WRITE,
    );
  });

  it('a redirect on a cd command applies BEFORE that cd runs', () => {
    // `cd .. > config.toml` writes the file in the directory we were IN.
    expect(triggers('cd .kubic && cd .. > config.toml')).toContain(
      KUBIC_STATE_WRITE,
    );
    expect(refusal('cd .kubic/journal && cd .. > index.jsonl')).toContain(
      REFUSED,
    );
    // The mirror: the redirect lands in the workspace, not in .kubic.
    expect(triggers('cd .kubic > config.toml')).not.toContain(
      KUBIC_STATE_WRITE,
    );
  });

  it('redirect words on a cd are not its directory', () => {
    for (const command of [
      'cd 2>/dev/null .kubic/roles && echo x > r.md',
      'cd > /dev/null .kubic/roles && echo x > r.md',
      'cd 2>&1 .kubic/roles && echo x > r.md',
      'cd &>/dev/null .kubic/roles && echo x > r.md',
      'cd >>/dev/null .kubic/roles && echo x > r.md',
      'cd < /dev/null .kubic/roles && echo x > r.md',
      'cd >& /dev/null .kubic/roles && echo x > r.md',
    ]) {
      expect(triggers(command), command).toContain(KUBIC_STATE_WRITE);
    }
  });

  it('outside-write is a union too: a phantom cd cannot hide a real ../ escape', () => {
    // As typed `../y` leaves /work; the tracked cwd (/work/sub) would call it inside.
    expect(triggers('(cd sub); echo x > ../y')).toContain('outside-write');
    expect(triggers('false && cd sub; echo x > ../y')).toContain(
      'outside-write',
    );
    // Documented over-trigger: a real `cd sub` followed by `../y` also asks.
    expect(triggers('cd sub && echo x > ../y')).toContain('outside-write');
    // Untouched: nothing escapes.
    expect(triggers('cd sub && echo x > y')).not.toContain('outside-write');
    expect(triggers('(cd sub); echo x > y')).not.toContain('outside-write');
  });
});

describe('cd is only a cd at a command start', () => {
  it.each([
    [
      'then',
      "cd /etc; git commit -m 'refactor: then cd /work/proj'; echo x > passwd",
    ],
    ['echoed do', 'cd /etc; echo do cd /work; echo x > passwd'],
    ['echoed then', 'cd /etc; echo then cd /work; echo x > passwd'],
    ['echoed brace', 'cd /etc; echo { cd /work; echo x > passwd'],
    ['echoed bang', 'cd /etc; echo ! cd /work; echo x > passwd'],
    [
      'a commit message mentioning else',
      "cd /etc; git commit -m 'else cd /work'; echo x > passwd",
    ],
  ])(
    '%s in argument text is not a cd: the real cd /etc still counts',
    (_n, command) => {
      expect(triggers(command)).toContain('outside-write');
    },
  );

  it.each([
    ['a keyword chain', 'if ! cd /tmp; then :; fi; echo x > z'],
    ['a brace group', '{ cd /tmp; echo x > z; }'],
    ['then command cd', 'if true; then command cd /tmp; echo x > z; fi'],
    ['do builtin cd', 'for d in a; do builtin cd /tmp; echo x > z; done'],
    [
      'an elif condition',
      'if false; then :; elif cd /tmp; then echo x > z; fi',
    ],
    ['a subshell', '(cd /tmp; echo x > z)'],
    ['after a newline', 'echo a\ncd /tmp\necho x > z'],
  ])('%s is still a cd', (_n, command) => {
    expect(triggers(command)).toContain('outside-write');
  });

  it('a keyword mid-text does not start a command', () => {
    expect(triggers('echo x then cd /tmp; echo y > z')).not.toContain(
      'outside-write',
    );
    expect(triggers('git commit -m "do cd /tmp"; echo y > z')).not.toContain(
      'outside-write',
    );
  });

  it('the scan is linear: a long run after a keyword cannot stall it', () => {
    for (const command of [
      `then${' '.repeat(40_000)}`,
      `${'then '.repeat(20_000)}x`,
      `${'; then '.repeat(10_000)}x`,
      `${'{ '.repeat(20_000)}x`,
      `${'! command '.repeat(10_000)}x`,
      `${'\t'.repeat(40_000)}cd`,
    ]) {
      const started = performance.now();
      triggers(command, { isDestructive: () => false });
      expect(performance.now() - started).toBeLessThan(500);
    }
  });
});

describe('git-push survives quotes, escapes and bangs', () => {
  it.each([
    [
      'an escaped quote in an -c value',
      "git -c user.name=O\\'Brien push origin main # it's fine",
    ],
    [
      'an escaped quote in a --git-dir value',
      "git --git-dir=/tmp/it\\'s/.git push origin; echo 'done'",
    ],
    ['a git inside an alias value', "git -c alias.p='!git push' p"],
    ['a bang boundary', '!git push'],
    ['an escaped space in an option argument', 'git -C my\\ dir push'],
    ['a double-quoted escaped quote', 'git -c "a\\"b c" push'],
    ['plain quoted (regression)', 'git -C "my dir" push'],
    ['plain (regression)', 'git push'],
  ])('%s raises git-push', (_name, command) => {
    expect(triggers(command)).toContain('git-push');
  });

  it.each([
    ['a longer word', 'gitk push'],
    ['a hyphenated tool', 'git-lfs push'],
    ['another verb', "git -c user.name=O\\'Brien pull"],
    ['a bang before another word', '!mygit push'],
  ])('%s does not raise git-push', (_name, command) => {
    expect(triggers(command)).not.toContain('git-push');
  });
});

describe('git-push only ever widens (the original regex is a lower bound)', () => {
  const OLD_GLOBALS = String.raw`(?:\s+(?:-[cC]\s+\S+|--(?:git-dir|work-tree|namespace|exec-path|config-env)(?:=\S+|\s+\S+)|--[a-z][a-z-]*|-[pP]))*`;
  const OLD_PUSH = new RegExp(
    String.raw`(^|[|;&\s(])git${OLD_GLOBALS}\s+push\b`,
    'i',
  );
  const OLD_REMOTE = new RegExp(
    String.raw`(^|[|;&\s(])git${OLD_GLOBALS}\s+remote\s+(add|set-url|remove|rename)\b`,
    'i',
  );
  const vocabulary = [
    'git',
    'GIT',
    'push',
    'pushd',
    'remote',
    'add',
    'show',
    '-c',
    '-C',
    '-p',
    '--namespace',
    '--namespace=a',
    '--git-dir',
    '--git-dir=a',
    '--no-pager',
    '-x',
    'a',
    'k=v',
    "'",
    '"',
    "\\'",
    '\\"',
    "'a b'",
    '"a b"',
    "it's",
    "O\\'B",
    '\\',
    '\\ ',
    ';',
    '&&',
    '|',
    '||',
    '#',
    '\n',
    '(',
    ')',
    '`',
    '$(',
    '!',
    '/',
    '/usr/bin/git',
    '!git',
  ];
  const joiners = [' ', ' ', ' ', '', '\t', '\n'];

  // The quote-aware tokenizer changed what "a word" is, so the old regex is
  // the fail-open oracle: every command it flagged must STILL be flagged
  // (raising more is the safe direction). There is no allow-list — the walk
  // runs the old whitespace tokenization alongside the quote-aware one.
  it.each([0x2f6e2b1, 0x1b873593, 0x9e3779b1, 0x85ebca6b, 0xc2b2ae35])(
    'never loses a push the original flagged (seed %i)',
    (initial) => {
      let seed = initial;
      const next = (bound: number): number => {
        seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
        return seed % bound;
      };
      let flagged = 0;
      let widened = 0;
      for (let run = 0; run < 5_000; run += 1) {
        const length = 1 + next(9);
        const words = ['git'];
        for (let index = 0; index < length; index += 1) {
          words.push(vocabulary[next(vocabulary.length)] ?? 'a');
        }
        let command = '';
        for (const word of words) {
          command += word + (joiners[next(joiners.length)] ?? ' ');
        }
        const original = OLD_PUSH.test(command) || OLD_REMOTE.test(command);
        const now = triggers(command, { isDestructive: () => false }).includes(
          'git-push',
        );
        if (original) {
          flagged += 1;
          expect(now, JSON.stringify(command)).toBe(true);
        } else if (now) {
          widened += 1;
        }
      }
      // Both directions must be exercised, or the sweep proves nothing.
      expect(flagged).toBeGreaterThan(50);
      expect(widened).toBeGreaterThan(20);
    },
  );
});

describe('the remaining bypasses of the approval surface', () => {
  it('cd -- <dir> and option words are not the directory', () => {
    expect(refusal('cd -- .kubic && rm journal/x')).toContain(REFUSED);
    expect(refusal('cd -L -- .kubic && rm journal/x')).toContain(REFUSED);
    expect(refusal('cd -P .kubic && rm journal/x')).toContain(REFUSED);
    expect(refusal('cd -- .kubic > /dev/null && rm journal/x')).toContain(
      REFUSED,
    );
  });

  it('$PWD, ${PWD} and ~+ are the current directory', () => {
    expect(refusal('cd "$PWD/.kubic" && rm journal/x')).toContain(REFUSED);
    expect(refusal('cd ${PWD}/.kubic && rm journal/x')).toContain(REFUSED);
    expect(refusal('cd ~+/.kubic && rm journal/x')).toContain(REFUSED);
    expect(refusal('cd "$PWD"/.kubic && rm journal/x')).toContain(REFUSED);
    expect(refusal('echo x > ~+/.kubic/journal/y')).toContain(REFUSED);
    expect(refusal('echo x > $PWD/.kubic/journal/y')).toContain(REFUSED);
    expect(refusal('echo x > ${PWD}/.kubic/journal/y')).toContain(REFUSED);
    expect(refusal('cd src && echo x > $PWD/../.kubic/journal/y')).toContain(
      REFUSED,
    );
    expect(refusal('echo x > ${PWD:-/x}/.kubic/journal/y')).toContain(REFUSED);
    expect(triggers('echo x > ~+/.kubic/config.toml')).toContain(
      KUBIC_STATE_WRITE,
    );
    expect(triggers('echo x > ~+/notes.md')).not.toContain(KUBIC_STATE_WRITE);
    expect(triggers('echo x > $PWD/notes.md')).not.toContain(KUBIC_STATE_WRITE);
  });

  it('${HOME:-…} is the home directory like $HOME', () => {
    expect(refusal('echo x > ${HOME:-}/.kubic/journal/y')).toContain(REFUSED);
    expect(refusal('echo x > ${HOME:-/nowhere}/.kubic/journal/y')).toContain(
      REFUSED,
    );
    expect(refusal('echo x > ${HOME-x}/.kubic/journal/y')).toContain(REFUSED);
    expect(triggers('echo x > ${HOME:-}/.kubic/config.toml')).toContain(
      KUBIC_STATE_WRITE,
    );
    expect(triggers('echo x > ${HOMEX:-}/.kubic/config.toml')).not.toContain(
      KUBIC_STATE_WRITE,
    );
  });

  it('~- and $OLDPWD are an unknown directory: a .kubic segment fails closed', () => {
    expect(refusal('echo x > ~-/.kubic/journal/y')).toContain(REFUSED);
    expect(refusal('echo x > $OLDPWD/.kubic/journal/y')).toContain(REFUSED);
    expect(refusal('echo x > ${OLDPWD}/.kubic/journal/y')).toContain(REFUSED);
    expect(triggers('echo x > ~-/notes.md')).not.toContain(KUBIC_STATE_WRITE);
  });

  it('a glob that could expand into control-plane state is REFUSED, not just asked', () => {
    for (const command of [
      'rm .kubic/journa?/*',
      'rm -rf .kubic/*',
      'rm .kub*/journal/x',
      'echo x > .kubic/j*',
      'rm .kubic/[j]ournal/x',
      'rm .kubic/{journal,other}/y',
      'rm .kubic/{other,journal/x}',
      'rm .kubic/conf*',
      'rm .kubic/rol*/r.md',
      'rm .kubic/sess*/x',
      'rm .kubic/aud*',
      'rm ~/.kubic/sess*/x',
      'rm $HOME/.kubic/*',
      'cd .kubic && rm jour*/*',
      'rm -rf .kub*',
      'rm -rf .k?bic',
      'rm .kubic/[!x]ournal',
      'echo x > /work/.kubic/journa?/x',
      'echo x > /*/.kubic/journal/x',
    ]) {
      expect(refusal(command), command).toContain(REFUSED);
    }
  });

  it('globs that cannot reach the protected state are not refused', () => {
    for (const command of [
      'rm src/*.ts',
      'rm -rf build/*',
      'echo x > out-?.txt',
      'rm .kubic/cache*/x',
      'rm .kubic/[a]bc',
      'rm .kubic/{one,two}/x',
      'rm ./*.log',
    ]) {
      expect(refusal(command), command).toBeUndefined();
    }
    // Under .kubic but not a protected sub: still an ask, as the literal is.
    expect(triggers('rm .kubic/cache*/x')).toContain(KUBIC_STATE_WRITE);
    expect(triggers('rm src/*.ts')).not.toContain(KUBIC_STATE_WRITE);
  });

  it('a brace list past the enumeration limit is refused when it names .kubic', () => {
    const alternatives = Array.from({ length: 40 }, (_, i) => `a${i}`).join(
      ',',
    );
    expect(refusal(`rm .kubic/{${alternatives}}/x`)).toContain(REFUSED);
    expect(refusal(`rm out/{${alternatives}}/x`)).toBeUndefined();
    // Under the limit the alternatives are enumerated: none is protected.
    expect(refusal('rm .kubic/{a,b,c}/x')).toBeUndefined();
  });

  it('an enormous brace list cannot be used to slip past the glob check', () => {
    const alternatives = Array.from({ length: 200 }, (_, i) => `a${i}`).join(
      ',',
    );
    expect(refusal(`rm .kubic/{${alternatives},journal}/x`)).toContain(REFUSED);
  });

  // Documented limits, pinned so a fix is a conscious change: the detector
  // reads the command text and cannot follow these.
  it.each([
    [
      'bash -c hands the cd over as data',
      "bash -c 'cd .kubic && echo x > config.toml'",
    ],
    [
      'a time prefix is not a command start',
      'time cd .kubic && echo x > config.toml',
    ],
    [
      'eval hands the cd over as data',
      'eval cd .kubic && echo x > config.toml',
    ],
    [
      'a subshell cd undoing an earlier cd',
      'cd .kubic; (cd ..); echo x > config.toml',
    ],
  ])('still missed: %s', (_name, command) => {
    expect(triggers(command)).not.toContain(KUBIC_STATE_WRITE);
  });
});

describe('the cd trail is computed once per command', () => {
  it('8000 cd/redirect pairs classify in bounded time', () => {
    const command = 'cd a; echo > x; '.repeat(8_000);
    const started = performance.now();
    detectTriggers('bash', { command }, ctx());
    controlPlaneRefusal('bash', { command }, WS, { home: HOME });
    expect(performance.now() - started).toBeLessThan(1_500);
  });

  it('many targets after a single cd stay linear', () => {
    const command = `cd a; ${'echo > x; '.repeat(20_000)}`;
    const started = performance.now();
    detectTriggers('bash', { command }, ctx());
    expect(performance.now() - started).toBeLessThan(1_500);
  });
});
