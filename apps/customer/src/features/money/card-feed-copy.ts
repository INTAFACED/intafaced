import { defineCopy } from '../../shared/i18n';

/** Words of a card's recurring payments and merchant refunds (J-bank-14 #6; BK-cpay-02). */
const en = {
  recurringTitle: 'Recurring payments',
  recurringLead: 'Merchants that charge this card on file, on a schedule you agreed, as the card issuer marked them.',
  recurringNone: 'No merchant charges this card on file.',
  recurringList: 'Merchants charging this card',
  recurringMerchant: '{merchant}, {country}',
  recurringNoMerchant: 'A merchant the card issuer did not name',
  recurringPayments: '{count} payments, the last {amount} {asset} on {date}',
  recurringOnePayment: '1 payment, {amount} {asset} on {date}',
  refundsTitle: 'Merchant refunds',
  refundsLead: 'Money a merchant gave back for a payment on this card. The card partner moves it; nothing is booked here.',
  refundsNone: 'No merchant has refunded a payment on this card.',
  refundsList: 'Refunds on this card',
  refundSettled: '{amount} {asset} refunded for {ref} on {date}',
  refundPending: '{amount} {asset} asked back for {ref}; waiting for the card partner’s answer',
  refundRejected: 'The card partner refused a refund of {amount} {asset} for {ref}',
  refundCashback: 'Cashback on a refunded payment stays as it was: whether it is taken back is an open owner decision.',
  feedRecurring: 'Recurring payment',
  feedRefund: 'Refund',
} as const;

const es = {
  recurringTitle: 'Pagos recurrentes',
  recurringLead: 'Comercios que cobran esta tarjeta guardada, con la periodicidad que aceptaste, según los marcó el emisor.',
  recurringNone: 'Ningún comercio cobra esta tarjeta guardada.',
  recurringList: 'Comercios que cobran esta tarjeta',
  recurringMerchant: '{merchant}, {country}',
  recurringNoMerchant: 'Un comercio que el emisor no nombró',
  recurringPayments: '{count} pagos, el último de {amount} {asset} el {date}',
  recurringOnePayment: '1 pago, {amount} {asset} el {date}',
  refundsTitle: 'Reembolsos de comercios',
  refundsLead: 'Dinero que un comercio devolvió por un pago con esta tarjeta. Lo mueve el socio de la tarjeta; aquí no se anota nada.',
  refundsNone: 'Ningún comercio ha reembolsado un pago con esta tarjeta.',
  refundsList: 'Reembolsos en esta tarjeta',
  refundSettled: '{amount} {asset} reembolsados por {ref} el {date}',
  refundPending: '{amount} {asset} pedidos de vuelta por {ref}; esperando la respuesta del socio de la tarjeta',
  refundRejected: 'El socio de la tarjeta rechazó un reembolso de {amount} {asset} por {ref}',
  refundCashback: 'El cashback de un pago reembolsado sigue igual: si se retira es una decisión abierta.',
  feedRecurring: 'Pago recurrente',
  feedRefund: 'Reembolso',
} as const;

const fr = {
  recurringTitle: 'Paiements récurrents',
  recurringLead: 'Les marchands qui débitent cette carte enregistrée, au rythme que vous avez accepté, tels que l’émetteur les a marqués.',
  recurringNone: 'Aucun marchand ne débite cette carte enregistrée.',
  recurringList: 'Marchands qui débitent cette carte',
  recurringMerchant: '{merchant}, {country}',
  recurringNoMerchant: 'Un marchand que l’émetteur n’a pas nommé',
  recurringPayments: '{count} paiements, le dernier de {amount} {asset} le {date}',
  recurringOnePayment: '1 paiement, {amount} {asset} le {date}',
  refundsTitle: 'Remboursements des marchands',
  refundsLead:
    'L’argent qu’un marchand a rendu pour un paiement par cette carte. Le partenaire de la carte le déplace ; rien n’est inscrit ici.',
  refundsNone: 'Aucun marchand n’a remboursé de paiement sur cette carte.',
  refundsList: 'Remboursements sur cette carte',
  refundSettled: '{amount} {asset} remboursés pour {ref} le {date}',
  refundPending: '{amount} {asset} demandés en retour pour {ref} ; en attente de la réponse du partenaire de la carte',
  refundRejected: 'Le partenaire de la carte a refusé un remboursement de {amount} {asset} pour {ref}',
  refundCashback: 'Le cashback d’un paiement remboursé reste tel quel : sa reprise est une décision ouverte.',
  feedRecurring: 'Paiement récurrent',
  feedRefund: 'Remboursement',
} as const;

export const cardFeedCopy = defineCopy('customer.bank.card-feed', en, { es, fr });
