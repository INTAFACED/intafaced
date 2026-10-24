import { defineCopy } from '../../shared/i18n';
const en = {
  title: 'The amount in my bank is different',
  why: 'Tell us what arrived in your own bank account. This does not move any money, and you never have to release for a payment that is not right.',
  kind: 'What arrived',
  under: 'Less than the order',
  over: 'More than the order',
  partial: 'Only part of it, so far',
  amount: 'Amount received ({currency})',
  expected: 'The order is for {amount} {currency}.',
  report: 'Report the amount',
  amountMissing: 'Enter the amount that arrived.',
  reported: 'You reported {amount} {currency} received of {expected} {currency}.',
  within: 'That is within this service’s tolerance, so the order goes on. Release once you are satisfied the payment is yours.',
  outside:
    'That is outside this service’s tolerance. You do not have to release. Settle the difference with the buyer, or open a dispute below and a moderator decides.',
  personDecides:
    'This service sets no tolerance, so a person decides. You do not have to release: open a dispute below if this is not settled with the buyer.',
  exists: 'This order already has an amount report. Add anything more in a dispute.',
  invalid:
    'That amount does not match what you chose: less or part must be under the order amount, more must be over it, in the currency’s own unit.',
} as const;
const es = {
  title: 'El importe en mi banco es distinto',
  why: 'Indica lo que llegó a tu propia cuenta bancaria. Esto no mueve dinero y nunca tienes que liberar por un pago que no es correcto.',
  kind: 'Lo que llegó',
  under: 'Menos que el pedido',
  over: 'Más que el pedido',
  partial: 'Solo una parte, por ahora',
  amount: 'Importe recibido ({currency})',
  expected: 'El pedido es de {amount} {currency}.',
  report: 'Informar del importe',
  amountMissing: 'Introduce el importe que llegó.',
  reported: 'Informaste de {amount} {currency} recibidos de {expected} {currency}.',
  within: 'Está dentro de la tolerancia de este servicio, así que el pedido sigue. Libera cuando estés seguro de que el pago es tuyo.',
  outside:
    'Está fuera de la tolerancia de este servicio. No tienes que liberar. Resuelve la diferencia con el comprador o abre una disputa abajo y decide un moderador.',
  personDecides:
    'Este servicio no fija tolerancia, así que decide una persona. No tienes que liberar: abre una disputa abajo si no lo resuelves con el comprador.',
  exists: 'Este pedido ya tiene un informe de importe. Añade lo demás en una disputa.',
  invalid:
    'Ese importe no coincide con lo elegido: menos o una parte debe ser inferior al pedido, más debe ser superior, en la unidad de la moneda.',
} as const;
const fr = {
  title: 'Le montant reçu sur ma banque est différent',
  why: 'Indiquez ce qui est arrivé sur votre propre compte bancaire. Aucun argent ne bouge, et vous n’avez jamais à libérer pour un paiement qui n’est pas le bon.',
  kind: 'Ce qui est arrivé',
  under: 'Moins que la commande',
  over: 'Plus que la commande',
  partial: 'Une partie seulement, pour l’instant',
  amount: 'Montant reçu ({currency})',
  expected: 'La commande est de {amount} {currency}.',
  report: 'Signaler le montant',
  amountMissing: 'Saisissez le montant arrivé.',
  reported: 'Vous avez signalé {amount} {currency} reçus sur {expected} {currency}.',
  within: 'C’est dans la tolérance de ce service, la commande continue. Libérez quand vous êtes sûr que le paiement vous est arrivé.',
  outside:
    'C’est hors de la tolérance de ce service. Vous n’avez pas à libérer. Réglez l’écart avec l’acheteur, ou ouvrez un litige ci-dessous et un modérateur décide.',
  personDecides:
    'Ce service ne fixe aucune tolérance, une personne décide donc. Vous n’avez pas à libérer : ouvrez un litige ci-dessous si ce n’est pas réglé avec l’acheteur.',
  exists: 'Cette commande a déjà un signalement de montant. Ajoutez le reste dans un litige.',
  invalid:
    'Ce montant ne correspond pas à votre choix : moins ou une partie doit être inférieur à la commande, plus doit être supérieur, dans l’unité de la devise.',
} as const;
export const mismatchCopy = defineCopy('pay.p2p.mismatch', en, { es, fr });
