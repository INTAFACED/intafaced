/**
 * Price-line overlays on the chart: a form that adds one labelled line at a typed price, and the list of lines on this
 * market. A refused price names its reason and adds nothing; a removed line is gone from the chart at once.
 */
import { useState, type FormEvent } from 'react';
import { chartsCopy } from './copy';
import { checkPriceLine, PRICE_LABEL_LIMIT, type PriceLine } from './price-lines';

export function PriceLines({
  lines,
  tickSize,
  onChange,
  open,
}: {
  lines: readonly PriceLine[];
  tickSize: string;
  onChange: (next: PriceLine[]) => void;
  open: boolean;
}) {
  const { t } = chartsCopy.useCopy();
  const [refusal, setRefusal] = useState<string | null>(null);

  const add = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const checked = checkPriceLine(String(form.get('price') ?? ''), tickSize);
    if (!checked.ok) {
      setRefusal(
        checked.reason === 'blank'
          ? t('Price line blank')
          : checked.reason === 'tick-unset'
            ? t('Price line tick unset')
            : checked.reason === 'off-tick'
              ? t('Price line off tick', { tick: tickSize })
              : t('Price line not positive'),
      );
      return;
    }
    const label = String(form.get('label') ?? '')
      .trim()
      .slice(0, PRICE_LABEL_LIMIT);
    onChange([...lines, { id: `${Date.now()}-${lines.length}`, price: checked.price, label: label || checked.price }]);
    setRefusal(null);
    event.currentTarget.reset();
  };

  if (!open && lines.length === 0) return null;
  return (
    <div className="cw-lines" data-testid="price-lines">
      {open && (
        <form className="cw-date" onSubmit={add} aria-label={t('Price line title')}>
          <label className="cw-select cw-select--inline">
            <span>{t('Price line price')}</span>
            <input name="price" type="text" inputMode="decimal" autoComplete="off" aria-describedby="cw-price-line-tick" />
          </label>
          <label className="cw-select cw-select--inline">
            <span>{t('Price line label')}</span>
            <input name="label" type="text" maxLength={PRICE_LABEL_LIMIT} autoComplete="off" />
          </label>
          <button type="submit">{t('Price line add')}</button>
          <span id="cw-price-line-tick" className="cw-lines-tick">
            {t('Price line off tick', { tick: tickSize })}
          </span>
        </form>
      )}
      {refusal && (
        <p className="cw-note" role="status" data-code="trade.chart.price_line_refused">
          {refusal}
        </p>
      )}
      {lines.length === 0 ? (
        <p className="cw-lines-none">{t('Price line none')}</p>
      ) : (
        <ul className="cw-lines-list" aria-label={t('Price lines')}>
          {lines.map((line) => (
            <li key={line.id} data-price={line.price}>
              <span>{t('Price line item', { label: line.label, price: line.price })}</span>
              <button
                type="button"
                aria-label={t('Price line remove', { price: line.price })}
                onClick={() => onChange(lines.filter((row) => row.id !== line.id))}
              >
                ×
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
