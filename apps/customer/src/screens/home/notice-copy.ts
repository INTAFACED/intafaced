import { defineCopy } from '../../shared/i18n';

/** The announcement strip's own words (HM-widgets-03), apart from Home's copy so the strip's slice edits only its own file. */
const messages = {
  'Notice strip unset': 'Latest announcements: how many to show is not set.',
} as const;

export const noticeCopy: ReturnType<typeof defineCopy<typeof messages>> = defineCopy('customer.home.notices', messages, {
  es: { 'Notice strip unset': 'Últimos anuncios: no está establecido cuántos mostrar.' },
  fr: { 'Notice strip unset': 'Dernières annonces : le nombre à afficher n’est pas défini.' },
});
