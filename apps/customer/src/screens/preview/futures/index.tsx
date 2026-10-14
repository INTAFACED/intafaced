import { useMemo, useState } from 'react';
import { SegmentedControl } from '@intafaced/ui';
import type { ScreenProps } from '../../../app/screen-types';
import { PreviewScreen } from '../../../preview';
import { futuresFixture, type PerpId } from '../../../preview/fixtures/futures';
import { Book } from './Book';
import { Chart, type ChartLine } from './Chart';
import { Positions } from './Positions';
import { Ticket } from './Ticket';
import { futuresCopy } from './copy';
import { d, liquidationPrice } from './math';
import { pct, pctPlain, price, usd } from './show';
import './futures.css';

/**
 * Futures Preview: a perpetual-contracts desk in the shape of the pro exchanges, drawn from SAMPLE data only. Nothing here reads the
 * API client; every action opens the shared "nothing was sent" sheet. Futures safety checks are still to be ported (issue 4717), so
 * this screen says plainly that futures are not open and carries sober risk wording.
 */
export default function FuturesPreview(_props: ScreenProps) {
  const { t } = futuresCopy.useCopy();
  const rows = futuresFixture.rows;
  const [id, setId] = useState<PerpId>('BTC-USDT');
  const contract = rows.contracts.find((c) => c.id === id)!;
  const position = rows.positions.find((p) => p.contract === id) ?? null;

  const lines = useMemo<ChartLine[]>(() => {
    const out: ChartLine[] = [{ id: 'mark', price: d(contract.mark) }];
    if (position) {
      out.push({ id: 'entry', price: d(position.entry) });
      const liq = liquidationPrice({
        side: position.side,
        size: d(position.size),
        entry: d(position.entry),
        margin: d(position.margin),
        maintenanceMargin: d(contract.maintenanceMargin),
        extra: position.mode === 'cross' ? d(rows.available) : 0n,
      });
      if (liq !== null) out.push({ id: 'liq', price: liq });
    }
    return out;
  }, [contract, position, rows.available]);

  const rate = d(contract.fundingRate);
  const up = !contract.change24h.startsWith('-');
  const stats: ReadonlyArray<readonly [string, string, string?]> = [
    [t('Mark'), price(contract.mark, contract.tick)],
    [t('Index'), price(contract.index, contract.tick)],
    [t('Funding rate'), pct(contract.fundingRate, 4), contract.fundingCountdown],
    [t('24h high'), price(contract.high24h, contract.tick)],
    [t('24h low'), price(contract.low24h, contract.tick)],
    [t('24h volume'), usd(contract.volume24h, { compact: true })],
    [t('Open interest'), usd(contract.openInterest, { compact: true })],
  ];

  return (
    <PreviewScreen product="futures">
      <div className="fx">
        <section className="fx-ribbon" aria-label={t('Contract summary')}>
          <div className="fx-ribbon__pick">
            <SegmentedControl
              aria-label={t('Contract')}
              size={32}
              value={id}
              onValueChange={(next) => setId(next as PerpId)}
              items={rows.contracts.map((c) => ({ value: c.id, label: c.base }))}
            />
            <div>
              <p className="fx-ribbon__name">{t('Perpetual name', { contract: contract.id })}</p>
              <p className="fx-ribbon__last">
                <span className={up ? 'fx-up' : 'fx-down'} data-testid="fx-last">
                  {price(contract.last, contract.tick)}
                </span>{' '}
                <span className={up ? 'fx-up' : 'fx-down'}>{pct(contract.change24h)}</span>
              </p>
            </div>
          </div>
          <dl className="fx-ribbon__stats">
            {stats.map(([label, value, extra]) => (
              <div key={label}>
                <dt>{label}</dt>
                <dd>
                  {value}
                  {extra ? <span className="fx-ribbon__extra">{extra}</span> : null}
                </dd>
              </div>
            ))}
          </dl>
        </section>
        <p className="fx-funding" data-testid="fx-funding-note">
          {t(rate >= 0n ? 'Funding note (longs pay)' : 'Funding note (shorts pay)', {
            hours: contract.fundingHours,
            rate: pctPlain(rate < 0n ? -rate : rate, 4),
          })}
        </p>

        <div className="fx-grid">
          <Chart contract={contract} lines={lines} />
          <Book contract={contract} />
          <Ticket key={contract.id} contract={contract} available={rows.available} position={position} />
        </div>

        <Positions rows={rows} onPick={setId} />

        <section className="fx-risk" aria-labelledby="fx-risk-title">
          <h2 id="fx-risk-title">{t('Risk title')}</h2>
          <p>{t('Risk body')}</p>
        </section>
      </div>
    </PreviewScreen>
  );
}
