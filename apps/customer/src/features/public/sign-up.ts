import { z } from 'zod';
import type { ApiResult } from '../../shared/api';
import { sessionSchema } from '../session/session';

// hand-declared-ok: svc-identity's sign-up answers (auth.signUpStart, auth.signUpConfirm) have no browser-safe schema in packages/contracts yet

/** `auth.signUpStart` and `auth.signUpResend`: the same answer for a new address and a known one, and no session. */
export const signUpAcceptedSchema = z.object({
  accepted: z.literal(true),
  next: z.literal('confirm_email'),
  flowId: z.string().guid(),
  resendAfterSeconds: z.number().int().positive(),
});
export type SignUpAccepted = z.infer<typeof signUpAcceptedSchema>;

/** `auth.signUpConfirm`: the first session, and which account type was chosen so business accounts go to verification. */
export const signUpConfirmedSchema = sessionSchema.extend({ accountType: z.enum(['individual', 'business']) });

export const ACCOUNT_TYPES = ['individual', 'business'] as const;
export type AccountType = (typeof ACCOUNT_TYPES)[number];
export type Channel = 'email' | 'phone';

/** Region codes that name no country. The service refuses the same list. */
const NOT_COUNTRIES = new Set(['EU', 'EZ', 'UN', 'QO', 'XA', 'XB', 'ZZ']);

/** Every ISO country the browser can name, sorted by its name in `locale`. The service checks each one again. */
export function countryOptions(locale: string): Array<{ code: string; name: string }> {
  let names: Intl.DisplayNames;
  try {
    names = new Intl.DisplayNames([locale, 'en'], { type: 'region', fallback: 'code' });
  } catch {
    names = new Intl.DisplayNames(['en'], { type: 'region', fallback: 'code' });
  }
  const out: Array<{ code: string; name: string }> = [];
  for (let a = 65; a <= 90; a++) {
    for (let b = 65; b <= 90; b++) {
      const code = String.fromCharCode(a, b);
      if (NOT_COUNTRIES.has(code)) continue;
      const name = names.of(code);
      if (name && name !== code) out.push({ code, name });
    }
  }
  return out.sort((x, y) => x.name.localeCompare(y.name, locale));
}

/** Today as `YYYY-MM-DD`: the latest date the birth-date field accepts. */
export function todayIso(now = new Date()): string {
  return now.toISOString().slice(0, 10);
}

/** The refusals the sign-up page words itself. Anything else falls back to the shared failure card. */
export const SIGN_UP_CODES = [
  'identity.registration_closed',
  'identity.registration_open_unset',
  'identity.signup_unwired',
  'identity.age_rule_unset',
  'identity.date_of_birth_invalid',
  'identity.underage',
  'identity.country_invalid',
  'identity.region_blocked',
  'identity.screening_unset',
  'identity.signup_expired',
  'identity.signup_code_invalid',
  'identity.signup_code_used',
  'identity.resend_too_soon',
  'auth.too_many_attempts',
  'auth.password_policy',
  'auth.handle_taken',
  'auth.email_taken',
  'vendor.email',
  'vendor.sms',
] as const;
export type SignUpCode = (typeof SIGN_UP_CODES)[number];

export function signUpCode(result: Extract<ApiResult<unknown>, { ok: false }>): SignUpCode | undefined {
  return (SIGN_UP_CODES as readonly string[]).includes(result.code ?? '') ? (result.code as SignUpCode) : undefined;
}

/** Whole seconds until `until`, never negative. */
export function secondsLeft(until: number, now = Date.now()): number {
  return Math.max(0, Math.ceil((until - now) / 1000));
}
