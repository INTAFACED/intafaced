import { isServiceNotConnected, type ApiResult } from './api';
import { classifyRefusal, type RefusalKind } from '../data/refusal-codes';

/**
 * The rules a failed read is shown by, shared by the old kit's `Failure` (shared/ui.tsx) and the Volt kit's
 * `ReadFailure` (shared/read-state.tsx), so the two never disagree on when Try again shows or which words a raw code reads.
 */
/** Refusals that come from something not being switched on, allowed or listed. A second attempt cannot change them. */
const SETTLED_KINDS: ReadonlySet<RefusalKind> = new Set([
  'spaceLocked',
  'screening',
  'region',
  'verify',
  'convertSpreadUnset',
  'slippageCapUnset',
  'protectionUnset',
  'priceBandUnset',
  'openOrdersCapUnset',
  'noBook',
  'marketNotOpen',
  'marketHalted',
  'stepUp',
  'mfaRequired',
  'noPermission',
  'orderTypeUnsupported',
  'marketLimitOnly',
  'marketCancelOnly',
  'marketPostOnly',
  'optionUnsupported',
  'accountOnHold',
  'tradingOnHold',
  'frozenByYou',
  'notFound',
  'notSetUp',
  'feeScheduleUnset',
  'algoSchedulerOff',
]);
/** Try again belongs to network trouble and to refusals that can clear by themselves, never to a missing setting or permission. */
export function canTryAgain(result: Extract<ApiResult<unknown>, { ok: false }>): boolean {
  if (result.reason === 'uncertain' || result.reason === 'unauthorized') return false;
  // The gateway says the service is not running in this environment: a second attempt cannot change that.
  if (isServiceNotConnected(result.code)) return false;
  if (result.reason === 'unreachable' || result.reason === 'invalid_response' || result.reason === 'aborted') return true;
  // A source that is unavailable, stale or unknown can recover by itself, whatever else its code says.
  if (result.code && /_(unavailable|stale|unknown)$/.test(result.code)) return true;
  if (result.reason === 'forbidden' || result.reason === 'not_mounted' || result.reason === 'not_supported') return false;
  return !SETTLED_KINDS.has(classifyRefusal(result.code));
}
/** A service sometimes answers with its own refusal code as the message ("token.params_invalid"). */
const RAW_CODE = /^[a-z][a-z0-9_]*(\.[a-z0-9_]+)+$/i;
/** A setting or code name inside a sentence, such as "Missing token_params.fee_discount_schedule". Only underscored names count, so "v1.2" and "e.g." stay. */
const EMBEDDED_KEY = /\b[a-z][a-z0-9]*(?:_[a-z0-9]+)*\.[a-z][a-z0-9]*(?:_[a-z0-9]+)*\b/gi;
function embeddedKey(message: string): string | undefined {
  return message.match(EMBEDDED_KEY)?.find((key) => key.includes('_'));
}
/** The refusal code a failure's message is, or names inside a sentence; undefined when it is plain words. */
export function failureRawCode(result: Extract<ApiResult<unknown>, { ok: false }>): string | undefined {
  return RAW_CODE.test(result.message.trim()) ? result.message.trim() : result.code ? embeddedKey(result.message) : undefined;
}
