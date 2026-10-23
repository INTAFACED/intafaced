/**
 * SP-kb-03. Help-article feedback and search ranking.
 * No money, no ledger, no reader identifier on a search log.
 */

/** Blank owner rate (count or window). A public vote writes nothing. */
export const SUPPORT_FEEDBACK_RATE_LIMIT_UNSET = 'support.feedback_rate_limit_unset' as const;
/** A public reader is past the owner rate. The vote is not stored. */
export const SUPPORT_FEEDBACK_RATE_EXCEEDED = 'support.feedback_rate_exceeded' as const;
/** A request from a vote needs an unhelpful vote and a comment. Nothing is stored. */
export const SUPPORT_FEEDBACK_REQUEST_INVALID = 'support.feedback_request_invalid' as const;
/** Query longer than the owner maximum, when one is set. */
export const SUPPORT_SEARCH_QUERY_TOO_LONG = 'support.search_query_too_long' as const;
/** The answer panel's model setting is blank. No answer is built. */
export const SUPPORT_ASSISTANT_MODEL_UNSET = 'support.assistant_model_unset' as const;
/** Comment bound. A longer comment is refused and nothing is stored. */
export const FEEDBACK_COMMENT_MAX = 2_000;
/**
 * Same bound as `searchKbInputSchema` (`q` max 200). Not an owner default:
 * a tighter owner maximum is `SUPPORT_SEARCH_QUERY_MAX`, and a blank one
 * leaves this contract bound in place.
 */
export const SEARCH_QUERY_CONTRACT_MAX = 200;

/** Prefix so a browser reader token can never equal an account id. */
export const READER_ACTOR_PREFIX = 'reader:';

export function readerActorId(token: string): string {
  return `${READER_ACTOR_PREFIX}${token}`;
}

/** The first message of a request opened from an unhelpful vote. It names the article. */
export function feedbackRequestCopy(articleId: string, version: number, comment: string): { subject: string; body: string } {
  return {
    subject: `Article ${articleId}`.slice(0, 200),
    body: `This request is about help article ${articleId} (version ${version}).\n${comment.trim()}`,
  };
}

/** Votes strictly older than this instant are outside the window. */
export function feedbackRateCutoff(nowIso: string, windowSeconds: number): string {
  return new Date(Date.parse(nowIso) - windowSeconds * 1000).toISOString();
}
