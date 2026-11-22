import { Button } from '@intafaced/ui/lit';
import { DecimalInput, Select } from '@intafaced/ui/lit/templates';
import { deskCopy } from './desk-copy';

const none = () => undefined;

/**
 * The futures desk when the service lists no contract (Options does the same): every control the real desk has is
 * drawn, all disabled, and each one says the one real reason. Nothing here can be used or sent.
 */
export function EmptyDesk() {
  const { t } = deskCopy.useCopy();
  const why = t('Empty desk reason');
  const BOOK_ROWS = [0, 1, 2, 3, 4, 5] as const;
  return (
    <div data-testid="futures-empty-desk" className="lt-stack">
      <section aria-label={t('Contract')} className="lt-row">
        <Select disabled label={t('Choose a contract')} options={[]} value="" placeholder={t('No contract')} />
        <span className="lt-note">{why}</span>
      </section>
      <div className="lt-cols-3">
        <section aria-label={t('Chart')} className="lt-panel">
          <p className="lt-strong">{t('Chart')}</p>
          <p className="lt-note">{why}</p>
        </section>
        <section aria-label={t('Order book')} className="lt-panel">
          <h2 className="lt-panel-title">{t('Order book')}</h2>
          <div className="lt-stack-tight lt-tight lt-note">
            <span className="lt-cols-2">
              <span>{t('Price')}</span>
              <span className="lt-end">{t('Size')}</span>
            </span>
            {BOOK_ROWS.map((row) => (
              <span key={row} className="lt-cols-2" aria-hidden="true">
                <span>—</span>
                <span className="lt-end">—</span>
              </span>
            ))}
          </div>
          <p className="lt-note">{why}</p>
        </section>
        <aside aria-label={t('Ticket')} className="lt-panel">
          <div className="lt-cols-2">
            <Button tone="secondary" disabled>
              {t('Long')}
            </Button>
            <Button tone="secondary" disabled>
              {t('Short')}
            </Button>
          </div>
          <DecimalInput label={t('Size')} hint={why} value="" precision={2} onValueChange={none} disabled />
          <DecimalInput label={t('Leverage')} hint={why} value="" precision={2} onValueChange={none} unit="x" disabled />
          <DecimalInput label={t('Take profit')} hint={why} value="" precision={2} onValueChange={none} disabled />
          <DecimalInput label={t('Stop loss')} hint={why} value="" precision={2} onValueChange={none} disabled />
          <Button tone="primary" disabled>
            {t('Open position')}
          </Button>
          <p className="lt-note">{why}</p>
        </aside>
      </div>
    </div>
  );
}
