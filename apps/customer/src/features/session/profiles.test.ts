import { describe, expect, it } from 'vitest';
import { businessProfiles, PERSONAL_PROFILE, resolveProfile } from './profiles';

// TEST data only: these businesses are not real.
const row = (id: string, name: string, status: 'active' | 'closed' = 'active') => ({
  id,
  name,
  assetId: 'USDT',
  spendThreshold: '0',
  status,
  createdAt: '2026-10-20T00:00:00.000Z',
});

describe('business profiles', () => {
  it('offers open accounts only, once each, in the order the bank gave', () => {
    const list = businessProfiles([
      row('b1', 'TEST Coffee'),
      row('b2', 'TEST Closed', 'closed'),
      row('b3', 'TEST Bakery'),
      row('b1', 'TEST Coffee'),
    ]);
    expect(list).toEqual([
      { id: 'business:b1', accountId: 'b1', name: 'TEST Coffee' },
      { id: 'business:b3', accountId: 'b3', name: 'TEST Bakery' },
    ]);
  });

  it('drops an account whose id does not fit the stored form', () => {
    expect(businessProfiles([row('has space', 'TEST A'), row('', 'TEST B'), row('x'.repeat(65), 'TEST C')])).toEqual([]);
  });
});

describe('the profile in view', () => {
  const list = businessProfiles([row('b1', 'TEST Coffee')]);

  it('is Personal when nothing else was chosen, with no notice', () => {
    expect(resolveProfile(PERSONAL_PROFILE, list)).toEqual({ active: 'personal', business: null, notice: null });
    expect(resolveProfile(PERSONAL_PROFILE, [])).toEqual({ active: 'personal', business: null, notice: null });
  });

  it('is the business when the person belongs to it', () => {
    expect(resolveProfile('business:b1', list)).toMatchObject({ active: 'business:b1', notice: null, business: { name: 'TEST Coffee' } });
  });

  it('falls back to Personal with a notice when the business is no longer one of theirs, or never was', () => {
    expect(resolveProfile('business:gone', list)).toEqual({ active: 'personal', business: null, notice: 'gone' });
    expect(resolveProfile('business:never-existed', [])).toEqual({ active: 'personal', business: null, notice: 'gone' });
  });

  it('shows Personal without a notice while the list is loading or could not be read, because nothing proved the choice wrong', () => {
    expect(resolveProfile('business:b1', null)).toEqual({ active: 'personal', business: null, notice: null });
  });

  it('never makes a business of a stored value that is not a business id', () => {
    expect(resolveProfile('team:b1', list)).toEqual({ active: 'personal', business: null, notice: null });
  });
});
