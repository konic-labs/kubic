import {
  createModels,
  InMemoryCredentialStore,
} from '@kubic/agent/pi-boundary';
import { describe, expect, it } from 'vitest';
import {
  FAUX_MODEL_ID,
  FAUX_PROVIDER_ID,
  fauxProviderActive,
  fauxReplyFor,
  invalidProviderMessage,
  providerOverrideFromEnv,
  registerFauxProvider,
} from './faux-provider.js';

type Messages = Parameters<typeof fauxReplyFor>[0];

function user(text: string): Messages[number] {
  return { role: 'user', content: text, timestamp: 0 } as Messages[number];
}

describe('KUBIC_PROVIDER override', () => {
  it('is off unless the env names it (never implicit)', () => {
    expect(providerOverrideFromEnv({})).toEqual({ kind: 'none' });
    expect(providerOverrideFromEnv({ KUBIC_PROVIDER: '' })).toEqual({
      kind: 'none',
    });
    expect(fauxProviderActive({})).toBe(false);
  });

  it('selects the faux provider only for the exact value faux', () => {
    expect(fauxProviderActive({ KUBIC_PROVIDER: 'faux' })).toBe(true);
    expect(providerOverrideFromEnv({ KUBIC_PROVIDER: 'FAUX' })).toEqual({
      kind: 'invalid',
      value: 'FAUX',
    });
    expect(invalidProviderMessage('x')).toContain("only override is 'faux'");
  });
});

describe('faux scripted replies', () => {
  it('echoes the last user prompt', () => {
    const reply = fauxReplyFor([user('hello there')]);
    expect(reply.content).toEqual([
      { type: 'text', text: 'faux echo: hello there' },
    ]);
  });

  it('turns a faux:tool directive into one tool call', () => {
    const reply = fauxReplyFor([user('list it\nfaux:tool ls {"path":"."}')]);
    expect(reply.stopReason).toBe('toolUse');
    expect(reply.content[0]).toMatchObject({
      type: 'toolCall',
      name: 'ls',
      arguments: { path: '.' },
    });
  });

  it('accepts a directive without arguments', () => {
    const reply = fauxReplyFor([user('faux:tool ls')]);
    expect(reply.content[0]).toMatchObject({ name: 'ls', arguments: {} });
  });

  it('reports malformed directive arguments as text instead of calling', () => {
    const notJson = fauxReplyFor([user('faux:tool ls {nope')]);
    expect(notJson.content[0]).toMatchObject({ type: 'text' });
    expect(JSON.stringify(notJson.content)).toContain('not JSON');
    const notObject = fauxReplyFor([user('faux:tool ls [1]')]);
    expect(JSON.stringify(notObject.content)).toContain('JSON object');
  });

  it('ends the turn with a text reply after a tool result', () => {
    const reply = fauxReplyFor([
      user('faux:tool ls {}'),
      {
        role: 'toolResult',
        toolCallId: 't1',
        toolName: 'ls',
        content: [{ type: 'text', text: 'a\nb' }],
        isError: false,
        timestamp: 0,
      } as Messages[number],
    ]);
    expect(reply.content).toEqual([
      { type: 'text', text: 'faux: ls returned 3 chars' },
    ]);
  });

  it('names a failed tool result', () => {
    const reply = fauxReplyFor([
      {
        role: 'toolResult',
        toolCallId: 't1',
        toolName: 'bash',
        content: [],
        isError: true,
        timestamp: 0,
      } as Messages[number],
    ]);
    expect(JSON.stringify(reply.content)).toContain('bash failed 0 chars');
  });
});

describe('registerFauxProvider', () => {
  it('registers faux/echo on the models instance', () => {
    const models = createModels({ credentials: new InMemoryCredentialStore() });
    registerFauxProvider(models);
    expect(models.getModel(FAUX_PROVIDER_ID, FAUX_MODEL_ID)?.id).toBe(
      FAUX_MODEL_ID,
    );
  });
});
