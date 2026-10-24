import { defineCopy } from '../../shared/i18n';
const en = {
  remind: 'Remind the seller',
  remindWhy: 'Asks the seller to check their bank and release. It does not move any money.',
  remindFrom: 'You can remind the seller from {time}.',
  remindSpent:
    'You have sent this order’s {max} reminders. If the payment is in the seller’s account and they do not release, open a dispute.',
  remindUnset: 'Reminders are switched off on this service: the wait and the number of reminders are not set.',
  remindUnread: 'This page could not read this order’s reminders. Refresh the order to remind the seller.',
  remindEarly: 'The wait before the next reminder has not passed. No reminder was sent.',
  remindSpentPlain:
    'You have sent all of this order’s reminders. If the payment is in the seller’s account and they do not release, open a dispute.',
  sentToSeller: 'You reminded the seller at {time}.',
  sellerReminded:
    'The buyer reminded you to release at {time}. Check that the payment is in your own bank account, then release, or open a dispute if it is not there.',
} as const;
const es = {
  remind: 'Recordar al vendedor',
  remindWhy: 'Pide al vendedor que revise su banco y libere. No mueve dinero.',
  remindFrom: 'Puedes recordar al vendedor desde las {time}.',
  remindSpent:
    'Ya enviaste los {max} recordatorios de este pedido. Si el pago está en la cuenta del vendedor y no libera, abre una disputa.',
  remindUnset: 'Los recordatorios están desactivados en este servicio: la espera y el número de recordatorios no están fijados.',
  remindUnread: 'Esta página no pudo leer los recordatorios de este pedido. Actualiza el pedido para recordar al vendedor.',
  remindEarly: 'La espera antes del siguiente recordatorio no ha terminado. No se envió ningún recordatorio.',
  remindSpentPlain:
    'Ya enviaste todos los recordatorios de este pedido. Si el pago está en la cuenta del vendedor y no libera, abre una disputa.',
  sentToSeller: 'Recordaste al vendedor a las {time}.',
  sellerReminded:
    'El comprador te recordó liberar a las {time}. Comprueba que el pago está en tu propia cuenta bancaria y libera, o abre una disputa si no está.',
} as const;
const fr = {
  remind: 'Relancer le vendeur',
  remindWhy: 'Demande au vendeur de vérifier sa banque et de libérer. Aucun argent ne bouge.',
  remindFrom: 'Vous pourrez relancer le vendeur à partir de {time}.',
  remindSpent:
    'Vous avez envoyé les {max} relances de cette commande. Si le paiement est sur le compte du vendeur et qu’il ne libère pas, ouvrez un litige.',
  remindUnset: 'Les relances sont désactivées sur ce service : le délai et le nombre de relances ne sont pas fixés.',
  remindUnread: 'Cette page n’a pas pu lire les relances de cette commande. Actualisez la commande pour relancer le vendeur.',
  remindEarly: 'Le délai avant la prochaine relance n’est pas écoulé. Aucune relance n’a été envoyée.',
  remindSpentPlain:
    'Vous avez envoyé toutes les relances de cette commande. Si le paiement est sur le compte du vendeur et qu’il ne libère pas, ouvrez un litige.',
  sentToSeller: 'Vous avez relancé le vendeur à {time}.',
  sellerReminded:
    'L’acheteur vous a relancé pour libérer à {time}. Vérifiez que le paiement est sur votre propre compte bancaire, puis libérez, ou ouvrez un litige s’il n’y est pas.',
} as const;
export const remindCopy = defineCopy('pay.p2p.remind', en, { es, fr });
