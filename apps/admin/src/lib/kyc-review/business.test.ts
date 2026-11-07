import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { BUSINESS_SEES, readKybCurrent } from './business';

const customerCopy = readFileSync(
  fileURLToPath(new URL('../../../../customer/src/features/pay/portal/settings/copy.ts', import.meta.url)),
  'utf8',
);

describe('a business application on the identity desk', () => {
  it('shows each status in the exact words the business reads', () => {
    const line = (key: string) => customerCopy.match(new RegExp(`\\b${key}: '([^']*)'`))?.[1];
    expect(BUSINESS_SEES.none).toBe(line('kybNoneNote'));
    expect(BUSINESS_SEES.pending).toBe(line('kybPendingNote'));
    expect(BUSINESS_SEES.approved).toBe(line('kybApprovedNote'));
    expect(BUSINESS_SEES.rejected).toBe(line('kybRejectedNote'));
  });

  it('reads only a known status from svc-pay', () => {
    expect(readKybCurrent({ kybStatus: 'pending', kybRef: 'TEST-1', mode: 'gateway' })).toEqual({
      kybStatus: 'pending',
      kybRef: 'TEST-1',
      mode: 'gateway',
    });
    expect(readKybCurrent({ kybStatus: 'in_review', kybRef: null, mode: 'gateway' })).toBeNull();
    expect(readKybCurrent(null)).toBeNull();
  });
});
