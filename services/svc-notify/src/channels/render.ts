import { DEFAULT_LOCALE, createTranslator, hasCatalog, isMessageKey, type ParamValue } from '@intafaced/i18n';
import type { Notification } from '../store.js';

/**
 * COPY RENDERING FOR OUT-OF-APP CHANNELS.
 *
 * The inbox stores keys, not sentences — `title_key`, `body_key`, `params` —
 * and the web client renders them. An email has no client, so somebody has to
 * render it, and that somebody is this file, from the SAME catalog
 * (`@intafaced/i18n`).
 *
 * That is not a convenience. It is the only arrangement in which an email
 * cannot say something a screen could not:
 *
 *   · Every string is a catalog key, so §9's "keyed from day one" holds for
 *     channels that ship no UI.
 *   · The catalog is scanned by `pnpm scan:brand`, so §0.7 holds for copy that
 *     leaves the platform — which is precisely where a partner's name would
 *     otherwise slip in, because nobody reviews an email template.
 *   · A translation added for the web is instantly live on email and SMS. No
 *     second catalogue to drift.
 *
 * Mode is `prod` deliberately: a missing key must not throw and kill a margin
 * call. It falls back to English, reports, and — if the key exists nowhere —
 * renders the key itself, which is ugly, greppable, and not blank. The gate that
 * stops that reaching a user is a test over the kinds this service emits, not a
 * runtime exception on the delivery path.
 */

export interface RenderedCopy {
  readonly title: string;
  readonly body: string;
  /**
   * Consent / opt-out line from `notify.channel.footer`. Present on out-of-app
   * notification copy only — verification messages do not claim consent yet.
   * Null when the catalog key is missing (prod mode falls back to the key
   * string; we still attach it so a missing key is greppable in the wire body).
   */
  readonly footer: string | null;
}

/**
 * Params come off a JSONB column and an event payload, so they are `unknown`.
 * The translator takes strings, numbers and bigints; everything else is
 * stringified rather than dropped, because a placeholder left visible is a bug
 * someone reports and a silently missing value is a bug nobody sees.
 */
function toParamValues(params: Record<string, unknown>): Record<string, ParamValue> {
  const out: Record<string, ParamValue> = {};
  for (const [key, value] of Object.entries(params)) {
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'bigint') {
      out[key] = value;
    } else if (value === null || value === undefined) {
      // Nullable payload fields (an open-ended stake, a market order with no
      // price) are legitimately absent. An em dash reads; "null" does not.
      out[key] = '—';
    } else {
      out[key] = JSON.stringify(value);
    }
  }
  return out;
}

/**
 * The locale this message is actually IN — not the one the row asked for.
 *
 * This used to accept any code in `SUPPORTED_LOCALES`, which is 28 of them, and
 * hand it straight to the adapter as `locale:`. Exactly one of those 28 has a
 * catalog. So a target row saying `locale: 'ar'` produced an English email
 * stamped Arabic, and a gateway that honours the field would mirror the layout
 * right-to-left around left-to-right words — on a margin call, which is the
 * worst message we send to be hard to read.
 *
 * Asking `hasCatalog` instead of `isSupportedLocale` closes that. It is also
 * self-maintaining: the day an Arabic catalog lands, this returns `'ar'` again
 * with no code change here, which is the "translation files, not refactors"
 * promise in §9 actually holding.
 */
export function normaliseLocale(locale: string | null | undefined): string {
  return locale && hasCatalog(locale) ? locale : DEFAULT_LOCALE;
}

/**
 * Out-of-app notification copy.
 *
 * The body ALWAYS ends with the consent footer (`notify.channel.footer`). That
 * key already lived in the catalog and said the right thing; it was rendered by
 * nothing — outbound messages left the platform with no consent or opt-out line
 * at all (closeout residual). Appending it here is the whole fix: every email /
 * push / SMS body the dispatcher builds goes through this function.
 *
 * In-app inbox copy uses `renderInboxCopy` (no consent footer).
 */
export function renderNotification(notification: Notification, locale: string): RenderedCopy {
  const t = createTranslator(normaliseLocale(locale), undefined, { mode: 'prod' });
  const params = toParamValues(notification.params);
  const bodyCore = t.tUnsafe(notification.bodyKey, params);
  const footer = t.t('notify.channel.footer');
  return {
    title: t.tUnsafe(notification.titleKey, params),
    // Footer rides on `body` so adapters that only ship title+body (all of them
    // today) cannot drop it. A blank line separates fact from consent.
    body: footer ? `${bodyCore}\n\n${footer}` : bodyCore,
    footer: footer || null,
  };
}

/**
 * IN-APP INBOX COPY.
 *
 * The inbox stores keys. This is the first product read path that resolves them
 * through `@intafaced/i18n` for the in-app list — not a second catalog, and not
 * the out-of-app renderer (that one appends a consent footer an inbox must not
 * claim).
 *
 * An unknown key is refused by name: the dotted key string is returned. Prod
 * `tUnsafe` would do the same; we also refuse before interpolate so a missing
 * key cannot be replaced with invented English.
 */
export function renderInboxCopy(notification: Notification, locale: string): { title: string; body: string } {
  const t = createTranslator(normaliseLocale(locale), undefined, { mode: 'prod' });
  const params = toParamValues(notification.params);
  const title = resolveInboxString(t, notification.titleKey, params);
  let body = resolveInboxString(t, notification.bodyKey, params);
  // Stamped at create when the email channel is unconfigured. The title stays
  // the notice. This sentence is the extra line a merchant can see.
  if (notification.params.code === 'notify.email_provider_unset') {
    const extra = resolveInboxString(t, 'notify.merchant.email_provider_unset.body', params);
    body = `${body}\n${extra}`;
  }
  return { title, body };
}

function resolveInboxString(t: ReturnType<typeof createTranslator>, key: string, params: Record<string, ParamValue>): string {
  if (!isMessageKey(key)) return key;
  return t.tUnsafe(key, params);
}

/**
 * The address-confirmation message. Same catalog, same rules.
 *
 * No consent footer: the user has not confirmed this address yet, so the line
 * "you are receiving this because you confirmed this address" would be a lie.
 */
export function renderVerification(locale: string, code: string, ttlMinutes: number): RenderedCopy {
  const t = createTranslator(normaliseLocale(locale), undefined, { mode: 'prod' });
  return {
    title: t.t('notify.channel.verify.title'),
    body: t.t('notify.channel.verify.body', { code, minutes: ttlMinutes }),
    footer: null,
  };
}
