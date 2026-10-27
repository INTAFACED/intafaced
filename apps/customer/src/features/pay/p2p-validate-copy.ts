import { defineCopy } from '../../shared/i18n';
const en = {
  check: 'Check the payment with the bank',
  why: 'The bank rail looks for this order’s exact amount with the order number as the reference, and releases at once if it is there.',
  railOff: 'Payment validation needs a bank rail. It is switched off in this build, so check your own bank and release by hand.',
  methodOff: 'The bank rail does not check {method} payments, so check your own bank and release by hand.',
  pending: 'The bank shows no payment for this order. Check again later, or release by hand once you see it.',
  confirmWhy: 'Confirm it is you: if the bank shows the payment, the coins go to the buyer at once.',
  confirmAgain: 'Nothing was checked or released. Confirm it is you again, then check.',
  confirmUnchecked: 'Your confirmation could not be checked, so nothing was checked or released. Try again shortly.',
  mismatch: 'What arrived does not match this order exactly, so nothing was released. Settle it with the buyer, or open a dispute below.',
  unread: 'This page could not read whether the bank rail can check this order. Refresh the order.',
} as const;
const es = {
  check: 'Comprobar el pago con el banco',
  why: 'El canal bancario busca el importe exacto de este pedido con el número de pedido como referencia y libera al instante si está.',
  railOff: 'La validación de pagos necesita un canal bancario. Está desactivado en esta versión, así que revisa tu banco y libera a mano.',
  methodOff: 'El canal bancario no comprueba pagos por {method}, así que revisa tu banco y libera a mano.',
  pending: 'El banco no muestra ningún pago para este pedido. Vuelve a comprobarlo más tarde o libera a mano cuando lo veas.',
  confirmWhy: 'Confirma que eres tú: si el banco muestra el pago, las monedas van al comprador al instante.',
  confirmAgain: 'No se comprobó ni se liberó nada. Vuelve a confirmar que eres tú y comprueba.',
  confirmUnchecked: 'No se pudo comprobar tu confirmación, así que no se comprobó ni se liberó nada. Inténtalo de nuevo en breve.',
  mismatch:
    'Lo que llegó no coincide exactamente con este pedido, así que no se liberó nada. Resuélvelo con el comprador o abre una disputa abajo.',
  unread: 'Esta página no pudo leer si el canal bancario puede comprobar este pedido. Actualiza el pedido.',
} as const;
const fr = {
  check: 'Vérifier le paiement auprès de la banque',
  why: 'Le canal bancaire cherche le montant exact de cette commande avec le numéro de commande en référence, et libère aussitôt s’il y est.',
  railOff:
    'La validation des paiements nécessite un canal bancaire. Il est désactivé dans cette version : vérifiez votre banque et libérez à la main.',
  methodOff: 'Le canal bancaire ne vérifie pas les paiements {method} : vérifiez votre banque et libérez à la main.',
  pending: 'La banque n’affiche aucun paiement pour cette commande. Vérifiez plus tard, ou libérez à la main quand vous le voyez.',
  confirmWhy: 'Confirmez que c’est vous : si la banque montre le paiement, les jetons vont aussitôt à l’acheteur.',
  confirmAgain: 'Rien n’a été vérifié ni libéré. Confirmez de nouveau que c’est vous, puis vérifiez.',
  confirmUnchecked: 'Votre confirmation n’a pas pu être vérifiée, rien n’a donc été vérifié ni libéré. Réessayez dans un instant.',
  mismatch:
    'Ce qui est arrivé ne correspond pas exactement à cette commande, rien n’a donc été libéré. Réglez-le avec l’acheteur, ou ouvrez un litige ci-dessous.',
  unread: 'Cette page n’a pas pu lire si le canal bancaire peut vérifier cette commande. Actualisez la commande.',
} as const;
export const validateCopy = defineCopy('pay.p2p.validate', en, { es, fr });
