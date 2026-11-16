import { defineCopy } from '../shared/i18n';
import { publicCopy } from './rooms/public';
import { homeCopy } from './rooms/home';
import { moneyCopy } from './rooms/money';
import { tradeCopy } from './rooms/trade';
import { payCopy } from './rooms/pay';
import { moreCopy } from './rooms/more';
import { personCopy } from './rooms/person';
import { teamCopy } from './rooms/team';
import { web3Copy } from './rooms/web3';

// Explicit authored room labels only; route IDs and API content never enter this catalog.
// Each area's room labels live beside its rows, as `<area>Copy` in rooms/<area>.ts: one shared file of every label was
// edited by 16 merged PRs in 7 days (project-state #2617). This file keeps only the labels no single area owns (used by
// rooms of more than one area, or by none) and joins every area's into the one catalog (rooms/rooms.test.ts).
export const sharedNavigationCopy = {
  en: {
    'API keys': 'API keys',
    Home: 'Home',
    Approvals: 'Approvals',
    Activity: 'Activity',
    'Business bank': 'Business bank',
    'Company cash accounts': 'Company cash accounts',
    'Cross or isolated trading': 'Cross or isolated trading',
    Bill: 'Bill',
    Security: 'Security',
    'Business verification': 'Business verification',
    Inbox: 'Inbox',
    Sandbox: 'Sandbox',
    Quant: 'Quant',
    'Research and strategy sandbox': 'Research and strategy sandbox',
  },
  es: {
    Home: 'Inicio',
    Approvals: 'Aprobaciones',
    Activity: 'Actividad',
    'Business bank': 'Banco de empresa',
    'Company cash accounts': 'Cuentas de efectivo de la empresa',
    'Cross or isolated trading': 'Operaciones con margen cruzado o aislado',
    Bill: 'Factura',
    Security: 'Seguridad',
    'Business verification': 'Verificación de empresa',
    Inbox: 'Bandeja de entrada',
    Quant: 'Quant',
    'Research and strategy sandbox': 'Entorno de investigación y pruebas de estrategias',
  },
  fr: {
    Home: 'Accueil',
    Approvals: 'Approbations',
    Activity: 'Activité',
    'Business bank': 'Banque d’entreprise',
    'Company cash accounts': 'Comptes de trésorerie de l’entreprise',
    'Cross or isolated trading': 'Négociation en marge croisée ou isolée',
    Bill: 'Facture',
    Security: 'Sécurité',
    'Business verification': 'Vérification de l’entreprise',
    Inbox: 'Boîte de réception',
    Quant: 'Quant',
    'Research and strategy sandbox': 'Environnement de recherche et de test des stratégies',
  },
} as const;

const parts = [
  sharedNavigationCopy,
  publicCopy,
  homeCopy,
  moneyCopy,
  tradeCopy,
  payCopy,
  moreCopy,
  personCopy,
  teamCopy,
  web3Copy,
] as const;
/** Each label has one home: a key written in two parts would let one silently win over the other. */
function oneHome(): void {
  const seen = new Map<string, number>();
  parts.forEach((part, i) => {
    for (const key of Object.keys(part.en)) {
      if (seen.has(key))
        throw new Error(
          `Navigation label ${JSON.stringify(key)} is written in two places (parts ${seen.get(key)} and ${i}); keep it in one`,
        );
      seen.set(key, i);
    }
  });
}
oneHome();

const messages = {
  ...sharedNavigationCopy.en,
  ...publicCopy.en,
  ...homeCopy.en,
  ...moneyCopy.en,
  ...tradeCopy.en,
  ...payCopy.en,
  ...moreCopy.en,
  ...personCopy.en,
  ...teamCopy.en,
  ...web3Copy.en,
};

export const navigationCopy: ReturnType<typeof defineCopy<typeof messages>> = defineCopy('customer.navigation', messages, {
  es: {
    ...sharedNavigationCopy.es,
    ...publicCopy.es,
    ...homeCopy.es,
    ...moneyCopy.es,
    ...tradeCopy.es,
    ...payCopy.es,
    ...moreCopy.es,
    ...personCopy.es,
    ...teamCopy.es,
    ...web3Copy.es,
  },
  fr: {
    ...sharedNavigationCopy.fr,
    ...publicCopy.fr,
    ...homeCopy.fr,
    ...moneyCopy.fr,
    ...tradeCopy.fr,
    ...payCopy.fr,
    ...moreCopy.fr,
    ...personCopy.fr,
    ...teamCopy.fr,
    ...web3Copy.fr,
  },
});
export type NavigationCopyKey = Parameters<typeof navigationCopy.t>[0];
/** A label more than one area uses, or none: any area's row may take it. */
export type SharedNavigationCopyKey = keyof typeof sharedNavigationCopy.en;
