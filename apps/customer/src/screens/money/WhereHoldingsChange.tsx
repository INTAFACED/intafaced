import { useMemo, useState } from 'react';
import { Button, RefusalBox, Segmented } from '@intafaced/ui/lit';
import { Skeleton } from '@intafaced/ui/lit/templates';
import type { ValuationPrices } from '@intafaced/contracts/valuation-prices';
import { useSession } from '../../features/session/session';
import { usePolled } from '../../features/protocol/wallet/use-polled';
import { createVenueAccountApi } from '../../features/protocol/venue-wallet/venue-account-api';
import { useVenueApi } from '../../features/trade/venue/VenueKit';
import { usePreferences } from '../../shared/preferences';
import { moneyCopy } from './copy';
import { dec, fmtAmount } from './deps';
import { CHANGE_RANGES, type ChangeRangeKey } from './holdings-change-source';
import { Shown } from './money-parts';
import { READ_EVERY_MS } from './standing-data';
import { dollars } from './StandingTotal';
import { stamp } from './time';
import { venueHoldingsChange, type VenueHoldingsChange } from './where-holdings-change';
import { whereCopy } from './where-it-sits-copy';

type WhereT = ReturnType<typeof whereCopy.useCopy>['t'];

function signedAmount(change: string, asset: string): string {
  return `${(dec(change) ?? 0n) > 0n ? '+' : ''}${fmtAmount(change)} ${asset}`;
}

/**
 * Holdings change over a period on the launch model (J-portfolio-06 #3): reads the venue account's balances, fills,
 * credits from outside (`arrivals`, falling back to credited `deposits`), markets and vault positions, and shows what
 * each coin held then and now, what rose and what fell, and each end's value where a price is published.
 */
export function WhereHoldingsChange({
  owner,
  prices,
  hidden,
  t,
}: {
  owner: string;
  prices: ValuationPrices | null;
  hidden: boolean;
  t: WhereT;
}) {
  const copy = moneyCopy.useCopy();
  const { t: mt } = copy;
  const { timeZone } = usePreferences();
  const { api } = useSession();
  const venue = useVenueApi();
  const venueAccount = useMemo(() => createVenueAccountApi(api), [api]);
  const [key, setKey] = useState<ChangeRangeKey>('7d');
  const hours = CHANGE_RANGES.find((range) => range.key === key)!.hours;

  const read = usePolled<VenueHoldingsChange>(
    async (signal) => {
      const toMs = Date.now();
      const fromIso = new Date(toMs - hours * 3_600_000).toISOString();
      const toIso = new Date(toMs).toISOString();
      const [balances, markets, fills, arrivalsRes, vaultsRes] = await Promise.all([
        venue.balances(owner, signal),
        venue.markets(signal),
        venue.fills(owner, fromIso, signal),
        venue.arrivals(owner, signal),
        venue.vaultHoldings(owner, signal),
      ]);
      if (!balances.ok) return balances;
      if (!markets.ok) return markets;
      if (!fills.ok) return fills;

      let arrivals;
      if (arrivalsRes.ok) {
        arrivals = arrivalsRes.data.value;
      } else if (/not_offered/.test(`${arrivalsRes.code ?? ''} ${arrivalsRes.message}`)) {
        const depositsRes = await venueAccount.deposits(owner, signal);
        if (!depositsRes.ok) {
          if (/not_offered/.test(`${depositsRes.code ?? ''} ${depositsRes.message}`)) {
            return { ok: false as const, reason: 'not_supported' as const, code: 'venue.arrivals_not_offered', message: '' };
          }
          return depositsRes;
        }
        arrivals = depositsRes.data.value
          .filter((d) => d.status === 'credited')
          .map((d) => ({
            arrivalId: d.depositRef,
            kind: 'deposit' as const,
            asset: d.asset,
            amount: d.amount,
            arrivedAt: d.seenAt,
          }));
      } else {
        return arrivalsRes;
      }

      return {
        ok: true as const,
        data: venueHoldingsChange({
          fromIso,
          toIso,
          balances: balances.data.value,
          vaults: vaultsRes.ok ? vaultsRes.data.value.positions : [],
          markets: markets.data.value,
          fills: fills.data.value,
          arrivals,
          prices,
        }),
      };
    },
    `where:holdings-change:${owner}:${key}:${prices?.published ? prices.asOf : 'none'}`,
    READ_EVERY_MS,
  );

  let body;
  if (!read.data && !read.failure) {
    body = <Skeleton shape="rows" count={2} />;
  } else if (read.failure && !read.data) {
    if (read.failure.code === 'venue.arrivals_not_offered') {
      body = (
        <p data-testid="money-note" className="lt-hint" data-refused="venue.arrivals_not_offered">
          {t('Holdings change credits unavailable')}
        </p>
      );
    } else {
      body = (
        <div data-testid="money-state" data-slot="state-block" data-kind="error" className="lt-stack">
          <RefusalBox refusal={{ variant: 'unreachable', title: mt('Change unreadable'), body: '' }} />
          <div className="lt-actions">
            <Button tone="secondary" onClick={read.reload}>
              {mt('Try again')}
            </Button>
          </div>
        </div>
      );
    }
  } else if (!read.data || read.data.rows.length === 0) {
    body = (
      <p data-testid="money-note" className="lt-hint">
        {mt('Change nothing held')}
      </p>
    );
  } else {
    const data = read.data;
    body = (
      <table
        data-testid="money-table"
        className="lt-table"
        aria-label={mt('Holdings change table', { from: stamp(data.from, timeZone), to: stamp(data.to, timeZone) })}
      >
        <thead>
          <tr>
            <th scope="col">{mt('Coin')}</th>
            <th scope="col" data-align="end">
              {mt('Change then')}
            </th>
            <th scope="col" data-align="end">
              {mt('Change now')}
            </th>
            <th scope="col" data-align="end">
              {mt('Change amount')}
            </th>
            <th scope="col" data-align="end">
              {mt('Change value then')}
            </th>
            <th scope="col" data-align="end">
              {mt('Change value now')}
            </th>
          </tr>
        </thead>
        <tbody>
          {data.rows.map((row) => {
            const none = (dec(row.startAmount) ?? 0n) === 0n;
            return (
              <tr
                key={row.assetId}
                data-change-asset={row.assetId}
                data-start={row.startAmount}
                data-end={row.endAmount}
                data-change={row.change}
              >
                <th scope="row">{row.assetId}</th>
                <td data-align="end" data-label={mt('Change then')}>
                  {none ? (
                    mt('No holding yet')
                  ) : (
                    <Shown slot="amount" text={`${fmtAmount(row.startAmount)} ${row.assetId}`} hidden={hidden} />
                  )}
                </td>
                <td data-align="end" data-label={mt('Change now')}>
                  <Shown slot="amount" text={`${fmtAmount(row.endAmount)} ${row.assetId}`} hidden={hidden} />
                </td>
                <td data-align="end" data-label={mt('Change amount')}>
                  <Shown slot="amount" text={signedAmount(row.change, row.assetId)} hidden={hidden} />
                </td>
                <td data-align="end" data-label={mt('Change value then')}>
                  {none ? (
                    '—'
                  ) : row.startValueUsd === null ? (
                    mt('Not priced')
                  ) : (
                    <Shown slot="amount" text={dollars(row.startValueUsd)} hidden={hidden} />
                  )}
                </td>
                <td data-align="end" data-label={mt('Change value now')}>
                  {row.endValueUsd === null ? mt('Not priced') : <Shown slot="amount" text={dollars(row.endValueUsd)} hidden={hidden} />}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    );
  }

  return (
    <section data-testid="money-card" data-venue-holdings-change="" className="lt-stack" aria-label={mt('Holdings change')}>
      <header data-testid="money-card__head" className="lt-title-row">
        <h2>{mt('Holdings change')}</h2>
      </header>
      <Segmented
        label={mt('Change range')}
        value={key}
        onChange={setKey}
        options={CHANGE_RANGES.map((range) => ({ value: range.key, label: mt(range.label) }))}
      />
      {body}
      <p data-testid="money-note" className="lt-hint">
        {t('Holdings change rule')}
      </p>
    </section>
  );
}
