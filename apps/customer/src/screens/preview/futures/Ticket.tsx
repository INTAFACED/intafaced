import { useMemo, useState } from 'react';
import { AmountInput, Checkbox, SegmentedControl } from '@intafaced/ui';
import { PreviewActionButton, PreviewChip } from '../../../preview';
import { dec, ratio, str, times, SCALE, type Scaled } from '../../../data/decimal';
import type { MarginMode, PerpContract, PerpPosition } from '../../../preview/fixtures/futures';
import { futuresCopy } from './copy';
import { d, liquidationPrice, marginFor, maxSize, percentOfSize, positionValue, unrealisedPnl } from './math';
import { pctPlain, places, price, priceCell, signedUsd, size as sizeText, tone, usd } from './show';

type OrderType = 'limit' | 'market' | 'stop';
const PERCENTS = [25, 50, 75, 100] as const;
const PRESETS = [1, 5, 10, 20] as const;

function scaled(text: string): Scaled | null {
  return text === '' ? null : dec(text);
}

interface Props {
  contract: PerpContract;
  /** Sample futures wallet in US dollars. */
  available: string;
  /** The sample position on this contract, for the Close tab. */
  position: PerpPosition | null;
}

export function Ticket({ contract, available, position }: Props) {
  const { t } = futuresCopy.useCopy();
  const lotPlaces = places(contract.lot);
  const tickPlaces = places(contract.tick);
  const wallet = d(available);
  const lot = d(contract.lot);
  const maintenance = d(contract.maintenanceMargin);

  const [mode, setMode] = useState<MarginMode>('isolated');
  const [leverage, setLeverage] = useState(Math.min(10, contract.maxLeverage));
  const [action, setAction] = useState<'open' | 'close'>('open');
  const [type, setType] = useState<OrderType>('limit');
  const [limitText, setLimitText] = useState(contract.last);
  const [triggerText, setTriggerText] = useState(contract.mark);
  const [sizeTextValue, setSizeText] = useState(() => {
    const raw = ratio(6000n * SCALE, d(contract.last));
    return raw === null ? '' : str((raw / lot) * lot);
  });
  const [tpsl, setTpsl] = useState(false);
  const [reduceOnly, setReduceOnly] = useState(false);
  const [tpText, setTpText] = useState('');
  const [slText, setSlText] = useState('');

  const reference = type === 'market' ? d(contract.last) : (scaled(limitText) ?? d(contract.last));
  const amount = action === 'close' && position ? d(position.size) : (scaled(sizeTextValue) ?? 0n);
  const value = positionValue(amount, reference);
  const margin = marginFor(value, leverage);
  const fee = times(value, d(contract.takerFee));
  const extra = mode === 'cross' ? wallet : 0n;
  const liq = (side: 'long' | 'short') =>
    liquidationPrice({ side, size: amount, entry: reference, margin, maintenanceMargin: maintenance, extra });
  const liqLong = amount > 0n ? liq('long') : null;
  const liqShort = amount > 0n ? liq('short') : null;
  const biggest = maxSize(wallet, leverage, reference, lot);
  const short = action === 'open' && amount > 0n && margin + fee > wallet;

  // Distance to liquidation on an isolated position: 1 / leverage, less the maintenance margin.
  const moveToLiquidation = useMemo(() => {
    const share = SCALE / BigInt(leverage) - maintenance;
    return share > 0n ? pctPlain(share, 1) : null;
  }, [leverage, maintenance]);

  const tp = scaled(tpText);
  const sl = scaled(slText);
  const bracket = useMemo(() => {
    if (!tpsl || amount <= 0n || (tp === null && sl === null)) return null;
    const asLong = (tp === null || tp > reference) && (sl === null || sl < reference);
    const asShort = (tp === null || tp < reference) && (sl === null || sl > reference);
    if (!asLong && !asShort) return { kind: 'check' as const };
    const side = asLong ? 'long' : 'short';
    return {
      kind: side,
      profit: tp === null ? null : unrealisedPnl(side, amount, reference, tp),
      loss: sl === null ? null : unrealisedPnl(side, amount, reference, sl),
    } as const;
  }, [tpsl, amount, tp, sl, reference]);

  const setPercent = (percent: number) => {
    const next = percentOfSize(biggest, percent, lot);
    setSizeText(str(next));
  };

  return (
    <section className="fx-panel fx-ticket" aria-labelledby="fx-ticket-title">
      <header className="fx-panel__head">
        <h2 className="fx-panel__title" id="fx-ticket-title">
          {t('Order ticket')} <PreviewChip />
        </h2>
      </header>

      <SegmentedControl
        aria-label={t('Margin mode')}
        size={32}
        fullWidth
        value={mode}
        onValueChange={(next) => setMode(next as MarginMode)}
        items={[
          { value: 'isolated', label: t('Isolated') },
          { value: 'cross', label: t('Cross') },
        ]}
      />
      <p className="fx-hint" data-testid="fx-mode-note">
        {mode === 'isolated' ? t('Isolated note') : t('Cross note')}
      </p>

      <div className="fx-lev">
        <div className="fx-lev__head">
          <label htmlFor="fx-lev-range">{t('Leverage')}</label>
          <output className="fx-lev__value" htmlFor="fx-lev-range" data-testid="fx-leverage">
            {leverage}x
          </output>
        </div>
        <input
          id="fx-lev-range"
          className="fx-lev__range"
          type="range"
          min={1}
          max={contract.maxLeverage}
          step={1}
          value={leverage}
          aria-valuetext={`${leverage}x`}
          onChange={(event) => setLeverage(Number(event.currentTarget.value))}
        />
        <div className="fx-lev__presets" role="group" aria-label={t('Leverage presets')}>
          {[...PRESETS.filter((p) => p < contract.maxLeverage), contract.maxLeverage].map((p) => (
            <button key={p} type="button" className="fx-chip" aria-pressed={leverage === p} onClick={() => setLeverage(p)}>
              {p}x
            </button>
          ))}
        </div>
        <p className="fx-hint">
          {mode === 'isolated' && moveToLiquidation ? t('Move to liquidation', { move: moveToLiquidation }) : t('Cross leverage note')}
        </p>
      </div>

      <SegmentedControl
        aria-label={t('Open or close')}
        size={32}
        fullWidth
        value={action}
        onValueChange={(next) => setAction(next as 'open' | 'close')}
        items={[
          { value: 'open', label: t('Open') },
          { value: 'close', label: t('Close') },
        ]}
      />

      <SegmentedControl
        aria-label={t('Order type')}
        size={28}
        fullWidth
        value={type}
        onValueChange={(next) => setType(next as OrderType)}
        items={[
          { value: 'limit', label: t('Limit') },
          { value: 'market', label: t('Market') },
          { value: 'stop', label: t('Stop-limit') },
        ]}
      />

      <div className="fx-fields">
        {type === 'stop' ? (
          <AmountInput
            label={t('Trigger')}
            unit="USDT"
            value={triggerText}
            onValueChange={setTriggerText}
            precision={tickPlaces}
            tick={contract.tick}
          />
        ) : null}
        {type === 'market' ? (
          <div className="fx-field-static" data-testid="fx-market-price">
            <span>{t('Price')}</span>
            <span>{t('Market price')}</span>
          </div>
        ) : (
          <AmountInput
            label={t('Price')}
            unit="USDT"
            value={limitText}
            onValueChange={setLimitText}
            precision={tickPlaces}
            tick={contract.tick}
            onBbo={() => setLimitText(contract.last)}
            bboLabel={t('Last')}
          />
        )}
        {action === 'open' ? (
          <>
            <AmountInput
              label={t('Size')}
              unit={contract.base}
              value={sizeTextValue}
              onValueChange={setSizeText}
              precision={lotPlaces}
              tick={contract.lot}
            />
            <div className="fx-percent" role="group" aria-label={t('Size shortcuts')}>
              {PERCENTS.map((p) => (
                <button key={p} type="button" className="fx-chip" onClick={() => setPercent(p)}>
                  {p}%
                </button>
              ))}
            </div>
          </>
        ) : (
          <div className="fx-field-static" data-testid="fx-close-size">
            <span>{t('Position to close')}</span>
            <span>
              {position
                ? `${sizeText(position.size, contract.lot)} ${contract.base} ${t(position.side === 'long' ? 'Long' : 'Short')}`
                : t('No open position')}
            </span>
          </div>
        )}
      </div>

      {action === 'open' ? (
        <div className="fx-checks">
          <label className="fx-check">
            <Checkbox checked={tpsl} onCheckedChange={(next) => setTpsl(next === true)} aria-label={t('Take profit and stop loss')} />
            <span>{t('Take profit and stop loss')}</span>
          </label>
          <label className="fx-check">
            <Checkbox checked={reduceOnly} onCheckedChange={(next) => setReduceOnly(next === true)} aria-label={t('Reduce only')} />
            <span>{t('Reduce only')}</span>
          </label>
        </div>
      ) : null}

      {action === 'open' && tpsl ? (
        <div className="fx-fields" data-testid="fx-tpsl">
          <AmountInput
            label={t('Take profit')}
            unit="USDT"
            value={tpText}
            onValueChange={setTpText}
            precision={tickPlaces}
            tick={contract.tick}
            placeholder={priceCell(contract.mark, contract.tick)}
          />
          <AmountInput
            label={t('Stop loss')}
            unit="USDT"
            value={slText}
            onValueChange={setSlText}
            precision={tickPlaces}
            tick={contract.tick}
            placeholder={priceCell(contract.mark, contract.tick)}
          />
          {bracket?.kind === 'check' ? (
            <p className="fx-hint fx-hint--warn">{t('Bracket check')}</p>
          ) : bracket ? (
            <dl className="fx-sum fx-sum--tight">
              {bracket.profit !== null ? (
                <div>
                  <dt>{t(bracket.kind === 'long' ? 'Profit at take profit (long)' : 'Profit at take profit (short)')}</dt>
                  <dd className={`fx-${tone(bracket.profit)}`}>{signedUsd(bracket.profit)}</dd>
                </div>
              ) : null}
              {bracket.loss !== null ? (
                <div>
                  <dt>{t(bracket.kind === 'long' ? 'Loss at stop loss (long)' : 'Loss at stop loss (short)')}</dt>
                  <dd className={`fx-${tone(bracket.loss)}`}>{signedUsd(bracket.loss)}</dd>
                </div>
              ) : null}
            </dl>
          ) : null}
        </div>
      ) : null}

      <dl className="fx-sum" data-testid="fx-summary">
        <div>
          <dt>{t('Available')}</dt>
          <dd>{usd(wallet)}</dd>
        </div>
        <div>
          <dt>{t('Order value')}</dt>
          <dd>{usd(value)}</dd>
        </div>
        {action === 'open' ? (
          <>
            <div>
              <dt>{t('Margin needed')}</dt>
              <dd>{usd(margin)}</dd>
            </div>
            <div>
              <dt>{t('Fee up to')}</dt>
              <dd>{usd(fee)}</dd>
            </div>
            <div>
              <dt>{t('Liquidation if long')}</dt>
              <dd data-testid="fx-liq-long">{liqLong === null ? t('None') : price(liqLong, contract.tick)}</dd>
            </div>
            <div>
              <dt>{t('Liquidation if short')}</dt>
              <dd data-testid="fx-liq-short">{liqShort === null ? t('None') : price(liqShort, contract.tick)}</dd>
            </div>
          </>
        ) : (
          <div>
            <dt>{t('Fee up to')}</dt>
            <dd>{usd(fee)}</dd>
          </div>
        )}
      </dl>
      {short ? (
        <p className="fx-hint fx-hint--warn" role="status">
          {t('Not enough balance')}
        </p>
      ) : null}

      <div className="fx-actions">
        <PreviewActionButton product="futures" variant="buy" shape="rounded" size={40} fullWidth>
          {action === 'open' ? t('Buy / Long') : t('Close long')}
        </PreviewActionButton>
        <PreviewActionButton product="futures" variant="sell" shape="rounded" size={40} fullWidth>
          {action === 'open' ? t('Sell / Short') : t('Close short')}
        </PreviewActionButton>
      </div>
      <p className="fx-hint">{t('Ticket risk')}</p>
    </section>
  );
}
