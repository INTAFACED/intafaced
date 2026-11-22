/**
 * The venue's words and reads the venue parts share, with no drawing of their own: the venue's API, the "as of" text,
 * a word for a venue enum value, the settled order statuses and an action's outcome in words. `VenueKit.tsx` re-exports
 * each; the kit-drawn parts in `volt/` import them from here.
 */
import { useCallback, useMemo } from 'react';
import { usePreferences } from '../../../shared/preferences';
import { useSession } from '../../session';
import { venueApi, type VenueApi } from '../venue-api';
import { venueCopy } from './venue-copy';
import type { ActionResult } from './VenueKit';

type T = ReturnType<typeof venueCopy.useCopy>['t'];

export function useVenueApi(): VenueApi {
  const { api } = useSession();
  return useMemo(() => venueApi(api), [api]);
}

export function useAsOfText(): (iso: string) => string {
  const { timeZone } = usePreferences();
  const { t } = venueCopy.useCopy();
  return useCallback(
    (iso: string) => {
      let text: string;
      try {
        text = new Intl.DateTimeFormat('en-GB', { timeZone, dateStyle: 'medium', timeStyle: 'medium' }).format(new Date(iso));
      } catch {
        text = iso;
      }
      return t('As of', { time: text });
    },
    [timeZone, t],
  );
}

/** A word from the copy for a venue enum value, or the value itself when the copy has none. */
export function word(t: T, prefix: string, value: string): string {
  const key = `${prefix}_${value}`;
  try {
    const out = (t as (k: string) => string)(key);
    return out && out !== key ? out : value;
  } catch {
    return value;
  }
}

/** The order statuses after which the venue does nothing more with an order. */
export const SETTLED_STATUSES: readonly string[] = ['filled', 'canceled', 'rejected', 'expired'];

/** The words for one action's result. An order's outcome names its status on the venue. */
export function outcomeText(t: T, result: ActionResult): string {
  switch (result.kind) {
    case 'rejected':
      return t('Outcome rejected wallet');
    case 'waiting':
      return t('Outcome waiting');
    case 'wallet_failed':
      return t('Outcome wallet failed', { message: result.message });
    case 'unknown':
      return t('Outcome unknown');
    case 'refused':
      return result.beforeWallet && /step_up/.test(result.code ?? '')
        ? t('Outcome step up', { detail: result.message })
        : t('Outcome refused', { detail: result.message });
    case 'outcome': {
      const o = result.outcome;
      if (!o.accepted) return t('Outcome refused', { detail: o.refusal.detail });
      const status = o.order?.status;
      const main =
        status === 'open'
          ? t('Outcome open')
          : status === 'filled'
            ? t('Outcome filled')
            : status === 'partially_filled'
              ? t('Outcome partly')
              : status === 'canceled'
                ? t('Outcome cancelled')
                : t('Outcome done');
      return result.reused ? `${main} ${t('Outcome reused')}` : main;
    }
  }
}
