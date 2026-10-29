/**
 * The words for the developer models' states, shared by the pages (DocsPages.tsx) and their markdown variants
 * (developers-markdown.ts), so both say the same thing about the same row.
 */
import type { docsCopy } from './developers-docs-copy';
import type { ConnectivityOption, ConnectivityState, DATA_TERMS } from './developers-model';

type DocsT = ReturnType<typeof docsCopy.forLocale>['t'];

export const connectivityStateLabel = (t: DocsT, state: ConnectivityState) =>
  state === 'available' ? t('statusAvailable') : state === 'host_unset' ? t('statusHostUnset') : t('parkedHardware');

export const connectivityEndpointsLabel = (t: DocsT, option: ConnectivityOption) =>
  option === 'internet' ? t('endpointsProduction') : option === 'redundant' ? t('endpointsRegional') : t('endpointsNone');

const TERM_COLUMN = {
  entitlement: 'colEntitlement',
  redistribution: 'colRedistribution',
  retention: 'colRetention',
  privacy: 'colPrivacy',
  commercial: 'colCommercial',
} as const satisfies Record<(typeof DATA_TERMS)[number], string>;

export const dataTermLabel = (t: DocsT, term: (typeof DATA_TERMS)[number]) => t(TERM_COLUMN[term]);
