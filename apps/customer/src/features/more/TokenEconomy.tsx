// hand-declared-ok: svc-token's emissionSchedule, treasury, buybackRuns and revenueShareHistory outputs are declared in its router; packages/contracts has no token schemas yet
import { useEffect, useState } from 'react';
import { z } from 'zod';
import type { ApiResult } from '../../shared/api';
import { useApi, useSession } from '../session/session';
import { useResource, type Resource } from '../../shared/resource';
import { decimalSchema, displayAmount } from '../../shared/money';
import { usePreferences } from '../../shared/preferences';
import { Button, DataTable, EmptyState, Failure, Loading, Panel } from '../../shared/ui';
import { Details, Read } from './common';
import { tokenEconomyCopy } from './token-economy-copy';
import { buybackRunsSchema, type BuybackRunsRead } from './BuybackRuns';

const paramsReason = z.enum(['token.params_unset', 'token.params_missing', 'token.params_invalid']);

/** The token service's `emissionSchedule` read: the owner's parameters and the next epochs' rewards, or why they are blank. */
export const emissionScheduleSchema = z
  .object({
    params: z
      .object({
        initialEpochReward: decimalSchema,
        halvingIntervalEpochs: z.number().int().positive(),
        maxSupply: decimalSchema,
      })
      .nullable(),
    epochs: z.array(z.object({ epoch: z.number().int().nonnegative(), reward: decimalSchema })).nullable(),
    missing: z.string().nullable(),
    reason: paramsReason.nullable(),
  })
  .refine((r) => (r.params === null) === (r.reason !== null), 'emission schedule is neither set nor refused');

/**
 * The treasury read's supply figures: `minted` is the lifetime sum of closed epoch mints (null when none closed) and
 * `burned` the burn account's balance.
 */
export const mintedSchema = z.object({ minted: decimalSchema.nullable(), burned: decimalSchema });

/** The token service's `revenueShareHistory` read: this account's real-yield payouts, one row per weekly window, each read from its ledger posting. */
export const yieldHistorySchema = z.object({
  items: z.array(
    z.object({
      windowId: z.string().min(1),
      amount: decimalSchema.nullable(),
      assetId: z.string().nullable(),
      ledgerTxId: z.string().nullable(),
      reason: z.literal('ledger_tx_unread').nullable(),
    }),
  ),
  nextCursor: z.string().nullable(),
});

export type EmissionScheduleRead = z.infer<typeof emissionScheduleSchema>;
export type MintedRead = z.infer<typeof mintedSchema>;
export type YieldHistoryRead = z.infer<typeof yieldHistorySchema>;
type Loaded<T> = { resource: Resource<T>; reload: () => void };

const EPOCHS = 12;
/** How many windows one read of the yield history takes. A page size of this panel, not a product limit. */
const YIELD_PAGE = 50;
type Failed = Extract<ApiResult<unknown>, { ok: false }>;

/**
 * The economy tab's token panels: the emission schedule (J-more-catalogue-20 #4) and supply and distribution (#5), from
 * one read each of the schedule, the treasury and the buyback rate, then this account's real yield (#2).
 */
export function TokenEconomyPanels() {
  const api = useApi();
  const { userId } = useSession();
  const schedule = useResource(
    (signal) => api.query('token', 'emissionSchedule', { count: EPOCHS }, emissionScheduleSchema, { signal }),
    `token-emission-schedule:${userId}`,
  );
  const minted = useResource((signal) => api.query('token', 'treasury', undefined, mintedSchema, { signal }), `token-minted:${userId}`);
  const buyback = useResource(
    (signal) => api.query('token', 'buybackRuns', { limit: 1 }, buybackRunsSchema, { signal }),
    `token-buyback-rate:${userId}`,
  );
  return (
    <>
      <EmissionScheduleView schedule={schedule} minted={minted} />
      <SupplyView schedule={schedule} minted={minted} buyback={buyback} />
      <YieldHistory />
    </>
  );
}

/**
 * Supply and distribution (J-more-catalogue-20 #5), each figure as the token service reports it. A figure the service
 * does not report reads "not reported" with no number: no service publishes a distribution schedule, and a blank owner
 * value is not filled in.
 */
export function SupplyView({
  schedule,
  minted,
  buyback,
}: {
  schedule: Loaded<EmissionScheduleRead>;
  minted: Loaded<MintedRead>;
  buyback: Loaded<BuybackRunsRead>;
}) {
  const { hideBalances } = usePreferences();
  const { Copy, t } = tokenEconomyCopy.useCopy();
  const shown = (value: string) => (hideBalances ? t('hidden') : displayAmount(value));
  const figure = <T,>(read: Loaded<T>, value: (data: T) => string) =>
    read.resource.status === 'ready' ? value(read.resource.data) : read.resource.status === 'loading' ? '…' : t('unreadable');
  const failed = [schedule, minted, buyback].find((read) => read.resource.status === 'failed');
  return (
    <Panel title={t('supplyTitle')} aria-label={t('supplyTitle')}>
      <p className="muted">
        <Copy k="supplyBody" />
      </p>
      <div data-testid="supply-figures">
        <Details
          items={[
            [t('totalSupply'), figure(schedule, (d) => (d.params ? shown(d.params.maxSupply) : t('notReported')))],
            [t('emitted'), figure(minted, (d) => (d.minted === null ? t('emittedNone') : shown(d.minted)))],
            [t('burnedTotal'), figure(minted, (d) => shown(d.burned))],
            [t('buybackShare'), figure(buyback, (d) => (d.rate ? t('bps', { bps: d.rate.buybackBps }) : t('notReported')))],
            [t('burnSplit'), figure(buyback, (d) => (d.rate ? t('bps', { bps: d.rate.burnSplitBps }) : t('notReported')))],
            [t('distribution'), t('notReported')],
          ]}
        />
      </div>
      <p role="status" data-testid="supply-distribution">
        <Copy k="distributionUnset" />
      </p>
      {failed && failed.resource.status === 'failed' && <Failure result={failed.resource.failure} retry={failed.reload} />}
    </Panel>
  );
}

/** A blank owner value reads "not set" with no figure; an unreadable one is not called blank. */
export function EmissionScheduleView({ schedule, minted }: { schedule: Loaded<EmissionScheduleRead>; minted: Loaded<MintedRead> }) {
  const { hideBalances } = usePreferences();
  const { Copy, t } = tokenEconomyCopy.useCopy();
  const shown = (value: string) => (hideBalances ? t('hidden') : displayAmount(value));
  return (
    <Panel title={t('emissionTitle')} aria-label={t('emissionTitle')}>
      <p className="muted">
        <Copy k="emissionBody" />
      </p>
      <Read resource={schedule.resource} retry={schedule.reload}>
        {(data) => {
          const blank = data.reason === 'token.params_invalid' ? t('unreadable') : t('notSet');
          const epochs = data.epochs ?? [];
          return (
            <>
              <div data-testid="emission-params">
                <Details
                  items={[
                    [t('initialReward'), data.params ? shown(data.params.initialEpochReward) : blank],
                    [t('halving'), data.params ? t('halvingEvery', { epochs: data.params.halvingIntervalEpochs }) : blank],
                    [t('cap'), data.params ? shown(data.params.maxSupply) : blank],
                  ]}
                />
              </div>
              {data.params === null && (
                <p role="status" data-testid="emission-blank">
                  {data.reason === 'token.params_invalid' ? t('scheduleUnreadable') : t('scheduleUnset')}
                </p>
              )}
              <DataTable headers={[t('epoch'), t('reward'), t('change')]} label={t('epochsTitle')}>
                {epochs.map((row) => {
                  // Epochs count from 0, so a halving takes effect at each multiple of the interval (economics/emission.ts).
                  const halving = data.params !== null && row.epoch > 0 && row.epoch % data.params.halvingIntervalEpochs === 0;
                  return (
                    <tr key={row.epoch}>
                      <td>{row.epoch}</td>
                      <td className="numeric">{shown(row.reward)}</td>
                      <td>{halving ? t('halvedHere') : ''}</td>
                    </tr>
                  );
                })}
              </DataTable>
              {epochs.length === 0 && <EmptyState title={t('noEpochs')} />}
            </>
          );
        }}
      </Read>
      <Read resource={minted.resource} retry={minted.reload}>
        {(data) => (
          <p data-testid="emission-minted">{data.minted === null ? t('mintedNone') : t('minted', { amount: shown(data.minted) })}</p>
        )}
      </Read>
      <p data-testid="emission-minter">
        <Copy k="minterRule" />
      </p>
    </Panel>
  );
}

/** This account's weekly real-yield share per window (J-more-catalogue-20 #2), each amount read from its ledger posting. */
export function YieldHistory() {
  const api = useApi();
  const { userId } = useSession();
  const first = useResource(
    (signal) => api.query('token', 'revenueShareHistory', { limit: YIELD_PAGE }, yieldHistorySchema, { signal }),
    `token-yield-history:${userId}`,
  );
  const [later, setLater] = useState<YieldHistoryRead | null>(null);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<Failed | null>(null);
  useEffect(() => {
    setLater(null);
    setFailure(null);
  }, [first.resource]);
  async function more(cursor: string) {
    setBusy(true);
    setFailure(null);
    const res = await api.query('token', 'revenueShareHistory', { limit: YIELD_PAGE, cursor }, yieldHistorySchema);
    setBusy(false);
    if (res.ok) setLater((prev) => ({ items: [...(prev?.items ?? []), ...res.data.items], nextCursor: res.data.nextCursor }));
    else setFailure(res);
  }
  const read =
    first.resource.status === 'ready'
      ? {
          resource: {
            status: 'ready' as const,
            data: {
              items: [...first.resource.data.items, ...(later?.items ?? [])],
              nextCursor: later ? later.nextCursor : first.resource.data.nextCursor,
            },
          },
          reload: first.reload,
        }
      : first;
  return <YieldHistoryView read={read} more={{ busy, failure, more }} />;
}

/** A payout whose ledger posting cannot be read shows no amount and no asset; nothing is taken from the payout table. */
export function YieldHistoryView({
  read,
  more,
}: {
  read: Loaded<YieldHistoryRead>;
  more?: { busy: boolean; failure: Failed | null; more: (cursor: string) => void };
}) {
  const { hideBalances } = usePreferences();
  const { Copy, t } = tokenEconomyCopy.useCopy();
  return (
    <Panel title={t('yieldTitle')} aria-label={t('yieldTitle')}>
      <p className="muted">
        <Copy k="yieldBody" />
      </p>
      <Read resource={read.resource} retry={read.reload}>
        {(data) => (
          <>
            <DataTable headers={[t('window'), t('paid'), t('asset'), t('posting')]} label={t('yieldTable')}>
              {data.items.map((row) => (
                <tr key={row.windowId}>
                  <td>{row.windowId}</td>
                  <td className="numeric">
                    {row.amount === null ? t('amountUnread') : hideBalances ? t('hidden') : displayAmount(row.amount)}
                  </td>
                  <td>{row.assetId ?? t('postingUnread')}</td>
                  <td>{row.ledgerTxId ?? t('postingUnread')}</td>
                </tr>
              ))}
            </DataTable>
            {data.items.length === 0 && <EmptyState title={t('noYield')} />}
            {more?.busy && <Loading />}
            {more?.failure && <Failure result={more.failure} retry={() => data.nextCursor && more.more(data.nextCursor)} />}
            {data.nextCursor && more && !more.busy && (
              <Button variant="secondary" onClick={() => data.nextCursor && more.more(data.nextCursor)}>
                {t('olderWindows')}
              </Button>
            )}
          </>
        )}
      </Read>
    </Panel>
  );
}
