import { Bone, Tooltip, TooltipContent, TooltipTrigger } from '@intafaced/ui/lit';
import { FreshnessChip, Select } from '@intafaced/ui/lit/templates';
import { UNKNOWN, fmtPct, fmtPrice } from '../../../data/format';
import type { Loadable } from '../../../data/types';
import type { FundingRate, FuturesListing, TickerStrip } from './api';
import { STALE_AFTER_MS } from './data';
import { deskCopy } from './desk-copy';

function Cell({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="lt-stack-tight lt-tight">
      <span className="lt-label">{label}</span>
      <span className="lt-num">{children}</span>
    </div>
  );
}

/** `2026-10-17T12:00:00Z` -> "3h 12m"; null when the time is missing or already passed. */
export function countdown(iso: string | null, now: number): string | null {
  if (iso === null) return null;
  const at = Date.parse(iso);
  if (!Number.isFinite(at) || at <= now) return null;
  const minutes = Math.floor((at - now) / 60_000);
  const h = Math.floor(minutes / 60);
  return h > 0 ? `${h}h ${minutes % 60}m` : `${minutes}m`;
}

interface Props {
  markets: readonly FuturesListing[];
  market: FuturesListing;
  strip: Loadable<TickerStrip>;
  funding: Loadable<FundingRate>;
  now: number;
  onChoose(symbol: string): void;
}

/** Contract strip (Binance/Hyperliquid header): contract picker, mark, index, funding with countdown, cap, data-freshness chip. */
export function ContractStrip({ markets, market, strip, funding, now, onChoose }: Props) {
  const { t } = deskCopy.useCopy();
  const tick = strip.status === 'ready' ? strip.data : null;
  const fund = funding.status === 'ready' ? funding.data : null;
  const rate = tick?.fundingRate ?? fund?.fundingRate ?? null;
  const nextIso = tick?.nextFundingTime ?? (fund?.nextFundingTimestamp ? new Date(fund.nextFundingTimestamp).toISOString() : null);
  const left = countdown(nextIso, now);
  const style = market.future ? t('Dated') : t('Perpetual');
  // Linear or inverse is the listing's recorded family; a listing that recorded none says so.
  const family = market.inverse ? t('Inverse') : market.linear ? t('Linear') : UNKNOWN;
  const items = markets.map((m) => ({ value: m.symbol, label: m.symbol }));
  return (
    <section aria-label={market.symbol} className="lt-row lt-row-between">
      <Select label={t('Choose a contract')} options={items} value={market.symbol} onChange={(value) => value && onChoose(value)} />
      <div className="lt-row lt-grow">
        <Cell label={t('Mark price')}>
          {strip.status === 'loading' ? <Bone size="word" /> : fmtPrice(tick?.markPrice ?? null, market.precision.price)}
        </Cell>
        <Cell label={t('Index')}>{fmtPrice(fund?.indexPrice ?? null, market.precision.price)}</Cell>
        <Cell label={t('Funding rate')}>
          {rate === null ? (
            <Tooltip>
              <TooltipTrigger render={<span tabIndex={0} />}>{UNKNOWN}</TooltipTrigger>
              <TooltipContent>{t('Not published')}</TooltipContent>
            </Tooltip>
          ) : (
            fmtPct(rate, { places: 4 })
          )}
        </Cell>
        <Cell label={t('Next funding')}>{left === null ? UNKNOWN : t('in time', { time: left })}</Cell>
        <Cell label={t('Contract type')}>
          {style} · {family}
        </Cell>
        <Cell label={t('Settle asset')}>{market.settle ?? UNKNOWN}</Cell>
        <Cell label={t('Contract size')}>{market.contractSize ? `${market.contractSize} ${market.base}` : UNKNOWN}</Cell>
      </div>
      <FreshnessChip
        asOf={strip.status === 'ready' ? strip.asOf : null}
        now={now}
        staleAfterMs={STALE_AFTER_MS.strip}
        refused={strip.status === 'refused' || strip.status === 'error'}
      />
    </section>
  );
}
