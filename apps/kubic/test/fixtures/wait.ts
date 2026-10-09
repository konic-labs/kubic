// Polls a condition the event loop will make true, and fails the test when
// it never does.
import { expect } from 'vitest';

export async function waitFor(condition: () => boolean): Promise<void> {
  for (let i = 0; i < 500 && !condition(); i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  expect(condition()).toBe(true);
}
