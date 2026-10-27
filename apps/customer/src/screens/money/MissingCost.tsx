import { useState } from 'react';
import { moneyCopy } from './copy';
import { Amount, Button, fmtAmount, refusalCopy } from './deps';
import { lotsMissingCost, type LotBook, type LotBookLot, type MissingBasis } from './pnl-model';
import type { BasisOutcome } from './pnl-source';
import { dayIn, stamp } from './time';
import { usePreferences } from '../../shared/preferences';

type Copy = ReturnType<typeof moneyCopy.useCopy>;

/** The service's refusals for a customer price, in the screen's words; anything else goes through the shared refusal copy. */
const BASIS_REFUSAL: Record<string, 'Price invalid' | 'Note needed' | 'Day needed' | 'Basis ours' | 'Basis lot gone'> = {
  'tax.basis_price_unset': 'Price invalid',
  'tax.basis_price_invalid': 'Price invalid',
  'tax.basis_note_unset': 'Note needed',
  'tax.basis_date_unset': 'Day needed',
  'tax.basis_date_invalid': 'Day needed',
  'portfolio.basis_override_not_allowed': 'Basis ours',
  'tax.basis_lot_unknown': 'Basis lot gone',
};

export function basisRefusalWords(outcome: { code: string; unsure: boolean }, copy: Copy): string {
  if (outcome.unsure) return copy.t('Price unsure');
  const key = BASIS_REFUSAL[outcome.code];
  return key ? copy.t(key) : refusalCopy(outcome.code).title;
}

/** A positive decimal with a dot, as the service takes it. Checked here only to say so before sending; the service decides. */
const PRICE = /^\d+(\.\d+)?$/;

function BasisForm({
  lot,
  onSave,
  copy,
}: {
  lot: LotBookLot;
  onSave: (input: { pricePerUnit: string; date: string; sourceNote: string }) => Promise<BasisOutcome>;
  copy: Copy;
}) {
  const { t } = copy;
  const [price, setPrice] = useState('');
  const { timeZone } = usePreferences();
  // The day the screen shows for the lot, in the viewer's zone, so saving untouched keeps the day they read.
  const [day, setDay] = useState(() => dayIn(lot.acquiredAt, timeZone));
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const priceOk = PRICE.test(price.trim()) && /[1-9]/.test(price);
  const id = `basis-${lot.id}`;

  async function save() {
    if (busy) return;
    if (!priceOk) return setMessage(t('Price invalid'));
    if (note.trim() === '') return setMessage(t('Note needed'));
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || day > dayIn(new Date().toISOString(), timeZone)) return setMessage(t('Day needed'));
    setBusy(true);
    setMessage(null);
    // The day is the start of that day in UTC: the service keeps it as the day the coins were acquired.
    const result = await onSave({ pricePerUnit: price.trim(), date: `${day}T00:00:00.000Z`, sourceNote: note.trim() });
    setBusy(false);
    // A saved price takes the lot off this list, and the page says so above it; only a refusal is said here.
    if (!result.ok) setMessage(basisRefusalWords(result, copy));
  }

  return (
    <form
      data-testid="money-note-form"
      className="money-note-form"
      aria-label={t('Enter a cost for this lot')}
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
    >
      <p className="money-detail__note">{t('Basis our record')}</p>
      {lot.valuedAt !== null ? (
        <p className="money-detail__note">{t('Basis arrival hint', { value: `$${lot.valuedAt.usd}`, market: lot.valuedAt.market })}</p>
      ) : null}
      <label className="money-note-form__label" htmlFor={`${id}-price`}>
        {t('Price per coin', { asset: lot.assetId })}
      </label>
      <input
        id={`${id}-price`}
        className="money-note-form__input"
        inputMode="decimal"
        autoComplete="off"
        value={price}
        aria-invalid={price !== '' && !priceOk ? true : undefined}
        onChange={(event) => {
          setPrice(event.target.value);
          setMessage(null);
        }}
      />
      <label className="money-note-form__label" htmlFor={`${id}-day`}>
        {t('Day acquired')}
      </label>
      <input
        id={`${id}-day`}
        className="money-note-form__input"
        type="date"
        value={day}
        max={dayIn(new Date().toISOString(), timeZone)}
        onChange={(event) => {
          setDay(event.target.value);
          setMessage(null);
        }}
      />
      <label className="money-note-form__label" htmlFor={`${id}-note`}>
        {t('Price note')}
      </label>
      <input
        id={`${id}-note`}
        className="money-note-form__input"
        type="text"
        maxLength={200}
        autoComplete="off"
        value={note}
        onChange={(event) => {
          setNote(event.target.value);
          setMessage(null);
        }}
      />
      <div className="money-note-form__row">
        <Button type="submit" variant="primary" size={40} disabled={busy}>
          {t('Save price')}
        </Button>
      </div>
      <p className="money-detail__note" role="status">
        {message ?? ''}
      </p>
    </form>
  );
}

/**
 * Missing cost (PF-cost-basis-04): every open lot with no cost, named, with what it touches, and a way to enter the price
 * paid for it. Parts of sales that reached no lot at all are named too; they have no lot to enter a price for.
 */
export function MissingCost({
  book,
  missing,
  hidden,
  copy,
  onSave,
}: {
  book: LotBook;
  missing: MissingBasis;
  hidden: boolean;
  copy: Copy;
  onSave: (input: { lotId: string; pricePerUnit: string; date: string; sourceNote: string }) => Promise<BasisOutcome>;
}) {
  const { t } = copy;
  const { timeZone } = usePreferences();
  const [open, setOpen] = useState<string | null>(null);
  // Quantities inside a sentence follow hide balances too, as <Amount> does for a figure on its own.
  const masked = (qty: string) => (hidden ? '••••' : fmtAmount(qty));
  const lots = lotsMissingCost(missing);
  const noLot = missing.items.filter((item) => item.kind === 'disposal' && item.lotId === null);
  if (lots.length === 0 && noLot.length === 0) return null;
  return (
    <section data-testid="money-card" className="money-card" aria-label={t('Missing cost')}>
      <header data-testid="money-card__head" className="money-card__head">
        <h2>{t('Missing cost')}</h2>
      </header>
      <p data-testid="money-note" className="money-note">
        {t('Missing cost lead')}
      </p>
      <ul className="money-missing">
        {lots.map((item) => {
          const lot = book.lots.find((row) => row.id === item.lotId);
          const sales = missing.items.filter((other) => other.kind === 'disposal' && other.lotId === item.lotId);
          return (
            <li key={item.lotId} data-missing-lot={item.lotId}>
              <p>
                <strong>{item.assetId}</strong>{' '}
                {lot
                  ? t('Missing lot line', {
                      source: t(
                        lot.source === 'deposit' ? 'Source deposit' : lot.source === 'reward' ? 'Source reward' : 'Source other_in',
                      ),
                      time: stamp(lot.acquiredAt, timeZone),
                    })
                  : null}{' '}
                <Amount value={`${fmtAmount(item.qty)} ${item.assetId}`} hidden={hidden} /> {t('Missing lot left')}
              </p>
              {sales.map((sale, index) => (
                <p key={`${sale.saleTxId}:${index}`} data-testid="money-note" className="money-note" data-effect="unknown-share">
                  {t('Unknown share', { qty: `${masked(sale.qty)} ${sale.assetId}` })}
                </p>
              ))}
              {lot ? (
                open === lot.id ? (
                  <BasisForm lot={lot} copy={copy} onSave={(input) => onSave({ lotId: lot.id, ...input })} />
                ) : (
                  <Button type="button" variant="secondary" size={32} onClick={() => setOpen(lot.id)}>
                    {t('Enter a cost')}
                  </Button>
                )
              ) : null}
            </li>
          );
        })}
        {noLot.map((item, index) => (
          <li key={`no-lot:${item.saleTxId}:${item.assetId}:${index}`} data-effect="no-lot">
            <p>{t('Missing cost no lot', { qty: `${masked(item.qty)} ${item.assetId}` })}</p>
          </li>
        ))}
      </ul>
      <p data-testid="money-note" className="money-note">
        {t('Missing cost rule')}
      </p>
    </section>
  );
}
