import { useRef, useState } from 'react';
import { Button, Segmented, StateBlock } from '@intafaced/ui/lit';
import { DecimalInput, KeyValue } from '@intafaced/ui/lit/templates';
import { fractionDigits, isPositive } from '../../../data/decimal';
import { fmtAmount, fmtPctPoints, fmtPrice } from '../../../data/format';
import type { CalculatorInput, CalculatorResult, FuturesListing } from './api';
import { useFuturesApi } from './data';
import { futuresRefusal, type FuturesRefusal } from './refusals';
import { riskCopy } from './risk-copy';
import { sizePlaces } from './ticket-logic';
import { kvRows } from './kv-rows';
import { RegionNote } from './notes';

type Result =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'error' }
  | { status: 'refused'; refusal: FuturesRefusal }
  | { status: 'ready'; data: CalculatorResult };

/** The order the formulas are listed in, matching the figures above them. */
const FORMULA_ORDER = ['notional', 'initialMargin', 'tier', 'maintenanceMargin', 'liquidationPrice', 'pnl', 'roe', 'fee'] as const;

/**
 * The standalone margin and P&L calculator (D-account-04, D-margin-03): the service works the figures out with the
 * preview's and the ladder's own functions for the numbers typed here. Nothing is placed, held or stored.
 */
export function CalculatorTab({ market }: { market: FuturesListing | null }) {
  const { t } = riskCopy.useCopy();
  const api = useFuturesApi();
  const [side, setSide] = useState<'long' | 'short'>('long');
  const [size, setSize] = useState('');
  const [entry, setEntry] = useState('');
  const [exit, setExit] = useState('');
  const [leverage, setLeverage] = useState('');
  const [result, setResult] = useState<Result>({ status: 'idle' });
  const request = useRef(0);

  if (!market) return <RegionNote title={t('Calc heading')} reason={t('Calc intro')} />;
  const quote = market.settle ?? market.quote;
  const pricePlaces = fractionDigits(market.precision.price) ?? 2;
  const ready = isPositive(size) && isPositive(entry) && isPositive(leverage) && (exit === '' || isPositive(exit));

  async function run() {
    if (!market || !ready) return;
    const id = ++request.current;
    setResult({ status: 'loading' });
    const input: CalculatorInput = { symbol: market.symbol, side, size, entryPrice: entry, leverage, ...(exit ? { exitPrice: exit } : {}) };
    const answer = await api.calculate(input);
    if (id !== request.current) return;
    if (answer.ok) setResult({ status: 'ready', data: answer.data });
    // A typed 4xx is the service's answer about these inputs (a 400 arrives with the reason "error"): show its words.
    else if (answer.code && answer.status !== undefined && answer.status >= 400 && answer.status < 500)
      setResult({ status: 'refused', refusal: futuresRefusal(answer) });
    else if (answer.reason === 'uncertain' || answer.reason === 'unreachable' || answer.reason === 'error') setResult({ status: 'error' });
    else setResult({ status: 'refused', refusal: futuresRefusal(answer) });
  }
  // A changed input clears the answer: a figure on screen always belongs to the numbers above it.
  const touch = () => {
    request.current += 1;
    setResult({ status: 'idle' });
  };
  const money = (value: string | null) => (value === null ? null : `${fmtAmount(value, { places: 8 })} ${quote}`);
  const price = (value: string | null) => (value === null ? null : `${fmtPrice(value, market.precision.price)} ${quote}`);

  return (
    <section aria-label={t('Calc heading')} className="lt-stack">
      <div>
        <h3 className="lt-panel-title">{t('Calc heading')}</h3>
        <p className="lt-note">{t('Calc intro')}</p>
      </div>
      <form
        className="lt-stack"
        onSubmit={(event) => {
          event.preventDefault();
          void run();
        }}
      >
        <Segmented
          label={t('Calc side')}
          value={side}
          onChange={(v) => {
            setSide(v);
            touch();
          }}
          options={[
            { value: 'long', label: t('Calc long') },
            { value: 'short', label: t('Calc short') },
          ]}
        />
        <div className="lt-cols-2">
          <DecimalInput
            label={t('Calc size')}
            value={size}
            precision={sizePlaces(market)}
            onValueChange={(v) => {
              setSize(v);
              touch();
            }}
            unit={market.base}
          />
          <DecimalInput
            label={t('Calc entry')}
            value={entry}
            precision={pricePlaces}
            onValueChange={(v) => {
              setEntry(v);
              touch();
            }}
            unit={quote}
          />
          <DecimalInput
            label={t('Calc exit')}
            value={exit}
            precision={pricePlaces}
            onValueChange={(v) => {
              setExit(v);
              touch();
            }}
            unit={quote}
          />
          <DecimalInput
            label={t('Calc leverage')}
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
          <Button tone="primary" type="submit" disabled={!ready || result.status === 'loading'}>
            {result.status === 'loading' ? t('Calc running') : t('Calc run')}
          </Button>
        </div>
      </form>

      {result.status === 'error' ? (
        <StateBlock kind="error" title={t('Calc error')} onRetry={() => void run()} retryLabel={t('Calc run')} />
      ) : null}
      {result.status === 'refused' ? (
        <RegionNote variant="refused" title={result.refusal.title} reason={result.refusal.body} code={result.refusal.code ?? undefined} />
      ) : null}
      {result.status === 'ready' ? (
        <div aria-label={t('Calc results')} className="lt-stack-tight">
          <KeyValue
            rows={kvRows(
              [
                { label: t('Calc notional'), value: money(result.data.notional) },
                { label: t('Calc initial margin'), value: money(result.data.initialMargin) },
                { label: t('Calc tier'), value: result.data.tier === null ? null : String(result.data.tier) },
                { label: t('Calc maintenance'), value: money(result.data.maintenanceMargin) },
                { label: t('Calc liquidation'), value: price(result.data.liquidationPrice) },
                { label: t('Calc pnl'), value: money(result.data.pnl) },
                {
                  label: t('Calc roe'),
                  value: result.data.roePercent === null ? null : fmtPctPoints(result.data.roePercent, { places: 2 }),
                },
                { label: t('Calc entry fee'), value: money(result.data.entryFee) },
                { label: t('Calc exit fee'), value: money(result.data.exitFee) },
                { label: t('Calc net pnl'), value: money(result.data.netPnl) },
              ],
              t('Unknown figure'),
            )}
          />
          {result.data.refusals.map((r) => {
            // The words come from the screen's own copy, never the service's message, which is for operators.
            const words = futuresRefusal({ code: r.code });
            return (
              <p key={`${r.code}:${r.field}`} role="status" className="lt-note lt-note-warn" data-code={r.code}>
                {words.title}. {words.body}
              </p>
            );
          })}
          <p className="lt-note">{t('Calc basis')}</p>
          <h4 className="lt-strong lt-small">{t('Calc formulas')}</h4>
          <ul aria-label={t('Calc formulas list')} className="lt-list lt-note">
            {FORMULA_ORDER.filter((key) => result.data.formulas[key]).map((key) => (
              <li key={key}>{result.data.formulas[key]}</li>
            ))}
          </ul>
        </div>
      ) : null}
    </section>
  );
}
