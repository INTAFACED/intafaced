/**
 * The owner's reminder policy for requests between people (PP-send-request-13, ENGINE-SPEC PR-4, J-pay-05 #4): reminders of
 * one request are spaced at least `spacingSeconds` apart and capped at `cap` per request. A reminder too soon refuses
 * `bank.personal_request_remind_too_soon` and names when the next one is allowed; one over the cap refuses
 * `bank.personal_request_remind_capped`. Unset means no policy is published, and every reminder refuses
 * `bank.reminder_policy_unset`; nothing is defaulted.
 */
export interface RequestReminderPolicy {
  /** The least time between two reminders of one request, in whole seconds (60 to 30 days). */
  readonly spacingSeconds: number;
  /** Reminders allowed for one request, in all (1 to 20). */
  readonly cap: number;
}

const SPACING_MAX = 30 * 86_400;
const CAP_MAX = 20;

const whole = (raw: string | undefined): number | null => {
  if (raw === undefined || raw.trim() === '') return null;
  if (!/^\d+$/.test(raw.trim())) return Number.NaN;
  return Number(raw.trim());
};

/**
 * `BANK_REQUEST_REMIND_SPACING_SECONDS` and `BANK_REQUEST_REMIND_CAP`, read together: both blank is "no policy" (null); one
 * set without the other, or either out of range, throws, so a half-written policy never runs.
 */
export function readRequestReminderPolicy(spacingRaw: string | undefined, capRaw: string | undefined): RequestReminderPolicy | null {
  const spacingSeconds = whole(spacingRaw);
  const cap = whole(capRaw);
  if (spacingSeconds === null && cap === null) return null;
  if (spacingSeconds === null || cap === null)
    throw new Error('BANK_REQUEST_REMIND_SPACING_SECONDS and BANK_REQUEST_REMIND_CAP are set together, or both left blank');
  if (!Number.isSafeInteger(spacingSeconds) || spacingSeconds < 60 || spacingSeconds > SPACING_MAX)
    throw new Error(`BANK_REQUEST_REMIND_SPACING_SECONDS must be whole seconds from 60 to ${SPACING_MAX}`);
  if (!Number.isSafeInteger(cap) || cap < 1 || cap > CAP_MAX)
    throw new Error(`BANK_REQUEST_REMIND_CAP must be a whole number from 1 to ${CAP_MAX}`);
  return { spacingSeconds, cap };
}
