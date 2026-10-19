// The writer table: each command that writes a file raises outside-write for
// an outside path and nothing for an inside one, a trailing redirect or
// comment cannot move a destination, and the control-plane guard reads the
// same table. The trigger context is the PRODUCTION one (triggerContextFor),
// so a green run proves what `kubic run` classifies.

import { DEFAULT_PERMISSIONS } from '@kubic/agent/permissions';
import { describe, expect, it } from 'vitest';
import { KUBIC_STATE_WRITE } from './policy.js';
import { detectTriggers, triggerContextFor } from './triggers.js';

const ctx = triggerContextFor(DEFAULT_PERMISSIONS, '/work', '/home/u');

function raised(command: string): string[] {
  return detectTriggers('bash', { command }, ctx);
}

describe('outside-write by the writer table', () => {
  it.each([
    'touch /etc/pwn',
    'mkdir -p /etc/pwn.d',
    'chmod 777 /etc/shadow',
    'chmod -x /etc/x',
    'chmod --reference=a /etc/x',
    'chown root /etc/shadow',
    'chgrp wheel /etc/x',
    'truncate -s 0 /etc/x',
    'dd if=/dev/zero of=/etc/passwd',
    'sed -i s/a/b/ /etc/x',
    'sed -i.bak -e s/a/b/ /etc/x',
    "sed -i '' 's/a/b/' /etc/x",
    "perl -pi -e 's/a/b/' /etc/x",
    'sort -o /etc/x in.txt',
    'sort --output=/etc/x in.txt',
    'rsync -a src/ /etc/dst/',
    'tar -xf a.tar -C /etc',
    'tar xzf a.tgz -C /etc',
    'tar --extract --file a.tar --directory=/etc',
    'tar -czf /etc/x.tgz src',
    'tar cf /etc/x.tar src',
    'unzip x.zip -d /etc',
    'ln -s /etc/passwd ./link',
    'ln a /etc/x',
    'git clone http://e /etc/repo',
    'git -C /tmp clone http://e',
    'git init /etc/repo',
    'git worktree add ../elsewhere',
    'curl -o /etc/x http://e',
    'curl -sSLo /etc/x http://e',
    'curl --output-dir /etc -O http://e',
    'wget -O /etc/x http://e',
    'wget -P /etc http://e',
    'install -d /etc/x',
    'install -D a /etc/x/y',
    'tee a.txt /etc/x',
    'cp -t /etc a b',
    'cp --target-directory=/etc a',
    'mv /etc/x ./x',
    'find /etc -name x -exec chmod 644 {} +',
    'find . -exec cp {} /etc/ \\;',
    'find . -fprint /etc/x',
    'sudo -u root touch /etc/x',
    'env A=1 sed -i s/a/b/ /etc/x',
    'xargs -I {} cp {} /etc/',
    'echo $(touch /etc/x)',
    'if true; then touch /etc/x; fi',
  ])('%s raises outside-write', (command) => {
    expect(raised(command)).toContain('outside-write');
  });

  it.each([
    'touch a',
    'mkdir -p build',
    'chmod +x a',
    'chmod 644 a b',
    'chown u a',
    'truncate -s 0 x',
    'dd if=a of=b',
    'dd if=a of=/dev/null',
    'sed -n 1p /etc/passwd',
    'sed s/a/b/ /etc/x',
    'sed -i s/a/b/ x',
    'perl -ne print /etc/x',
    'sort -o out in',
    'sort /etc/hosts',
    'rsync -a a/ b/',
    'rsync -a a/ host:/etc/',
    'tar -xf a.tar -C sub',
    'tar -czf out.tgz -C /etc .',
    'tar -tf /etc/x.tar',
    'unzip x.zip -d sub',
    'ln -s a b',
    'git clone http://e sub',
    'git status',
    'git -C sub log',
    'curl -o out http://e',
    'curl http://e',
    'wget -O out http://e',
    'install -d build',
    'tee log.txt',
    'cp -t sub a b',
    'mv a b',
    'find /etc -name x',
    'find /etc -exec cat {} \\;',
    'grep -rn mkdir /etc',
    'which touch',
    'man chmod',
    'echo touch /etc/x is a command',
  ])('%s raises no outside-write', (command) => {
    expect(raised(command)).not.toContain('outside-write');
  });
});

describe('a trailing redirect or comment cannot move a destination', () => {
  it.each([
    'cp a /etc/x 2>/dev/null',
    'cp a /etc/x >/dev/null',
    'cp a /etc/x > /dev/null',
    'cp a /etc/x &>/dev/null',
    'cp a /etc/x # note',
    'mv a /etc/x 2>&1',
    'install -m 644 a /etc/x 2>/dev/null',
    'tee /etc/x >/dev/null',
    "cp a '/etc/#x'",
  ])('%s raises outside-write', (command) => {
    expect(raised(command)).toContain('outside-write');
  });

  it.each([
    'cp a b 2>/dev/null',
    'cp a b # to /etc/x',
    'cp a "b#c"',
    'mv a b >/dev/null',
  ])('%s raises nothing', (command) => {
    expect(raised(command)).toEqual([]);
  });
});

describe('the control-plane guard reads the same table', () => {
  it.each([
    'touch .kubic/config.toml',
    'mkdir .kubic/roles',
    'chmod 600 .kubic/config.toml',
    'chown u .kubic/config.toml',
    'truncate -s 0 .kubic/config.toml',
    'dd if=a of=.kubic/config.toml',
    'sed -i s/a/b/ .kubic/config.toml',
    "perl -pi -e 's/a/b/' .kubic/roles/r.md",
    'sort -o .kubic/config.toml a',
    'rsync -a x/ .kubic/roles/',
    'tar -xf a.tar -C .kubic',
    'unzip a.zip -d .kubic/roles',
    'ln -s ../x .kubic/roles/r.md',
    'git clone http://e .kubic/roles',
    'curl -o .kubic/config.toml http://e',
    'wget -O .kubic/config.toml http://e',
    'install -d .kubic/roles',
    'tee a.txt .kubic/config.toml',
    'cp -t .kubic/roles a',
    'find .kubic -name x -exec chmod 600 {} +',
    'cp a .kubic/config.toml 2>/dev/null',
  ])('%s raises kubic-state-write', (command) => {
    expect(raised(command)).toContain(KUBIC_STATE_WRITE);
  });
});

describe('the writer table stays linear', () => {
  it.each([
    'touch a; ',
    'cp a b ',
    'find . -exec find ',
    'sudo ',
    'tar xf a ',
    '"a ',
    "'",
    'x=$(',
  ])('%j repeated 20000 times classifies in well under a second', (unit) => {
    const started = performance.now();
    raised(unit.repeat(20_000));
    expect(performance.now() - started).toBeLessThan(1_500);
  });
});
