import { defineCopy } from '../../../shared/i18n';

// Non-instant payment methods (P-disputes-security-09): money on them arrives within a settlement window.
const en = {
  label: 'Settlement',
  instant: 'Instant',
  nonInstant: '{method}: not instant, the money can take up to {window} to arrive',
  nonInstantBlank: '{method}: not instant, the money can take until the payment deadline to arrive',
  consent: 'The seller accepts payment methods that are not instant.',
  takeNotice: 'This method is not instant. You have {window} to pay, and a dispute opens only after that.',
  takeNoticeBlank: 'This method is not instant. You have until the payment deadline to pay, and a dispute opens only after it.',
  order: 'Not instant: the payment window is {window}, and a dispute opens only after it ends',
  orderBlank: 'Not instant: the payment window is the published payment deadline, and a dispute opens only after it ends',
  consentLabel: 'I accept payment methods that are not instant: the money can take days to arrive.',
  day: '1 day',
  days: '{count} days',
  hour: '1 hour',
  hours: '{count} hours',
  minutes: '{count} minutes',
} as const;
const es = {
  label: 'Liquidación',
  instant: 'Instantáneo',
  nonInstant: '{method}: no es instantáneo, el dinero puede tardar hasta {window} en llegar',
  nonInstantBlank: '{method}: no es instantáneo, el dinero puede tardar hasta el plazo de pago en llegar',
  consent: 'El vendedor acepta métodos de pago que no son instantáneos.',
  takeNotice: 'Este método no es instantáneo. Tienes {window} para pagar, y una disputa solo se abre después.',
  takeNoticeBlank: 'Este método no es instantáneo. Tienes hasta el plazo de pago para pagar, y una disputa solo se abre después.',
  order: 'No instantáneo: el plazo de pago es de {window}, y una disputa solo se abre cuando termina',
  orderBlank: 'No instantáneo: el plazo de pago es el publicado, y una disputa solo se abre cuando termina',
  consentLabel: 'Acepto métodos de pago que no son instantáneos: el dinero puede tardar días en llegar.',
  day: '1 día',
  days: '{count} días',
  hour: '1 hora',
  hours: '{count} horas',
  minutes: '{count} minutos',
} satisfies Record<keyof typeof en, string>;
const fr = {
  label: 'Règlement',
  instant: 'Instantané',
  nonInstant: '{method} : pas instantané, l’argent peut mettre jusqu’à {window} pour arriver',
  nonInstantBlank: '{method} : pas instantané, l’argent peut mettre jusqu’au délai de paiement pour arriver',
  consent: 'Le vendeur accepte les moyens de paiement qui ne sont pas instantanés.',
  takeNotice: 'Ce moyen n’est pas instantané. Vous avez {window} pour payer, et un litige ne s’ouvre qu’après.',
  takeNoticeBlank: 'Ce moyen n’est pas instantané. Vous avez jusqu’au délai de paiement pour payer, et un litige ne s’ouvre qu’après.',
  order: 'Pas instantané : le délai de paiement est de {window}, et un litige ne s’ouvre qu’à son terme',
  orderBlank: 'Pas instantané : le délai de paiement est celui publié, et un litige ne s’ouvre qu’à son terme',
  consentLabel: 'J’accepte les moyens de paiement qui ne sont pas instantanés : l’argent peut mettre des jours à arriver.',
  day: '1 jour',
  days: '{count} jours',
  hour: '1 heure',
  hours: '{count} heures',
  minutes: '{count} minutes',
} satisfies Record<keyof typeof en, string>;

export const settlementCopy = defineCopy('pay.p2p.settlement', en, { es, fr });
