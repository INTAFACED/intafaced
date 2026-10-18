import { defineCopy } from '../../shared/i18n';

const en = {
  save: 'Save to library',
  reason: 'Saving to a library is off on this service. Your draft stays on this device.',
  libraryTitle: 'Strategy library',
  libraryClosed: 'Saving to a library is off on this service, so the library is closed.',
  draftNote: 'It is kept in this browser only. Clear this site’s data and it is gone.',
} as const;
const es = {
  save: 'Guardar en la biblioteca',
  reason: 'Guardar en una biblioteca está desactivado en este servicio. Tu borrador se queda en este dispositivo.',
  libraryTitle: 'Biblioteca de estrategias',
  libraryClosed: 'Guardar en una biblioteca está desactivado en este servicio, así que la biblioteca está cerrada.',
  draftNote: 'Se guarda solo en este navegador. Si borras los datos del sitio, desaparece.',
} satisfies Record<keyof typeof en, string>;
const fr = {
  save: 'Enregistrer dans la bibliothèque',
  reason: 'L’enregistrement dans une bibliothèque est désactivé sur ce service. Ton brouillon reste sur cet appareil.',
  libraryTitle: 'Bibliothèque de stratégies',
  libraryClosed: 'L’enregistrement dans une bibliothèque est désactivé sur ce service ; la bibliothèque est donc fermée.',
  draftNote: 'Il n’est conservé que dans ce navigateur. Si tu effaces les données du site, il disparaît.',
} satisfies Record<keyof typeof en, string>;
export const quantDraftCopy = defineCopy('more.quant.draft', en, { es, fr });
