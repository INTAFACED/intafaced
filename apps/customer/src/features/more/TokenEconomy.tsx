import { useEffect, useState } from 'react';
import type { ProcedureOutput } from '@intafaced/contracts/procedure';
import {
  TOKEN_BUYBACK_RUNS,
  TOKEN_EMISSION_SCHEDULE,
  TOKEN_REVENUE_SHARE_HISTORY,
  TOKEN_TREASURY,
} from '@intafaced/contracts/token-procedures';
import type { ApiResult } from '../../shared/api';
import { useApi, useSession } from '../session';
import { useResource, type Resource } from '../../shared/resource';
import { displayAmount } from '../../shared/money';
import { usePreferences } from '../../shared/preferences';
import { Button } from '@intafaced/ui/lit';
import { Details } from './catalogue-parts';
import { EmptyNote, FailureNote, KitRead as Read, ScrollTable, Section, Waiting } from './volt-parts';
import { tokenEconomyCopy } from './token-economy-copy';

/** The token service's `emissionSchedule` read: the owner's parameters and the next epochs' rewards, or why they are blank. */
export type EmissionScheduleRead = ProcedureOutput<typeof TOKEN_EMISSION_SCHEDULE>;
/**
 * The treasury read's supply figures: `minted` is the lifetime sum of closed epoch mints (null when none closed) and
 * `burned` the burn account's balance.
 */
export type MintedRead = Pick<ProcedureOutput<typeof TOKEN_TREASURY>, 'minted' | 'burned'>;
/** The token service's `revenueShareHistory` read: this account's real-yield payouts, one row per weekly window, each read from its ledger posting. */
export type YieldHistoryRead = ProcedureOutput<typeof TOKEN_REVENUE_SHARE_HISTORY>;
/**
 * The buyback rate of the token service's `buybackRuns` read. Its runs are not drawn here, so their arithmetic, which
 * the Burn tab checks, does not decide whether the rate can be shown.
 */
export type BuybackRateRead = Pick<ProcedureOutput<typeof TOKEN_BUYBACK_RUNS>, 'rate' | 'reason'>;
/** Every window this room lists names its window. */
const windowsNamed = (read: YieldHistoryRead) => read.items.every((item) => item.windowId.length > 0);
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
    (signal) => api.call(TOKEN_EMISSION_SCHEDULE, { count: EPOCHS }, { signal }),
    `token-emission-schedule:${userId}`,
  );
  const minted = useResource((signal) => api.call(TOKEN_TREASURY, undefined, { signal }), `token-minted:${userId}`);
  const buyback = useResource((signal) => api.call(TOKEN_BUYBACK_RUNS, { limit: 1 }, { signal }), `token-buyback-rate:${userId}`);
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
  buyback: Loaded<BuybackRateRead>;
}) {
  const { hideBalances } = usePreferences();
  const { Copy, t } = tokenEconomyCopy.useCopy();
  const shown = (value: string) => (hideBalances ? t('hidden') : displayAmount(value));
  const figure = <T,>(read: Loaded<T>, value: (data: T) => string) =>
    read.resource.status === 'ready' ? value(read.resource.data) : read.resource.status === 'loading' ? '…' : t('unreadable');
  /** A blank owner value is not reported; one the service cannot read says so. */
  const absent = (reason: string | null) => (reason === 'token.params_invalid' ? t('unreadable') : t('notReported'));
  return (
    <Section title={t('supplyTitle')} aria-label={t('supplyTitle')}>
      <p className="lt-hint">
        <Copy k="supplyBody" />
      </p>
      <div data-testid="supply-figures">
        <Details
          items={[
            [t('totalSupply'), figure(schedule, (d) => (d.params ? shown(d.params.maxSupply) : absent(d.reason)))],
            [t('emitted'), figure(minted, (d) => (d.minted === null ? t('emittedNone') : shown(d.minted)))],
            [t('burnedTotal'), figure(minted, (d) => shown(d.burned))],
            [t('buybackShare'), figure(buyback, (d) => (d.rate ? t('bps', { bps: d.rate.buybackBps }) : absent(d.reason)))],
            [t('burnSplit'), figure(buyback, (d) => (d.rate ? t('bps', { bps: d.rate.burnSplitBps }) : absent(d.reason)))],
            [t('distribution'), t('notReported')],
          ]}
        />
      </div>
      <p role="status" data-testid="supply-distribution">
        <Copy k="distributionUnset" />
      </p>
      {/* A failed schedule or treasury read already shows its refusal and retry in the emission panel above. */}
      {buyback.resource.status === 'failed' && <FailureNote result={buyback.resource.failure} retry={buyback.reload} />}
    </Section>
  );
}

/** A blank owner value reads "not set" with no figure; an unreadable one is not called blank. */
export function EmissionScheduleView({ schedule, minted }: { schedule: Loaded<EmissionScheduleRead>; minted: Loaded<MintedRead> }) {
  const { hideBalances } = usePreferences();
  const { Copy, t } = tokenEconomyCopy.useCopy();
  const shown = (value: string) => (hideBalances ? t('hidden') : displayAmount(value));
  return (
    <Section title={t('emissionTitle')} aria-label={t('emissionTitle')}>
      <p className="lt-hint">
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
              <ScrollTable headers={[t('epoch'), t('reward'), t('change')]} label={t('epochsTitle')}>
                {epochs.map((row) => {
                  // Epochs count from 0, so a halving takes effect at each multiple of the interval (economics/emission.ts).
                  const halving = data.params !== null && row.epoch > 0 && row.epoch % data.params.halvingIntervalEpochs === 0;
                  return (
                    <tr key={row.epoch}>
                      <td>{row.epoch}</td>
                      <td data-align="end">{shown(row.reward)}</td>
                      <td>{halving ? t('halvedHere') : ''}</td>
                    </tr>
                  );
                })}
              </ScrollTable>
              {epochs.length === 0 && <EmptyNote title={t('noEpochs')} />}
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
    </Section>
  );
}

/** This account's weekly real-yield share per window (J-more-catalogue-20 #2), each amount read from its ledger posting. */
export function YieldHistory() {
  const api = useApi();
  const { userId } = useSession();
  const first = useResource(
    (signal) => api.call(TOKEN_REVENUE_SHARE_HISTORY, { limit: YIELD_PAGE }, { signal, accept: windowsNamed }),
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
    const res = await api.call(TOKEN_REVENUE_SHARE_HISTORY, { limit: YIELD_PAGE, cursor }, { accept: windowsNamed });
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
    <Section title={t('yieldTitle')} aria-label={t('yieldTitle')}>
      <p className="lt-hint">
        <Copy k="yieldBody" />
      </p>
      <Read resource={read.resource} retry={read.reload}>
        {(data) => (
          <>
            <ScrollTable headers={[t('window'), t('paid'), t('asset'), t('posting')]} label={t('yieldTable')}>
              {data.items.map((row) => (
                <tr key={row.windowId}>
                  <td>{row.windowId}</td>
                  <td data-align="end">
                    {row.amount === null ? t('amountUnread') : hideBalances ? t('hidden') : displayAmount(row.amount)}
                  </td>
                  <td>{row.assetId ?? t('postingUnread')}</td>
                  <td>{row.ledgerTxId ?? t('postingUnread')}</td>
                </tr>
              ))}
            </ScrollTable>
            {data.items.length === 0 && <EmptyNote title={t('noYield')} />}
            {more?.busy && <Waiting />}
            {more?.failure && <FailureNote result={more.failure} retry={() => data.nextCursor && more.more(data.nextCursor)} />}
            {data.nextCursor && more && !more.busy && (
              <Button tone="secondary" onClick={() => data.nextCursor && more.more(data.nextCursor)}>
                {t('olderWindows')}
              </Button>
            )}
          </>
        )}
      </Read>
    </Section>
  );
}
