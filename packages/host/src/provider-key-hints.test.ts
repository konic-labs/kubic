// What a keyless provider needs: the variable Pi's own auth
// check reads, so the model picker can say `set OPENAI_API_KEY`.
import { describe, expect, it } from 'vitest';
import { providerKeyHints } from './provider-key-hints.js';

describe('provider key hints', () => {
  it('names the variable Pi reads, an *_API_KEY first', async () => {
    const hints = await providerKeyHints([
      'openai',
      'anthropic',
      'google',
      'huggingface',
      'no-such-provider',
    ]);
    expect(hints.get('openai')).toBe('OPENAI_API_KEY');
    // Anthropic also takes ANTHROPIC_AUTH_TOKEN; the API key is the one
    // to suggest.
    expect(hints.get('anthropic')).toBe('ANTHROPIC_API_KEY');
    expect(hints.get('google')).toBe('GEMINI_API_KEY');
    // No *_API_KEY: whatever variable the check names.
    expect(hints.get('huggingface')).toBe('HF_TOKEN');
    expect(hints.has('no-such-provider')).toBe(false);
  });
});
