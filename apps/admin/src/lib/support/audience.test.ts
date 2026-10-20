import { SUPPORT_KB_AUDIENCES } from '@intafaced/contracts';
import { describe, expect, it } from 'vitest';
import { KB_AUDIENCES } from './audience';

describe('the audience list', () => {
  it('is the contract’s list, in the same order', () => {
    expect([...KB_AUDIENCES]).toEqual([...SUPPORT_KB_AUDIENCES]);
  });
});
