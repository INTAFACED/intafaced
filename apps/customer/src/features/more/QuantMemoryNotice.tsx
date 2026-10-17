import { defineCopy } from '../../shared/i18n';
import './support-desk.css';

// English source only.
export const quantMemoryCopy = defineCopy('quant-memory', {
  title: 'Saving to the library is switched off',
  body: 'Saved strategies are not private to your account yet: everyone using this service shares one library, a restart erases it, and there is no version history. Until each account has its own storage, nothing you build here is saved to it. Your draft stays on this device.',
  next: 'Keep your strategy source somewhere you control.',
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
