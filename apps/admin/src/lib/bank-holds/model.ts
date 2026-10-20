/**
 * Pure model of the global-send holds desk (BK-xfer-07). Requests in the shape the service takes, words for each typed
 * refusal, and nothing that counts, sums or fills in a figure: every number on the page is the service's own.
 */

export const HOLD_STATE_LABEL: Readonly<Record<'requested' | 'under_review' | 'released', string>> = {
  requested: 'Waiting for the customer',
  under_review: 'Under review',
  released: 'Released',
};

export const REFUSAL_WORDS: Readonly<Record<string, string>> = {
  'bank.transfer_settled': 'This send has already been paid out or debited, so it can no longer be held. Nothing was changed.',
  'bank.transfer_not_holdable': 'This send has already failed, so there is nothing to hold.',
  'bank.hold_not_found': 'This send has no open hold.',
  'bank.hold_conflict': 'This send already has a hold, or this key was used for a different hold. Read the queue again.',
  'bank.release_same_operator': 'A hold must be released by someone other than the person who placed it. Ask a second operator.',
  'bank.link_reference_conflict': 'That reference is already linked to a different send.',
  'bank.proof_limits_unset': 'The owner has not published file type and size limits, so no file can be taken or read.',
  'bank.proof_not_requested': 'No file was asked for on this hold.',
  'bank.global_outcome_unknown':
    'The payout step gave no clear answer after the release. The send is still open; read the queue before trying again.',
  'bank.personal_pay_request_invalid': 'That request was not accepted. Nothing was sent.',
};

export const refusalWords = (code: string | null): string | null =>
  code !== null && Object.hasOwn(REFUSAL_WORDS, code) ? REFUSAL_WORDS[code]! : null;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const KEY = /^[A-Za-z0-9_-]{8,128}$/;

export type HoldAction =
  | { action: 'hold'; sendId: string; holdKey: string; reason: string; infoRequest?: string }
  | { action: 'requestInfo'; sendId: string; infoRequest: string }
  | { action: 'release'; sendId: string }
  | { action: 'linkReference'; sendId: string; reference: string };

const text = (v: unknown, min: number, max: number): string | null => {
  if (typeof v !== 'string') return null;
  const s = v.trim();
  return s.length >= min && s.length <= max ? s : null;
};

/** Strict reader of what the browser posts; anything off-shape is null and nothing is sent to the service. */
export function readHoldAction(raw: unknown): HoldAction | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  const sendId = typeof r.sendId === 'string' && UUID.test(r.sendId) ? r.sendId : null;
  if (!sendId) return null;
  const keys = Object.keys(r).sort().join(',');
  switch (r.action) {
    case 'hold': {
      const reason = text(r.reason, 1, 500);
      const holdKey = typeof r.holdKey === 'string' && KEY.test(r.holdKey) ? r.holdKey : null;
      if (!reason || !holdKey) return null;
      if (r.infoRequest === undefined) return keys === 'action,holdKey,reason,sendId' ? { action: 'hold', sendId, holdKey, reason } : null;
      const infoRequest = text(r.infoRequest, 1, 1000);
      return infoRequest && keys === 'action,holdKey,infoRequest,reason,sendId'
        ? { action: 'hold', sendId, holdKey, reason, infoRequest }
        : null;
    }
    case 'requestInfo': {
      const infoRequest = text(r.infoRequest, 1, 1000);
      return infoRequest && keys === 'action,infoRequest,sendId' ? { action: 'requestInfo', sendId, infoRequest } : null;
    }
    case 'release':
      return keys === 'action,sendId' ? { action: 'release', sendId } : null;
    case 'linkReference': {
      const reference = text(r.reference, 6, 64);
      return reference && keys === 'action,reference,sendId' ? { action: 'linkReference', sendId, reference } : null;
    }
    default:
      return null;
  }
}

export const isSendId = (v: string | null): v is string => v !== null && UUID.test(v);

/** A fresh key for one hold form; the form keeps it until the hold is stored, so a lost reply is safe to repeat. */
export const newHoldKey = (random: () => string = () => crypto.randomUUID()): string => `console-hold-${random()}`;
