import { defineCopy } from '../../shared/i18n';

const en = {
  save: 'Save to library',
  reason: 'Saved strategies are not private to your account yet, so drafts stay on this device.',
  libraryTitle: 'Strategy library',
  libraryClosed: 'Saved strategies are not private to accounts yet, so the shared library is closed.',
  draftNote: 'Your draft is kept in this browser only. Clear this site’s data and it is gone.',
} as const;
const es = {
  save: 'Guardar en la biblioteca',
  reason: 'Las estrategias guardadas aún no son privadas de tu cuenta, así que los borradores se quedan en este dispositivo.',
  libraryTitle: 'Biblioteca de estrategias',
  libraryClosed: 'Las estrategias guardadas aún no son privadas por cuenta, así que la biblioteca compartida está cerrada.',
  draftNote: 'Tu borrador se guarda solo en este navegador. Si borras los datos del sitio, desaparece.',
} satisfies Record<keyof typeof en, string>;
const fr = {
  save: 'Enregistrer dans la bibliothèque',
  reason: 'Les stratégies enregistrées ne sont pas encore privées à ton compte : les brouillons restent donc sur cet appareil.',
  libraryTitle: 'Bibliothèque de stratégies',
  libraryClosed: 'Les stratégies enregistrées ne sont pas encore privées par compte : la bibliothèque partagée est donc fermée.',
  draftNote: 'Ton brouillon n’est conservé que dans ce navigateur. Si tu effaces les données du site, il disparaît.',
} satisfies Record<keyof typeof en, string>;
export const quantDraftCopy = defineCopy('more.quant.draft', en, { es, fr });
