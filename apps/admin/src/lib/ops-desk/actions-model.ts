import type { VendorDecision } from '@/lib/desk/approval-packet';
import { cellOfRow } from './model';
import type { Row } from './types';

/**
 * Which decisions are offered on a row, from the status the service just returned. Pure, so each case is a test.
 *
 * This only decides which buttons to offer; svc-market and svc-academy decide what is allowed. An offered decision can
 * still be refused there, and the desk shows that refusal in words.
 */

export function vendorDecisions(status: string): readonly VendorDecision[] {
  switch (status) {
    case 'applied':
      return ['approved', 'rejected'];
    case 'approved':
      return ['suspended'];
    case 'suspended':
      return ['approved'];
    default:
      return [];
  }
}

export type AmbassadorVerb = 'freeze' | 'unfreeze';

export function ambassadorVerb(status: string): AmbassadorVerb | null {
  return status === 'active' ? 'freeze' : status === 'frozen' ? 'unfreeze' : null;
}

export function rowText(row: Row, key: string): string | null {
  const v = cellOfRow(row, key);
  return typeof v === 'string' ? v : null;
}
