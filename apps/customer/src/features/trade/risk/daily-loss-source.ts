/**
 * `trade.dailyLoss.*`: the person's opt-in daily loss limit on their own venue account (svc-trade
 * src/venue/daily-loss-limit.ts). A setting only: nothing is sent to the venue and the ledger posts nothing. svc-trade
 * counts today's loss from the venue's own fills and judges every opening order against it in the door's prepare.
 */
import { useMemo } from 'react';
import type { z } from 'zod';
import { useDataEnv, useSource, type Loadable } from '../../../data';
import { constantSource } from '../../../data/source';
import type { ApiResult } from '../../../shared/api';
import {
  DAILY_LOSS_GET,
  DAILY_LOSS_OFF,
  DAILY_LOSS_SET,
  type dailyLossViewSchema,
  type DAILY_LOSS_MODES,
} from '@intafaced/contracts/trade-daily-loss-procedures';

export type DailyLossView = z.output<typeof dailyLossViewSchema>;
export type DailyLossMode = (typeof DAILY_LOSS_MODES)[number];
export type DailyLossTerms = NonNullable<DailyLossView['active']>;
/** A view whose loss was counted: the asset and today's figures are there (every read but the desk's of a limit never set). */
export type CountedDailyLoss = DailyLossView & { asset: string; today: NonNullable<DailyLossView['today']> };

/** The view when its loss was counted; `null` for the desk's read of an account that never set a limit (it is off). */
export function counted(view: DailyLossView | null): CountedDailyLoss | null {
  if (!view || view.asset === null || view.today === null) return null;
  return { ...view, asset: view.asset, today: view.today };
}

/** Read often: a close on the desk changes today's loss, and the desk's warning follows it. */
const DAILY_LOSS_INTERVAL = 5_000;

const viewKey = (userId: string, owner: string) => `trade-daily-loss:${userId}:${owner.toLowerCase()}`;

/**
 * The account's limit, a loosening waiting out its 24 hours, and today's loss; `null` owner: no wallet is connected.
 * `terms`: the desk's read, which asks the venue nothing while the account has never set a limit.
 */
export function useDailyLoss(owner: string | null, { terms = false }: { terms?: boolean } = {}): Loadable<DailyLossView> {
  const env = useDataEnv();
  return useSource(
    useMemo(() => {
      if (!owner) return constantSource<DailyLossView>({ status: 'empty' });
      if (!env.userId) return constantSource<DailyLossView>({ status: 'refused', code: 'auth.required' });
      return env.poller.source<DailyLossView>(
        `${viewKey(env.userId, owner)}${terms ? ':terms' : ''}`,
        (signal) => env.api.call(DAILY_LOSS_GET, terms ? { owner, terms } : { owner }, { signal }),
        { intervalMs: DAILY_LOSS_INTERVAL },
      );
    }, [env, owner, terms]),
  );
}

export type DailyLossChange = { kind: 'set'; mode: DailyLossMode; limit: string } | { kind: 'off' };

/** Saves one change, then reads the limit again everywhere it is shown. Stricter applies at once; looser waits 24 hours. */
export function useSaveDailyLoss(owner: string | null) {
  const env = useDataEnv();
  return async (change: DailyLossChange): Promise<ApiResult<DailyLossView>> => {
    if (!owner) return { ok: false, reason: 'error', code: 'trade.daily_loss_request_invalid', message: 'Connect your wallet first.' };
    const answer =
      change.kind === 'off'
        ? await env.api.call(DAILY_LOSS_OFF, { owner })
        : await env.api.call(DAILY_LOSS_SET, { owner, limit: change.limit, mode: change.mode });
    if (env.userId) {
      env.poller.refresh(viewKey(env.userId, owner));
      env.poller.refresh(`${viewKey(env.userId, owner)}:terms`);
    }
    return answer;
  };
}

/**
 * Whether an opening order meets an advisory limit already reached: the desk asks the person to confirm it, naming the
 * limit. svc-trade judges the same at prepare (a blocking limit refuses there, before anything is signed).
 */
export function advisoryReached(view: CountedDailyLoss | null): DailyLossTerms | null {
  if (!view || !view.active || view.active.mode !== 'advisory') return null;
  return view.today.reached || view.today.loss === null ? view.active : null;
}
