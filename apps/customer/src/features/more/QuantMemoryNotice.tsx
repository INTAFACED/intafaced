import { defineCopy } from '../../shared/i18n';
import './support-desk.css';

const en = {
  title: 'Saving to a library is off on this service',
  body: 'Your draft stays on this device.',
  next: 'Keep your strategy source somewhere you control.',
} as const;
const es = {
  title: 'Guardar en una biblioteca está desactivado en este servicio',
  body: 'Tu borrador se queda en este dispositivo.',
  next: 'Guarda el código de tu estrategia en un lugar que controles.',
} satisfies Record<keyof typeof en, string>;
const fr = {
  title: 'L’enregistrement dans une bibliothèque est désactivé sur ce service',
  body: 'Ton brouillon reste sur cet appareil.',
  next: 'Conserve le code de ta stratégie dans un endroit que tu maîtrises.',
} satisfies Record<keyof typeof en, string>;
export const quantMemoryCopy = defineCopy('quant-memory', en, { es, fr });

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
