import { defineCopy } from '../../shared/i18n';

const en = {
  title: 'Money that came in',
  lead: 'Your latest payments in, newest first, with when each arrived and when you can use it.',
  none: 'No money has come into your account yet.',
  noneRecent: 'No money came in among your latest activity.',
  older: 'Older payments are in your Activity.',
  kind_deposit: 'Deposit',
  kind_welcome_funds: 'TEST funds',
  kind_transfer_in: 'From {handle}',
  kind_transfer_in_unknown: 'Transfer from another person',
  arrived: 'Arrived {time}.',
  available: 'Available to use since then.',
  rulesTitle: 'How incoming money works',
  ruleTiming:
    'When: each way to pay shows when its money arrives, as the bank quoted it. While a way to pay has no partner, it says "not set" and nothing arrives through it.',
  ruleAvailable: 'Available: money shown here is already in your balance. Nothing listed here is still on its way.',
  ruleReturns:
    'Returned: if a payment is sent back, it is taken out of your balance once and shown in your Activity. It is never taken twice.',
  ruleRefused: 'Refused: a refused request to add money adds nothing. Its reason is in your add-money requests below.',
} as const;

const es: Record<keyof typeof en, string> = {
  title: 'Dinero que entró',
  lead: 'Tus últimos pagos recibidos, el más reciente primero, con cuándo llegó cada uno y desde cuándo puedes usarlo.',
  none: 'Todavía no ha entrado dinero en tu cuenta.',
  noneRecent: 'No entró dinero en tu actividad más reciente.',
  older: 'Los pagos más antiguos están en tu Actividad.',
  kind_deposit: 'Depósito',
  kind_welcome_funds: 'Fondos TEST',
  kind_transfer_in: 'De {handle}',
  kind_transfer_in_unknown: 'Transferencia de otra persona',
  arrived: 'Llegó {time}.',
  available: 'Disponible para usar desde entonces.',
  rulesTitle: 'Cómo funciona el dinero que entra',
  ruleTiming:
    'Cuándo: cada forma de pago muestra cuándo llega su dinero, según lo indicó el banco. Si una forma de pago no tiene socio, dice «sin definir» y no llega nada por ella.',
  ruleAvailable: 'Disponible: el dinero que aparece aquí ya está en tu saldo. Nada de lo que aparece aquí sigue en camino.',
  ruleReturns: 'Devuelto: si un pago se devuelve, se retira de tu saldo una sola vez y aparece en tu Actividad. Nunca se retira dos veces.',
  ruleRefused: 'Rechazado: una solicitud rechazada para añadir dinero no añade nada. Su motivo está en tus solicitudes de abajo.',
};

const fr: Record<keyof typeof en, string> = {
  title: 'Argent reçu',
  lead: 'Vos derniers paiements reçus, le plus récent en premier, avec leur date d’arrivée et depuis quand vous pouvez les utiliser.',
  none: 'Aucun argent n’est encore arrivé sur votre compte.',
  noneRecent: 'Aucun argent reçu dans votre activité la plus récente.',
  older: 'Les paiements plus anciens figurent dans votre Activité.',
  kind_deposit: 'Dépôt',
  kind_welcome_funds: 'Fonds TEST',
  kind_transfer_in: 'De {handle}',
  kind_transfer_in_unknown: 'Virement d’une autre personne',
  arrived: 'Arrivé le {time}.',
  available: 'Utilisable depuis ce moment.',
  rulesTitle: 'Comment fonctionne l’argent reçu',
  ruleTiming:
    'Quand : chaque moyen de paiement indique quand son argent arrive, tel que la banque l’a annoncé. Sans partenaire, il indique « non défini » et rien n’arrive par lui.',
  ruleAvailable: 'Disponible : l’argent affiché ici est déjà dans votre solde. Rien de ce qui est affiché ici n’est encore en route.',
  ruleReturns:
    'Retourné : si un paiement est renvoyé, il est retiré de votre solde une seule fois et affiché dans votre Activité. Il n’est jamais retiré deux fois.',
  ruleRefused: 'Refusé : une demande d’ajout d’argent refusée n’ajoute rien. Son motif figure dans vos demandes ci-dessous.',
};

export const incomingCopy = defineCopy('customer.money.incoming', en, { es, fr });
