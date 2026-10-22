import { describe, expect, it } from 'vitest';
import { userCopy } from './user-copy.js';

/** academy.slug_reserved reaches the caller as catalogue copy, never the raw error message with the slug echoed back. */
describe('academy.slug_reserved copy', () => {
  it('resolves to the catalogue sentence', () => {
    const copy = userCopy('academy.slug_reserved');
    expect(copy).toBe('That name is reserved for an academy tab. Choose another one.');
    expect(copy).not.toMatch(/slug "/);
    expect(copy).not.toBe('academy.slug_reserved');
  });
});
