import { defineCopy } from '../../shared/i18n';

// The P2P rooms' registry blocker (`feature-registry.ts`, row `p2p`): the owner's instrument encryption provider.
const en = {
  title: 'Payment details protection',
  localTest:
    'Payment details on this stack are sealed with a TEST key. Live ads need the owner’s instrument encryption provider, which is not connected.',
  none: 'New payment details and new ads need the owner’s instrument encryption provider, which is not connected.',
} as const;
const es = {
  title: 'Protección de los datos de pago',
  localTest:
    'Los datos de pago de este entorno se sellan con una clave TEST. Los anuncios reales necesitan el proveedor de cifrado de instrumentos del propietario, que no está conectado.',
  none: 'Los nuevos datos de pago y los nuevos anuncios necesitan el proveedor de cifrado de instrumentos del propietario, que no está conectado.',
} satisfies Record<keyof typeof en, string>;
const fr = {
  title: 'Protection des coordonnées de paiement',
  localTest:
    'Sur cet environnement, les coordonnées de paiement sont scellées avec une clé TEST. Les annonces réelles nécessitent le fournisseur de chiffrement des instruments du propriétaire, qui n’est pas connecté.',
  none: 'Les nouvelles coordonnées de paiement et les nouvelles annonces nécessitent le fournisseur de chiffrement des instruments du propriétaire, qui n’est pas connecté.',
} satisfies Record<keyof typeof en, string>;
export const blockerCopy = defineCopy('pay.p2p.blocker', en, { es, fr });
