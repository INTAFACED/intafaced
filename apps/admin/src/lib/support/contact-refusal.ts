import type { FounderCallFailure } from '@/lib/desk/founder-call';
import { explainRefusal, type RefusalView } from '@/lib/desk/refusal-copy';
import { explainSupportFailure, supportCodeOf } from './refusal';

const BY_CODE: Readonly<Record<string, Omit<RefusalView, 'code' | 'changed'>>> = {
  'support.contact_revision_stale': {
    title: 'Someone changed the contact details first',
    body: 'The details were changed after you opened this page, so svc-support refused to overwrite them.',
    next: 'Nothing was changed. Reload the details, check them and try again.',
  },
  'support.contact_setting_invalid': {
    title: 'svc-support did not accept that value',
    body: 'The email must be one plain address, the phone a number to dial, and the chat hours plain words without markup.',
    next: 'Fix the value and try again. Nothing was changed.',
  },
};

/** A refusal on the contact settings: its own codes first, then the support desk's (not a lead, not staff), then the general answers. */
export function explainContactFailure(result: FounderCallFailure<unknown>): RefusalView {
  if (result.kind === 'refused') {
    const named = supportCodeOf(result.refusal.message, result.refusal.code);
    const known = named ? BY_CODE[named] : undefined;
    if (known) return { ...known, code: named, changed: 'no' };
    // The input check names the code inside a JSON list of issues, so look for it anywhere in the message.
    if (result.refusal.status === 400 && result.refusal.message.includes('support.contact_setting_invalid')) {
      return { ...BY_CODE['support.contact_setting_invalid']!, code: 'support.contact_setting_invalid', changed: 'no' };
    }
    if (result.refusal.status === 409)
      return { ...BY_CODE['support.contact_revision_stale']!, code: 'support.contact_revision_stale', changed: 'no' };
    return explainRefusal(named ?? result.refusal.code, result.refusal.status, false);
  }
  return explainSupportFailure(result);
}
