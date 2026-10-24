import { defineCopy } from '../../shared/i18n';

const en = {
  title: 'Membership',
  lead: 'The membership tiers this platform publishes, and yours.',
  notOffered: 'Membership is not offered',
  notOfferedBody: 'No membership tier is published, so there is nothing to join and nothing is charged.',
  yours: 'Your tier',
  noTier: 'You have no membership tier.',
  price: '{price} {asset} every {days} days',
  perks: 'Perks',
  noPerks: 'No perks are listed for this tier.',
  notForSale: 'There is no way to buy a membership here. Nothing is charged.',
} as const;
const es = {
  title: 'Membresía',
  lead: 'Los niveles de membresía que publica esta plataforma, y el tuyo.',
  notOffered: 'No se ofrece membresía',
  notOfferedBody: 'No hay ningún nivel de membresía publicado, así que no hay nada a lo que unirse y no se cobra nada.',
  yours: 'Tu nivel',
  noTier: 'No tienes ningún nivel de membresía.',
  price: '{price} {asset} cada {days} días',
  perks: 'Ventajas',
  noPerks: 'Este nivel no tiene ventajas publicadas.',
  notForSale: 'Aquí no hay forma de comprar una membresía. No se cobra nada.',
} satisfies Record<keyof typeof en, string>;
const fr = {
  title: 'Abonnement',
  lead: 'Les niveaux d’abonnement que publie cette plateforme, et le vôtre.',
  notOffered: 'Aucun abonnement n’est proposé',
  notOfferedBody: 'Aucun niveau d’abonnement n’est publié : il n’y a rien à rejoindre et rien n’est facturé.',
  yours: 'Votre niveau',
  noTier: 'Vous n’avez aucun niveau d’abonnement.',
  price: '{price} {asset} tous les {days} jours',
  perks: 'Avantages',
  noPerks: 'Aucun avantage n’est publié pour ce niveau.',
  notForSale: 'Aucun abonnement ne peut être acheté ici. Rien n’est facturé.',
} satisfies Record<keyof typeof en, string>;

export const membershipCopy = defineCopy('account.membership', en, { es, fr });
