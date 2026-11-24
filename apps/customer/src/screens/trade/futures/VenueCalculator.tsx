import { useState } from 'react';
import { Button, Segmented } from '@intafaced/ui/lit';
import { DecimalInput, KeyValue } from '@intafaced/ui/lit/templates';
import { displayAmount } from '../../../shared/money';
import type { VenueMarket } from '../../../features/trade/venue-api';
import { TestMark } from '../../../features/trade/venue/VenueKit';
import { fractionDigits } from '../../../data/decimal';
import { calculateVenueMargin, type VenueCalcResult } from './venue-calculator-logic';
import { venueCalculatorCopy } from './venue-calculator-copy';
import { percentOf } from './venue-risk-logic';

/**
 * Standalone margin and P&L calculator on the venue futures desk (J-derivatives-02 #1). Computes margin, maintenance,
 * liquidation price, P&L, ROE and estimated fees solely from the venue's published rules, naming every formula. Sends
 * nothing to the venue and holds no margin.
 */
export function VenueCalculator({
  market,
  venueName,
  builderFeeBps,
  test,
}: {
  market: VenueMarket;
  venueName: string;
  builderFeeBps: string | null;
  test: boolean;
}) {
  const { t } = venueCalculatorCopy.useCopy();
  const [side, setSide] = useState<'long' | 'short'>('long');
  const [size, setSize] = useState('');
  const [entryPrice, setEntryPrice] = useState(market.mark.known ? market.mark.value : '');
  const [exitPrice, setExitPrice] = useState('');
  const [leverage, setLeverage] = useState('');
  const [shown, setShown] = useState<{ side: 'long' | 'short'; result: VenueCalcResult } | null>(null);

  const sizePlaces = Math.min(18, fractionDigits(market.lotSize) ?? 6);
  const pricePlaces = Math.min(18, fractionDigits(market.tickSize) ?? 2);
  const quote = market.quoteAsset;
  const candidate = calculateVenueMargin(market, { side, size, entryPrice, exitPrice, leverage }, builderFeeBps);

  const touch = () => setShown(null);
  const run = () => {
    if (!candidate) return;
    setShown({ side, result: candidate });
  };

  const money = (value: string | null, fallback: string) => (value === null ? fallback : `${displayAmount(value)} ${quote}`);
  const notPublished = t('Not published', { venue: venueName });
  const notEntered = t('Not entered');

  const formulas = (r: VenueCalcResult, s: 'long' | 'short'): string[] => {
    const lines = [t('Formula notional'), t('Formula initial margin')];
    if (r.tier) {
      lines.push(t('Formula maintenance tier', { tier: String(r.tier.index), rate: percentOf(r.tier.maintenanceRate), venue: venueName }));
      lines.push(s === 'long' ? t('Formula liquidation long') : t('Formula liquidation short'));
    } else if (r.maintenanceRate !== null) {
      lines.push(t('Formula maintenance flat', { rate: percentOf(r.maintenanceRate), venue: venueName }));
      lines.push(s === 'long' ? t('Formula liquidation long') : t('Formula liquidation short'));
    } else {
      lines.push(t('Formula maintenance unpublished', { venue: venueName }));
    }
    lines.push(s === 'long' ? t('Formula pnl long') : t('Formula pnl short'));
    lines.push(t('Formula roe'));
    if (market.takerFeeBps.known) {
      lines.push(
        builderFeeBps !== null
          ? t('Formula fees', { taker: market.takerFeeBps.value, builder: builderFeeBps })
          : t('Formula fees no builder', { taker: market.takerFeeBps.value }),
      );
    } else {
      lines.push(t('Formula fees unpublished', { venue: venueName }));
    }
    return lines;
  };

  return (
    <section aria-label={t('Heading')} data-testid="venue-calculator" className="lt-stack">
      <div>
        <h3 className="lt-panel-title">
          {t('Heading')} <TestMark test={test} />
        </h3>
        <p className="lt-note">{t('Intro', { venue: venueName })}</p>
      </div>
      <form
        className="lt-stack"
        onSubmit={(event) => {
          event.preventDefault();
          run();
        }}
      >
        <Segmented
          label={t('Direction')}
          value={side}
          onChange={(v) => {
            setSide(v as 'long' | 'short');
            touch();
          }}
          options={[
            { value: 'long', label: t('Long') },
            { value: 'short', label: t('Short') },
          ]}
        />
        <div className="lt-cols-2">
          <DecimalInput
            label={t('Size')}
            value={size}
            precision={sizePlaces}
            onValueChange={(v) => {
              setSize(v);
              touch();
            }}
            unit={market.baseAsset}
          />
          <DecimalInput
            label={t('Entry price')}
            value={entryPrice}
            precision={pricePlaces}
            onValueChange={(v) => {
              setEntryPrice(v);
              touch();
            }}
            unit={quote}
          />
          <DecimalInput
            label={t('Exit price')}
            value={exitPrice}
            precision={pricePlaces}
            onValueChange={(v) => {
              setExitPrice(v);
              touch();
            }}
            unit={quote}
          />
          <DecimalInput
            label={t('Leverage')}
            value={leverage}
            precision={2}
            onValueChange={(v) => {
              setLeverage(v);
              touch();
            }}
            unit="x"
          />
        </div>
        <div>
          <Button tone="primary" type="submit" disabled={candidate === null}>
            {t('Calculate')}
          </Button>
        </div>
      </form>

      {shown ? (
        <div aria-label={t('Results')} data-testid="venue-calculator-results" className="lt-stack-tight">
          <KeyValue
            rows={[
              { label: t('Notional'), value: money(shown.result.notional, notPublished) },
              { label: t('Initial margin'), value: money(shown.result.initialMargin, notPublished) },
              {
                label: t('Tier'),
                value: shown.result.tier
                  ? t('Tier value', {
                      tier: String(shown.result.tier.index),
                      maxLeverage: String(shown.result.tier.maxLeverageBps / 10_000),
                      rate: percentOf(shown.result.tier.maintenanceRate),
                    })
                  : t('Tier not published', { venue: venueName }),
              },
              { label: t('Maintenance margin'), value: money(shown.result.maintenanceMargin, notPublished) },
              { label: t('Liquidation price'), value: money(shown.result.liquidationPrice, notPublished) },
              { label: t('P&L at exit'), value: money(shown.result.pnl, notEntered) },
              {
                label: t('Return on margin'),
                value: shown.result.roePercent === null ? notEntered : `${displayAmount(shown.result.roePercent, 2)}%`,
              },
              {
                label: t('Estimated fees'),
                value: exitPrice.trim() === '' ? notEntered : money(shown.result.estimatedFees, notPublished),
              },
              {
                label: t('P&L after fees'),
                value: exitPrice.trim() === '' ? notEntered : money(shown.result.netPnl, notPublished),
              },
            ]}
          />
          {shown.result.leverageWarning ? (
            <p role="status" className="lt-callout lt-callout-bad" data-testid="venue-calculator-warning">
              {shown.result.leverageWarning.kind === 'tier'
                ? t('Leverage above tier', {
                    leverage: leverage.trim(),
                    venue: venueName,
                    tier: String(shown.result.leverageWarning.tier),
                    maxLeverage: shown.result.leverageWarning.maxLeverage,
                    symbol: market.symbol,
                  })
                : t('Leverage above market', {
                    leverage: leverage.trim(),
                    venue: venueName,
                    maxLeverage: shown.result.leverageWarning.maxLeverage,
                    symbol: market.symbol,
                  })}
            </p>
          ) : null}
          <h4 className="lt-strong lt-small">{t('Formulas heading')}</h4>
          <ul aria-label={t('Formulas list')} data-testid="venue-calculator-formulas" className="lt-list lt-note">
            {formulas(shown.result, shown.side).map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        </div>
      ) : null}
    </section>
  );
}
