// The setup group's commander surface (doctor, skills, models, setup,
// config, trust): every flag parses into the typed options the runner
// receives, and every usage error exits 2 on stderr without reaching a
// runner. Runners are fakes: the handlers' own behaviour is pinned in their
// host test files; this file pins argv → options and the exit-code mapping.

import { describe, expect, it } from 'vitest';
import { kubic, usageError } from '../test-support/command-harness.js';

describe('kubic doctor', () => {
  it('collects repeatable --skip values and --json', async () => {
    const result = await kubic([
      'doctor',
      '--skip',
      'node,license:kubic',
      '--skip=policy:approvals',
      '--json',
    ]);
    expect(result.calls).toEqual([
      {
        key: 'doctor',
        input: {
          skip: ['node,license:kubic', 'policy:approvals'],
          json: true,
        },
      },
    ]);
  });

  it('passes the doctor exit code through', async () => {
    expect((await kubic(['doctor'], 6)).code).toBe(6);
  });

  it('forwards --session to the doctor runner', async () => {
    const result = await kubic(['doctor', '--session', 'abc']);
    expect(result.calls).toEqual([
      { key: 'doctor', input: { skip: [], session: 'abc' } },
    ]);
  });

  it('refuses --skip without a value', async () => {
    expect(await usageError(['doctor', '--skip'])).toContain(
      'argument missing',
    );
  });
});

describe('kubic skills', () => {
  it('parses --role and --json', async () => {
    expect((await kubic(['skills'])).calls).toEqual([
      { key: 'skills', input: {} },
    ]);
    expect(
      (await kubic(['skills', '--role', 'reviewer', '--json'])).calls,
    ).toEqual([{ key: 'skills', input: { role: 'reviewer', json: true } }]);
  });

  it('passes the skills exit code through', async () => {
    expect((await kubic(['skills'], 6)).code).toBe(6);
  });

  it('refuses --role without a value', async () => {
    expect(await usageError(['skills', '--role'])).toContain(
      'argument missing',
    );
  });
});

describe('kubic models / config', () => {
  it('parses models --json and --resolve', async () => {
    expect((await kubic(['models', '--json'])).calls).toEqual([
      { key: 'models', input: { json: true } },
    ]);
    expect((await kubic(['models', '--resolve', 'faux/echo'])).calls).toEqual([
      { key: 'models', input: { resolve: 'faux/echo' } },
    ]);
    expect(await usageError(['models', '--resolve'])).toContain(
      'argument missing',
    );
  });

  it('parses config --json and refuses operands', async () => {
    expect((await kubic(['config'])).calls).toEqual([
      { key: 'config', input: {} },
    ]);
    expect((await kubic(['config', '--json'])).calls).toEqual([
      { key: 'config', input: { json: true } },
    ]);
    // The flag feeds the load dispatch already performed (the
    // runner input is the rendering options only).
    expect((await kubic(['config', '--model', 'faux/small'])).calls).toEqual([
      { key: 'config', input: {} },
    ]);
    expect(await usageError(['config', 'extra'])).toContain(
      'too many arguments',
    );
  });
});

describe('kubic trust', () => {
  // One grant covers the whole project tree; the help says what "yes" means —
  // not only the committed config.toml.
  it('its help names everything a grant covers: config.toml, models.json and skills', async () => {
    const help = (await kubic(['trust', '--help'])).out.join('\n');
    expect(help).toContain('.kubic/config.toml');
    expect(help).toContain('models.json');
    expect(help).toContain('*_API_KEY');
    expect(help).toContain('KUBIC_*');
    expect(help).toContain('project skills');
  });

  it('parses the grant form with no flags', async () => {
    expect((await kubic(['trust'])).calls).toEqual([
      { key: 'trust', input: {} },
    ]);
  });

  it('parses --revoke, --list and a path operand into the runner options', async () => {
    expect((await kubic(['trust', '--revoke'])).calls).toEqual([
      { key: 'trust', input: { revoke: true } },
    ]);
    expect((await kubic(['trust', '--list'])).calls).toEqual([
      { key: 'trust', input: { list: true } },
    ]);
    expect((await kubic(['trust', '/repos/app'])).calls).toEqual([
      { key: 'trust', input: { path: '/repos/app' } },
    ]);
    expect((await kubic(['trust', '/repos/app', '--revoke'])).calls).toEqual([
      { key: 'trust', input: { path: '/repos/app', revoke: true } },
    ]);
  });

  it('refuses a stray second operand', async () => {
    expect(await usageError(['trust', 'a', 'b'])).toContain(
      "error: too many arguments for 'trust'.",
    );
  });

  it('passes the runner exit code through', async () => {
    expect((await kubic(['trust'], 1)).code).toBe(1);
  });
});
