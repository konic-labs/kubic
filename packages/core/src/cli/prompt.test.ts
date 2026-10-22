// The one-key prompt (the trust question): the key is the
// answer; never off a TTY; null on Ctrl-C / Esc; raw mode restored.
import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import { promptKey } from './prompt.js';

function fakeIo() {
  const input = new EventEmitter() as EventEmitter & {
    isRaw: boolean;
    setRawMode: (mode: boolean) => void;
    resume: () => void;
    pause: () => void;
  };
  input.isRaw = false;
  input.setRawMode = (mode) => {
    input.isRaw = mode;
  };
  input.resume = () => {};
  input.pause = () => {};
  const written: string[] = [];
  return {
    io: { input, write: (text: string) => written.push(text) },
    feed: (data: string) => input.emit('data', Buffer.from(data)),
    input,
    written,
  };
}

const CHOICES = [
  { key: 'y', label: 'yes', value: 'yes' },
  { key: 'n', label: 'not now', value: 'not-now' },
  { key: 'v', label: 'view file', value: 'view' },
] as const;

describe('promptKey', () => {
  it('answers with the first chosen key, case-insensitive', async () => {
    const { io, feed, input, written } = fakeIo();
    const pending = promptKey({
      message: 'load project config?',
      interactive: true,
      nonInteractive: 'not-now',
      choices: CHOICES,
      io,
    });
    expect(input.isRaw).toBe(true);
    feed('x');
    feed('V');
    expect(await pending).toBe('view');
    expect(input.isRaw).toBe(false);
    expect(written.join('')).toContain('load project config?');
  });

  it('cancels on Ctrl-C and Esc', async () => {
    for (const key of ['\u0003', '\u001b']) {
      const { io, feed } = fakeIo();
      const pending = promptKey({
        message: 'q',
        interactive: true,
        nonInteractive: 'not-now',
        choices: CHOICES,
        io,
      });
      feed(key);
      expect(await pending).toBeNull();
    }
  });

  it('never prompts off a TTY', async () => {
    expect(
      await promptKey({
        message: 'q',
        interactive: false,
        nonInteractive: 'not-now',
        choices: CHOICES,
      }),
    ).toBe('not-now');
  });
});
