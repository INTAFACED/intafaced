import { defineCopy } from '../../shared/i18n';
import './support-desk.css';

// English source only.
export const quantMemoryCopy = defineCopy('quant-memory', {
  title: 'Strategies are kept in memory only',
  body: 'Saved strategies live in the quant service’s memory. They are lost when that service restarts, the catalogue is shared rather than private to your account, and there is no version history. Keep your strategy source somewhere you control.',
  next: 'Lasting, private storage for each account needs a database behind the quant service. That is not connected, so nothing here is saved to your account.',
});

export function QuantMemoryNotice() {
  const copy = quantMemoryCopy.useCopy();
  return (
    <div className="support-warning" role="note" lang={copy.languageFor('title')}>
      <strong>{copy.t('title')}</strong>
      <p>{copy.t('body')}</p>
      <p className="muted">{copy.t('next')}</p>
    </div>
  );
}
