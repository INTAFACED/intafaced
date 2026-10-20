import type { FounderCallFailure } from '@/lib/desk/founder-call';
import { explainRefusal, type RefusalView } from '@/lib/desk/refusal-copy';
import { explainSupportFailure, supportCodeOf } from './refusal';

const BY_CODE: Readonly<Record<string, Omit<RefusalView, 'code' | 'changed'>>> = {
  'support.attachment_revision_stale': {
    title: 'Someone changed the file limits first',
    body: 'The limits were changed after you opened this page, so svc-support refused to overwrite them.',
    next: 'Nothing was changed. Reload the limits, check them and try again.',
  },
  'support.attachment_settings_invalid': {
    title: 'svc-support did not accept that value',
    body: 'A size and a count are whole numbers from 1, and the file types are plain media types such as image/png, each once, with no wildcard.',
    next: 'Fix the value and try again. Nothing was changed.',
  },
  'support.attachment_scan_unknown': {
    title: 'The scan has not finished',
    body: 'This file is still being scanned, so svc-support will not serve it yet.',
    next: 'Nothing was changed. Try again later.',
  },
  'support.attachment_scan_refused': {
    title: 'The scan refused this file',
    body: 'svc-support blocked this file, so it is never served.',
    next: 'Nothing was changed. The customer can send a different file.',
  },
};

/** A refusal on the file limits: its own codes first, then the support desk's (not a lead, not staff), then the general answers. */
export function explainAttachmentFailure(result: FounderCallFailure<unknown>): RefusalView {
  if (result.kind === 'refused') {
    const named = supportCodeOf(result.refusal.message, result.refusal.code);
    const known = named ? BY_CODE[named] : undefined;
    if (known) return { ...known, code: named, changed: 'no' };
    // The input check names the code inside a JSON list of issues, so look for it anywhere in the message.
    if (result.refusal.status === 400 && result.refusal.message.includes('support.attachment_settings_invalid')) {
      return { ...BY_CODE['support.attachment_settings_invalid']!, code: 'support.attachment_settings_invalid', changed: 'no' };
    }
    if (result.refusal.status === 409)
      return { ...BY_CODE['support.attachment_revision_stale']!, code: 'support.attachment_revision_stale', changed: 'no' };
    return explainRefusal(named ?? result.refusal.code, result.refusal.status, false);
  }
  return explainSupportFailure(result);
}

/** A refusal on a file download. A file the operator may not open reads as not found: svc-support does not say which. */
export function explainDownloadFailure(result: FounderCallFailure<unknown>): RefusalView {
  if (result.kind === 'refused' && result.refusal.status === 404) {
    return {
      title: 'No such file for you',
      body: 'svc-support has no such file, or it is on a ticket that is not assigned to you.',
      next: 'Claim the ticket first, then try again. Nothing was changed.',
      code: 'support.not_found',
      changed: 'no',
    };
  }
  return explainAttachmentFailure(result);
}
