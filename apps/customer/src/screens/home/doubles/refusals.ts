// TODO(B3): remove double. Stand-in for refusalCopy in apps/customer/src/data/refusals.ts (UI-SPEC §4.3 table).
import type { RefusalCopy } from '../../../data/types';

export function refusalCopy(code: string): RefusalCopy {
  if (code.startsWith('denied.screening'))
    return { title: 'Paused for account checks', body: 'This action is paused while account checks are set up.' };
  if (code.endsWith('.tier_required') || code.startsWith('kyc.'))
    return {
      title: 'Verify your identity first',
      body: 'You need a verified account to do this.',
      action: { label: 'Verify now', href: '/verification' },
    };
  return { title: "This can't be done right now", body: 'Try again later. If it keeps happening, contact support.' };
}
