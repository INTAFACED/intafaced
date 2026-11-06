/**
 * The owner's reminder terms for requests between people (PP-send-request-13, J-pay-05 #4): at most `cap` reminders of one
 * request in any `windowSeconds`. A reminder over the cap refuses `bank.personal_request_remind_capped` and names when the
 * next one is allowed. Unset means no reminder terms are published, and every reminder refuses
 * `bank.personal_request_remind_terms_unset`; nothing is defaulted.
 */
export interface RequestReminderTerms {
  /** The rolling window, in whole seconds (60 to 30 days). */
  readonly windowSeconds: number;
  /** Reminders of one request allowed in any window (1 to 20). */
  readonly cap: number;
}

const WINDOW_MAX = 30 * 86_400;
const CAP_MAX = 20;

const whole = (raw: string | undefined): number | null => {
  if (raw === undefined || raw.trim() === '') return null;
  if (!/^\d+$/.test(raw.trim())) return Number.NaN;
  return Number(raw.trim());
};

/**
 * `BANK_REQUEST_REMIND_WINDOW_SECONDS` and `BANK_REQUEST_REMIND_CAP`, read together: both blank is "no terms" (null); one
 * set without the other, or either out of range, throws, so a half-written rule never runs.
 */
export function readRequestReminderTerms(windowRaw: string | undefined, capRaw: string | undefined): RequestReminderTerms | null {
  const windowSeconds = whole(windowRaw);
  const cap = whole(capRaw);
  if (windowSeconds === null && cap === null) return null;
  if (windowSeconds === null || cap === null)
    throw new Error('BANK_REQUEST_REMIND_WINDOW_SECONDS and BANK_REQUEST_REMIND_CAP are set together, or both left blank');
  if (!Number.isSafeInteger(windowSeconds) || windowSeconds < 60 || windowSeconds > WINDOW_MAX)
    throw new Error(`BANK_REQUEST_REMIND_WINDOW_SECONDS must be whole seconds from 60 to ${WINDOW_MAX}`);
  if (!Number.isSafeInteger(cap) || cap < 1 || cap > CAP_MAX)
    throw new Error(`BANK_REQUEST_REMIND_CAP must be a whole number from 1 to ${CAP_MAX}`);
  return { windowSeconds, cap };
}
