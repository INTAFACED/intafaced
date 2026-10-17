import { Button, Field, Input, Select, SelectTrigger, SelectValue } from '@intafaced/ui';
import { deskCopy } from './desk-copy';

/**
 * The futures desk when the service lists no contract (Options does the same): every control the real desk has is
 * drawn, all disabled, and each one says the one real reason. Nothing here can be used or sent.
 */
export function EmptyDesk() {
  const { t } = deskCopy.useCopy();
  const why = t('Empty desk reason');
  const BOOK_ROWS = [0, 1, 2, 3, 4, 5] as const;
  return (
    <div data-testid="futures-empty-desk" className="flex min-w-0 flex-col">
      <section
        aria-label={t('Contract')}
        className="flex flex-wrap items-center gap-x-8 gap-y-2 border-b border-line px-(--if-gutter) py-3"
      >
        <Select disabled items={[]} value={null}>
          <SelectTrigger size={32} aria-label={t('Choose a contract')} className="min-w-44">
            <SelectValue>{t('No contract')}</SelectValue>
          </SelectTrigger>
        </Select>
        <span className="text-sm text-fg-2">{why}</span>
      </section>
      <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,1fr)_280px_360px]">
        <section
          aria-label={t('Chart')}
          className="flex min-h-72 flex-col items-center justify-center gap-1 border-b border-line p-4 text-center lg:border-b-0"
        >
          <p className="text-base font-medium text-fg">{t('Chart')}</p>
          <p className="text-sm text-fg-2">{why}</p>
        </section>
        <section aria-label={t('Order book')} className="border-line p-3 lg:border-l">
          <h2 className="mb-2 text-sm font-medium text-fg">{t('Order book')}</h2>
          <div className="grid grid-cols-2 gap-x-3 text-xs text-fg-3">
            <span>{t('Price')}</span>
            <span className="text-right">{t('Size')}</span>
            {BOOK_ROWS.map((row) => (
              <span key={row} className="col-span-2 grid grid-cols-2 border-b border-line py-1" aria-hidden="true">
                <span>—</span>
                <span className="text-right">—</span>
              </span>
            ))}
          </div>
          <p className="mt-2 text-xs text-fg-2">{why}</p>
        </section>
        <aside aria-label={t('Ticket')} className="flex flex-col gap-3 border-line p-3 lg:border-l">
          <div className="grid grid-cols-2 gap-2">
            <Button variant="secondary" size={40} disabled>
              {t('Long')}
            </Button>
            <Button variant="secondary" size={40} disabled>
              {t('Short')}
            </Button>
          </div>
          <Field label={t('Size')} hint={why} disabled>
            <Input kind="decimal" value="" precision={2} onValueChange={() => undefined} disabled />
          </Field>
          <Field label={t('Leverage')} hint={why} disabled>
            <Input kind="decimal" value="" precision={2} onValueChange={() => undefined} trailing="x" disabled />
          </Field>
          <Field label={t('Take profit')} hint={why} disabled>
            <Input kind="decimal" value="" precision={2} onValueChange={() => undefined} disabled />
          </Field>
          <Field label={t('Stop loss')} hint={why} disabled>
            <Input kind="decimal" value="" precision={2} onValueChange={() => undefined} disabled />
          </Field>
          <Button variant="primary" size={40} disabled>
            {t('Open position')}
          </Button>
          <p className="text-xs text-fg-2">{why}</p>
        </aside>
      </div>
    </div>
  );
}
