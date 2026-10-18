import { describe, expect, it } from 'vitest';
import { registeredCopy } from '../../../shared/i18n';
// Importing the module registers its catalog.
import './copy';

const english = () => registeredCopy().find((entry) => entry.namespace === 'trade.desk')?.messages.en ?? {};

describe('desk copy', () => {
  it('an order the lookup cannot find is not worded as "not placed": it may still arrive', () => {
    const text = english()['Still checking'];
    expect(text).toContain('We haven’t found it.');
    expect(text).toContain('may still arrive');
  });
});
