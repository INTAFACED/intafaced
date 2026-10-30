import type { ApiResult } from '../../shared/api';
import { presentActionFailure } from './common';
import { deskCopy } from './support-desk-copy';

/**
 * Plain-English answers for the refusals the support service gives to a signed-in person. The service names a refusal with
 * a dotted code (`support.already_rated`) and an HTTP class; this turns the ones it can send for close, rate, attach, reply and
 * help-article feedback into a sentence a person can act on. A code this file does not know still gets a plain sentence,
 * never the dotted code. A refusal that is not from the support service, or an outcome the app could not confirm, is left
 * exactly as it came, so "we do not know if it went through" is never rewritten as "it failed".
 */
export type RefusalKey = Extract<Parameters<typeof deskCopy.t>[0], `refuse${string}`>;

const BY_CODE: Readonly<Record<string, RefusalKey>> = {
  'support.not_found': 'refuseNotFound',
  'support.transition_same_status': 'refuseAlreadyClosed',
  'support.transition_illegal': 'refuseCannotClose',
  'support.settle.refused': 'refuseTeamHandling',
  'support.already_rated': 'refuseAlreadyRated',
  'support.rate_status_refused': 'refuseRateNotYet',
  'support.rate_score_out_of_range': 'refuseRateScore',
  'support.rate_note_too_long': 'refuseRateNote',
  'support.attachments_unconfigured': 'refuseAttachOff',
  'support.attachment_count_unset': 'refuseAttachOff',
  'support.attachment_count_reached': 'refuseAttachCount',
  'support.attachment_scan_unknown': 'refuseAttachHeld',
  'support.attachment_scan_refused': 'refuseAttachScan',
  'support.attachment_too_large': 'refuseAttachLarge',
  'support.attachment_type_refused': 'refuseAttachType',
  'support.attachment_body_invalid': 'refuseAttachUnreadable',
  'support.headers_not_allowed': 'refuseHeadersNotAllowed',
  'support.follow_up_invalid': 'refuseFollowUp',
  'support.kb.not_published': 'refuseArticleGone',
  'support.kb_version_unknown': 'refuseArticleGone',
  'support.comment_cap_unset': 'refuseCommentsOff',
  'support.comment_cap_reached': 'refuseCommentCap',
  'support.comment_secret_refused': 'refuseCommentSecret',
  'support.feedback_rate_exceeded': 'refuseFeedbackRate',
  'support.feedback_rate_limit_unset': 'refuseFeedbackOff',
  'support.feedback_request_invalid': 'refuseFeedbackRequest',
  'support.feedback_comment_too_long': 'refuseFeedbackLong',
};
const SUPPORT_CODE = /\bsupport(?:\.[a-z0-9_]+)+/;

type Failure = Extract<ApiResult<unknown>, { ok: false }>;

/** Which sentence answers this refusal, or null when it should be shown as it came. */
export function supportRefusalKey(
  failure: Pick<Failure, 'reason' | 'message' | 'code' | 'status'>,
  /** Codes whose sentence depends on which action refused, for this action only. */
  forAction: Readonly<Record<string, RefusalKey>> = {},
): RefusalKey | null {
  // Never rewrite "we could not confirm" or "you changed account / left the page".
  if (failure.reason === 'uncertain' || failure.reason === 'aborted' || failure.reason === 'unreachable') return null;
  if (failure.reason === 'unauthorized') return 'refuseSignedOut';
  if (failure.reason === 'forbidden') return 'refuseForbidden';
  const named = SUPPORT_CODE.exec(failure.message)?.[0] ?? (failure.code && SUPPORT_CODE.test(failure.code) ? failure.code : null);
  if (named) return forAction[named] ?? BY_CODE[named] ?? 'refuseGeneric';
  // The gateway refuses an oversized body before the service sees it.
  if (failure.status === 413) return 'refuseAttachLarge';
  if (failure.code === 'NOT_FOUND') return 'refuseNotFound';
  if (failure.code === 'CONFLICT') return 'refuseConflict';
  return null;
}

/** Wrap a mutation result so a refusal reads in plain words (in the person's language when a translation exists). */
export function plainSupportResult<T>(result: ApiResult<T>, forAction?: Readonly<Record<string, RefusalKey>>): ApiResult<T> {
  if (result.ok) return result;
  const key = supportRefusalKey(result, forAction);
  if (!key) return result;
  return presentActionFailure({ ...result, message: deskCopy.t(key) }, (locale) => {
    const current = deskCopy.forLocale(locale);
    return { message: current.t(key), language: current.languageFor(key) };
  });
}
