import { defineCopy } from '../../shared/i18n';

const en = {
  title: 'Paying more than you hold',
  noOverdraft:
    'Your plan, {tier}, has no overdraft: a payment cannot take your balance below zero. Asking to pay more than you hold is refused and nothing moves.',
  overdraft:
    'Your plan, {tier}, allows a negative balance at an overdraft fee of {fee}, but the overdraft is switched off in this build: the bank does not book a balance below zero. Asking to pay more than you hold is refused and nothing moves.',
  overBalance: 'This is {shortfall} more than this space holds ({balance}).',
  unset:
    'The bank has published no plan terms, so it is not known whether your balance may go below zero. Payments above your balance are refused.',
  company: 'A business has no account of its own in this build, so no plan applies to it and nothing can be paid from it.',
  reference: 'Reference: {code}',
} as const;

const es: Record<keyof typeof en, string> = {
  title: 'Pagar más de lo que tienes',
  noOverdraft:
    'Tu plan, {tier}, no tiene descubierto: un pago no puede dejar tu saldo por debajo de cero. Si pides pagar más de lo que tienes, se rechaza y no se mueve nada.',
  overdraft:
    'Tu plan, {tier}, permite un saldo negativo con una comisión por descubierto de {fee}, pero el descubierto está desactivado en esta versión: el banco no registra saldos por debajo de cero. Si pides pagar más de lo que tienes, se rechaza y no se mueve nada.',
  overBalance: 'Son {shortfall} más de lo que tiene este espacio ({balance}).',
  unset:
    'El banco no ha publicado las condiciones del plan, así que no se sabe si tu saldo puede bajar de cero. Los pagos por encima de tu saldo se rechazan.',
  company: 'Una empresa no tiene cuenta propia en esta versión, así que no se le aplica ningún plan y no se puede pagar nada desde ella.',
  reference: 'Referencia: {code}',
};

const fr: Record<keyof typeof en, string> = {
  title: 'Payer plus que ce que vous avez',
  noOverdraft:
    'Votre offre, {tier}, n’a pas de découvert : un paiement ne peut pas faire passer votre solde sous zéro. Une demande de payer plus que ce que vous avez est refusée et rien ne bouge.',
  overdraft:
    'Votre offre, {tier}, autorise un solde négatif avec des frais de découvert de {fee}, mais le découvert est désactivé dans cette version : la banque n’enregistre aucun solde sous zéro. Une demande de payer plus que ce que vous avez est refusée et rien ne bouge.',
  overBalance: 'C’est {shortfall} de plus que ce que contient cet espace ({balance}).',
  unset:
    'La banque n’a publié aucune condition d’offre, on ne sait donc pas si votre solde peut passer sous zéro. Les paiements supérieurs à votre solde sont refusés.',
  company: 'Une entreprise n’a pas de compte propre dans cette version : aucune offre ne s’y applique et rien ne peut en être payé.',
  reference: 'Référence : {code}',
};

export const planRuleCopy = defineCopy('customer.money.planRule', en, { es, fr });
