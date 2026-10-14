import { PreviewChip } from '../../../preview';
import type { PerpBookLevel, PerpContract } from '../../../preview/fixtures/futures';
import { futuresCopy } from './copy';
import { barPercent, d } from './math';
import { price, priceCell, size } from './show';

const ROWS = 9;

interface Row {
  readonly price: string;
  readonly size: string;
  readonly total: string;
  readonly depth: number;
}

/** Cumulative totals and depth bars for one side. `levels` run from the best price outward. */
function rows(levels: readonly PerpBookLevel[], contract: PerpContract, widest: bigint): Row[] {
  let running = 0n;
  return levels.slice(0, ROWS).map((level) => {
    const amount = d(level.size);
    running += amount;
    return {
      price: priceCell(level.price, contract.tick),
      size: size(level.size, contract.lot),
      total: size(running, contract.lot),
      depth: barPercent(running, widest),
    };
  });
}

function total(levels: readonly PerpBookLevel[]): bigint {
  return levels.slice(0, ROWS).reduce((sum, level) => sum + d(level.size), 0n);
}

export function Book({ contract }: { contract: PerpContract }) {
  const { t } = futuresCopy.useCopy();
  const widest = [total(contract.asks), total(contract.bids)].reduce((a, b) => (a > b ? a : b));
  const asks = rows(contract.asks, contract, widest).reverse();
  const bids = rows(contract.bids, contract, widest);
  const up = !contract.change24h.startsWith('-');
  return (
    <section className="fx-panel fx-book" aria-labelledby="fx-book-title">
      <header className="fx-panel__head">
        <h2 className="fx-panel__title" id="fx-book-title">
          {t('Order book')} <PreviewChip />
        </h2>
      </header>
      <table className="fx-book__table">
        <caption className="fx-sr">{t('Book caption', { contract: contract.id })}</caption>
        <thead>
          <tr>
            <th scope="col">{t('Price (USDT)')}</th>
            <th scope="col">{t('Size', { coin: contract.base })}</th>
            <th scope="col">{t('Total', { coin: contract.base })}</th>
          </tr>
        </thead>
        <tbody className="fx-book__asks">
          {asks.map((row) => (
            <tr key={row.price} style={{ ['--fx-depth' as string]: `${row.depth}%` }}>
              <td className="fx-down">{row.price}</td>
              <td>{row.size}</td>
              <td>{row.total}</td>
            </tr>
          ))}
        </tbody>
        <tbody>
          <tr className="fx-book__mid">
            <td colSpan={3}>
              <span className={up ? 'fx-book__last fx-up' : 'fx-book__last fx-down'}>{price(contract.last, contract.tick)}</span>
              <span className="fx-book__mark">
                {t('Mark')} {price(contract.mark, contract.tick)}
              </span>
            </td>
          </tr>
        </tbody>
        <tbody className="fx-book__bids">
          {bids.map((row) => (
            <tr key={row.price} className="fx-book__bid" style={{ ['--fx-depth' as string]: `${row.depth}%` }}>
              <td className="fx-up">{row.price}</td>
              <td>{row.size}</td>
              <td>{row.total}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}
