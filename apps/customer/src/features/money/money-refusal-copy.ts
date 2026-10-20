import { defineCopy, type UiLocale } from '../../shared/i18n';
import type { ApiResult } from '../../shared/api';

/**
 * Plain words for the typed refusals the card, team and transfer writes can come back with.
 *
 * Every code here is one the bank refuses with before anything is posted or changed, so each sentence says what
 * happened and what to do, and those requests are safe to correct and send again. A code that may have gone through
 * (for example a lost ledger answer) is deliberately not in this list: it stays an unconfirmed request.
 */
const en = {
  cardNotFound: 'That card could not be found. Refresh your cards and try again.',
  cardNotActive: 'This card is not active. A closed card cannot be reopened.',
  cardLimitInvalid: 'A card limit must be more than zero.',
  cardAddressRequired: 'A physical card needs a full delivery address: name, street, city, postal code and a two-letter country code.',
  cardIssueConflict:
    'The bank already holds a card order under this reference, so it may already be placed. Check your cards before ordering again.',
  cardCommandConflict:
    'The bank already holds a change to this card under this reference, so it may already be applied. Refresh your cards and check.',
  cardOperatorFrozen: 'Our team froze this card, so you cannot unfreeze it. Contact support.',
  cardsOff: 'Cards are switched off right now. Nothing was changed.',
  noIssuer: 'No card issuer is connected, so cards cannot be ordered.',
  testProgramme: 'This is a test card programme. Real cards can’t be ordered because no live card issuer is connected.',
  stepUpRequired: 'This change needs an extra security confirmation, and this app does not offer one. Nothing was changed.',
  stepUpMismatch: 'The security confirmation was for a different request. Nothing was changed.',
  stepUpUsed: 'That security confirmation was already used. Nothing was changed.',
  stepUpDown: 'The security check could not be reached. Nothing was changed. Try again in a moment.',
  teamNotFound: 'That team could not be found.',
  teamClosed: 'These approval rules are closed, so nothing can be sent under them.',
  notMember: 'You are not a member of this team.',
  roleForbidden: 'Your role on this team does not allow that. Ask an administrator.',
  payrollEmpty: 'Add at least one person to pay.',
  payrollCurrency: 'Everyone must be paid in the same currency as the account the money comes from.',
  payrollConflict:
    'The bank already holds a payroll under this reference, so it may already have been paid. Check your records before sending another.',
  requestConflict:
    'The bank already holds a request under this reference, so it may already be done. Check your records before sending anything again.',
  payrollOverLimit:
    'A payroll goes out in one step with no second approver, so its total must stay below the approval limit. Split it, or send the larger amounts as payments a teammate approves.',
  directoryOff: 'People lookup is not set up on this service, so teammates and recipients cannot be named.',
  directoryDown: 'The people directory did not answer. Try again in a moment.',
  directoryIncomplete:
    'The team cannot be shown in full: a person on it has no public handle, or the team is larger than one page. Nothing is cut off.',
  lookupLimit: 'Too many lookups. Try again in a minute.',
  lookupQuery: 'Enter a handle or an email, not both.',
  assetMismatch: 'That account holds a different currency from the one this request uses.',
  sameAccount: 'The money cannot go to the account it comes from, and the same account cannot be paid twice.',
  belowMinimum: 'Each amount must be more than zero.',
  notOwner: 'That account does not belong to you.',
  accountNotFound: 'One of the accounts could not be found.',
  accountLocked: 'One of the accounts is locked or archived and cannot be used right now.',
  cannotReceive: 'That person cannot receive this right now. Nothing was sent.',
  receiveCheckDown: 'We could not check whether the recipient can receive money. Nothing was sent. Try again in a moment.',
  receiveCheckOff: 'Paying other people is not set up on this service. Nothing was sent.',
  notEnough: 'There is not enough available to cover this. Lower the amount.',
  noteInvalid: 'A note is plain text up to 140 characters, with no line breaks.',
  referenceInvalid: 'A reference is 1 to 64 letters, numbers or keyboard symbols, with no accents or emoji.',
  transferConflict:
    'The bank already holds a transfer under this reference, so it may already be sent. Check your activity before sending again.',
  sendLimit: 'That is above the limit for a single transfer.',
  dailyLimit: 'That would go over today’s sending limit.',
  termsUnset: 'Sending limits and fees for this currency are not published, so this transfer is refused. Nothing was sent.',
  feeUnwired: 'A fee applies to this currency and cannot be charged on this transfer, so it was refused. Nothing was sent.',
  cardNotIssued: 'The bank could not confirm that this card was issued. Check your cards before ordering again.',
  rampConflict:
    'The bank already holds a cash-out under this reference, so it may already be done. Check your records before sending again.',
  lastAdmin: 'The last administrator cannot be removed or demoted. Make someone else an administrator first.',
  labelTaken: 'You already have a saved address with that name. Choose another. Nothing was changed.',
  destinationGone: 'That address is no longer saved. Refresh the list. Nothing was changed.',
  labelInvalid: 'The name must be 1 to 64 characters, with no space at either end and no control characters. Nothing was changed.',
  memberHasPending: 'This person still has a payment waiting. Decide or cancel it before removing them.',
} as const;
const es = {
  cardNotFound: 'No se encontró esa tarjeta. Actualiza tus tarjetas e inténtalo de nuevo.',
  cardNotActive: 'Esta tarjeta no está activa. Una tarjeta cerrada no se puede reabrir.',
  cardLimitInvalid: 'El límite de una tarjeta debe ser mayor que cero.',
  cardAddressRequired:
    'Una tarjeta física necesita una dirección de envío completa: nombre, calle, ciudad, código postal y un código de país de dos letras.',
  cardIssueConflict:
    'El banco ya tiene un pedido de tarjeta con esta referencia, así que puede que ya esté hecho. Revisa tus tarjetas antes de volver a pedir.',
  cardCommandConflict:
    'El banco ya tiene un cambio de esta tarjeta con esta referencia, así que puede que ya esté aplicado. Actualiza tus tarjetas y compruébalo.',
  cardOperatorFrozen: 'Nuestro equipo congeló esta tarjeta, así que no puedes descongelarla. Contacta con soporte.',
  cardsOff: 'Las tarjetas están desactivadas en este momento. No se cambió nada.',
  noIssuer: 'No hay ningún emisor de tarjetas conectado, así que no se pueden pedir tarjetas.',
  testProgramme:
    'Este es un programa de tarjetas de prueba. No se pueden pedir tarjetas reales porque no hay un emisor de tarjetas en vivo conectado.',
  stepUpRequired: 'Este cambio necesita una confirmación de seguridad adicional y esta app no la ofrece. No se cambió nada.',
  stepUpMismatch: 'La confirmación de seguridad era para otra solicitud. No se cambió nada.',
  stepUpUsed: 'Esa confirmación de seguridad ya se usó. No se cambió nada.',
  stepUpDown: 'No se pudo contactar con la comprobación de seguridad. No se cambió nada. Inténtalo de nuevo en un momento.',
  teamNotFound: 'No se encontró ese equipo.',
  teamClosed: 'Estas reglas de aprobación están cerradas, así que no se puede enviar nada con ellas.',
  notMember: 'No eres miembro de este equipo.',
  roleForbidden: 'Tu rol en este equipo no lo permite. Consulta a un administrador.',
  payrollEmpty: 'Añade al menos una persona a la que pagar.',
  payrollCurrency: 'Todas las personas deben cobrar en la misma moneda que la cuenta de la que sale el dinero.',
  payrollConflict:
    'El banco ya tiene una nómina con esta referencia, así que puede que ya se haya pagado. Revisa tus registros antes de enviar otra.',
  requestConflict:
    'El banco ya tiene una solicitud con esta referencia, así que puede que ya esté hecha. Revisa tus registros antes de volver a enviar nada.',
  payrollOverLimit:
    'Una nómina sale en un solo paso y sin segundo aprobador, así que su total debe quedar por debajo del límite de aprobación. Divídela, o manda los importes mayores como pagos que apruebe un compañero.',
  directoryOff: 'La búsqueda de personas no está configurada en este servicio, así que no se puede nombrar a compañeros ni destinatarios.',
  directoryDown: 'El directorio de personas no respondió. Inténtalo de nuevo en un momento.',
  directoryIncomplete:
    'No se puede mostrar el equipo completo: una persona no tiene usuario público o el equipo es mayor que una página. No se recorta nada.',
  lookupLimit: 'Demasiadas búsquedas. Inténtalo de nuevo en un minuto.',
  lookupQuery: 'Escribe un usuario o un correo, no ambos.',
  assetMismatch: 'Esa cuenta tiene una moneda distinta de la que usa esta solicitud.',
  sameAccount: 'El dinero no puede ir a la cuenta de la que sale, y no se puede pagar dos veces a la misma cuenta.',
  belowMinimum: 'Cada importe debe ser mayor que cero.',
  notOwner: 'Esa cuenta no es tuya.',
  accountNotFound: 'No se encontró una de las cuentas.',
  accountLocked: 'Una de las cuentas está bloqueada o archivada y no se puede usar ahora.',
  cannotReceive: 'Esa persona no puede recibir esto ahora. No se envió nada.',
  receiveCheckDown: 'No pudimos comprobar si el destinatario puede recibir dinero. No se envió nada. Inténtalo de nuevo en un momento.',
  receiveCheckOff: 'Pagar a otras personas no está configurado en este servicio. No se envió nada.',
  notEnough: 'No hay saldo disponible suficiente para cubrirlo. Reduce el importe.',
  noteInvalid: 'Una nota es texto sencillo de hasta 140 caracteres, sin saltos de línea.',
  referenceInvalid: 'Una referencia tiene de 1 a 64 letras, números o símbolos del teclado, sin acentos ni emojis.',
  transferConflict:
    'El banco ya tiene una transferencia con esta referencia, así que puede que ya esté enviada. Revisa tu actividad antes de volver a enviar.',
  sendLimit: 'Eso supera el límite de una sola transferencia.',
  dailyLimit: 'Eso superaría el límite de envío de hoy.',
  termsUnset:
    'Los límites y comisiones de envío de esta moneda no están publicados, así que se rechazó la transferencia. No se envió nada.',
  feeUnwired: 'Esta moneda tiene una comisión que no se puede cobrar en esta transferencia, así que se rechazó. No se envió nada.',
  cardNotIssued: 'El banco no pudo confirmar que esta tarjeta se emitió. Revisa tus tarjetas antes de volver a pedir.',
  rampConflict:
    'El banco ya tiene una retirada con esta referencia, así que puede que ya esté hecha. Revisa tus registros antes de volver a enviar.',
  lastAdmin: 'No se puede quitar ni bajar de rol al último administrador. Nombra antes a otra persona administradora.',
  labelTaken: 'Ya tienes una dirección guardada con ese nombre. Elige otro. No se cambió nada.',
  destinationGone: 'Esa dirección ya no está guardada. Actualiza la lista. No se cambió nada.',
  labelInvalid:
    'El nombre debe tener de 1 a 64 caracteres, sin espacios al principio ni al final ni caracteres de control. No se cambió nada.',
  memberHasPending: 'Esta persona aún tiene un pago esperando. Decide o cancela esos pagos antes de quitarla.',
} satisfies Record<keyof typeof en, string>;
const fr = {
  cardNotFound: 'Cette carte est introuvable. Actualisez vos cartes et réessayez.',
  cardNotActive: 'Cette carte n’est pas active. Une carte fermée ne peut pas être rouverte.',
  cardLimitInvalid: 'Le plafond d’une carte doit être supérieur à zéro.',
  cardAddressRequired:
    'Une carte physique demande une adresse de livraison complète : nom, rue, ville, code postal et un code pays à deux lettres.',
  cardIssueConflict:
    'La banque détient déjà une commande de carte sous cette référence : elle est peut-être déjà passée. Vérifiez vos cartes avant de recommander.',
  cardCommandConflict:
    'La banque détient déjà un changement de cette carte sous cette référence : il est peut-être déjà appliqué. Actualisez vos cartes et vérifiez.',
  cardOperatorFrozen: 'Notre équipe a gelé cette carte, vous ne pouvez donc pas la dégeler. Contactez le support.',
  cardsOff: 'Les cartes sont désactivées pour le moment. Rien n’a été modifié.',
  noIssuer: 'Aucun émetteur de cartes n’est connecté : les cartes ne peuvent pas être commandées.',
  testProgramme:
    'Ceci est un programme de cartes de test. Les vraies cartes ne peuvent pas être commandées car aucun émetteur de cartes réel n’est connecté.',
  stepUpRequired:
    'Ce changement demande une confirmation de sécurité supplémentaire, que cette application ne propose pas. Rien n’a été modifié.',
  stepUpMismatch: 'La confirmation de sécurité concernait une autre demande. Rien n’a été modifié.',
  stepUpUsed: 'Cette confirmation de sécurité a déjà été utilisée. Rien n’a été modifié.',
  stepUpDown: 'La vérification de sécurité est injoignable. Rien n’a été modifié. Réessayez dans un instant.',
  teamNotFound: 'Cette équipe est introuvable.',
  teamClosed: 'Ces règles d’approbation sont fermées : rien ne peut être envoyé sous leur couvert.',
  notMember: 'Vous ne faites pas partie de cette équipe.',
  roleForbidden: 'Votre rôle dans cette équipe ne le permet pas. Demandez à un administrateur.',
  payrollEmpty: 'Ajoutez au moins une personne à payer.',
  payrollCurrency: 'Chacun doit être payé dans la même devise que le compte d’où part l’argent.',
  payrollConflict:
    'La banque détient déjà une paie sous cette référence : elle est peut-être déjà payée. Vérifiez vos relevés avant d’en envoyer une autre.',
  requestConflict:
    'La banque détient déjà une demande sous cette référence : elle est peut-être déjà traitée. Vérifiez vos relevés avant de renvoyer quoi que ce soit.',
  payrollOverLimit:
    'Une paie part en une seule étape, sans second approbateur : son total doit rester sous le plafond d’approbation. Scindez-la, ou envoyez les montants plus élevés comme des paiements qu’un collègue approuve.',
  directoryOff: 'La recherche de personnes n’est pas configurée sur ce service : on ne peut pas nommer les collègues ni les destinataires.',
  directoryDown: 'L’annuaire des personnes n’a pas répondu. Réessayez dans un instant.',
  directoryIncomplete:
    'L’équipe ne peut pas être affichée en entier : une personne n’a pas d’identifiant public, ou l’équipe dépasse une page. Rien n’est tronqué.',
  lookupLimit: 'Trop de recherches. Réessayez dans une minute.',
  lookupQuery: 'Saisissez un identifiant ou un e-mail, pas les deux.',
  assetMismatch: 'Ce compte est dans une autre devise que celle de cette demande.',
  sameAccount: 'L’argent ne peut pas aller sur le compte d’où il part, et un même compte ne peut pas être payé deux fois.',
  belowMinimum: 'Chaque montant doit être supérieur à zéro.',
  notOwner: 'Ce compte ne vous appartient pas.',
  accountNotFound: 'Un des comptes est introuvable.',
  accountLocked: 'Un des comptes est verrouillé ou archivé et ne peut pas être utilisé pour le moment.',
  cannotReceive: 'Cette personne ne peut pas recevoir ceci pour le moment. Rien n’a été envoyé.',
  receiveCheckDown:
    'Nous n’avons pas pu vérifier si le destinataire peut recevoir de l’argent. Rien n’a été envoyé. Réessayez dans un instant.',
  receiveCheckOff: 'Payer d’autres personnes n’est pas configuré sur ce service. Rien n’a été envoyé.',
  notEnough: 'Le solde disponible ne suffit pas. Réduisez le montant.',
  noteInvalid: 'Une note est du texte simple, jusqu’à 140 caractères, sans saut de ligne.',
  referenceInvalid: 'Une référence compte de 1 à 64 lettres, chiffres ou symboles du clavier, sans accents ni émojis.',
  transferConflict:
    'La banque détient déjà un virement sous cette référence : il est peut-être déjà envoyé. Vérifiez votre activité avant de renvoyer.',
  sendLimit: 'Cela dépasse le plafond d’un seul virement.',
  dailyLimit: 'Cela dépasserait le plafond d’envoi du jour.',
  termsUnset: 'Les plafonds et frais d’envoi de cette devise ne sont pas publiés : le virement est refusé. Rien n’a été envoyé.',
  feeUnwired: 'Cette devise a des frais qui ne peuvent pas être prélevés sur ce virement : il est refusé. Rien n’a été envoyé.',
  cardNotIssued: 'La banque n’a pas pu confirmer que cette carte a été émise. Vérifiez vos cartes avant de recommander.',
  rampConflict:
    'La banque détient déjà un retrait sous cette référence : il est peut-être déjà fait. Vérifiez vos relevés avant de renvoyer.',
  lastAdmin: 'Le dernier administrateur ne peut être ni retiré ni rétrogradé. Nommez d’abord un autre administrateur.',
  labelTaken: 'Vous avez déjà une adresse enregistrée sous ce nom. Choisissez-en un autre. Rien n’a été modifié.',
  destinationGone: 'Cette adresse n’est plus enregistrée. Actualisez la liste. Rien n’a été modifié.',
  labelInvalid:
    'Le nom doit compter de 1 à 64 caractères, sans espace au début ou à la fin ni caractère de contrôle. Rien n’a été modifié.',
  memberHasPending: 'Cette personne a encore un paiement en attente. Décidez-en ou annulez-le avant de la retirer.',
} satisfies Record<keyof typeof en, string>;

export const moneyRefusalCopy = defineCopy('customer.money.refusals', en, { es, fr });

type Key = keyof typeof en;
const WORDS: Readonly<Record<string, Key>> = {
  'bank.card_not_found': 'cardNotFound',
  'bank.card_not_active': 'cardNotActive',
  'bank.card_limit_exceeded': 'cardLimitInvalid',
  'bank.card_shipping_address_required': 'cardAddressRequired',
  'bank.card_issue_conflict': 'cardIssueConflict',
  'bank.card_command_conflict': 'cardCommandConflict',
  'bank.card_operator_frozen': 'cardOperatorFrozen',
  'bank.cards_disabled': 'cardsOff',
  'bank.no_card_issuer': 'noIssuer',
  'bank.card_sim_not_live': 'testProgramme',
  'bank.step_up_required': 'stepUpRequired',
  'bank.step_up_mismatch': 'stepUpMismatch',
  'bank.step_up_used': 'stepUpUsed',
  'bank.step_up_unavailable': 'stepUpDown',
  'bank.business_not_found': 'teamNotFound',
  'bank.business_closed': 'teamClosed',
  'bank.business_not_member': 'notMember',
  'bank.business_role_forbidden': 'roleForbidden',
  'bank.business_payroll_empty': 'payrollEmpty',
  'bank.business_payroll_rate_unset': 'payrollCurrency',
  'bank.business_payroll_conflict': 'payrollConflict',
  'bank.business_request_conflict': 'requestConflict',
  'bank.business_self_approve': 'payrollOverLimit',
  'bank.business_last_admin': 'lastAdmin',
  'bank.business_member_has_pending': 'memberHasPending',
  'bank.business_directory_unset': 'directoryOff',
  'bank.business_directory_unavailable': 'directoryDown',
  'bank.business_directory_incomplete': 'directoryIncomplete',
  'bank.business_directory_rate_limited': 'lookupLimit',
  'bank.business_recipient_query': 'lookupQuery',
  'bank.asset_mismatch': 'assetMismatch',
  'bank.same_space': 'sameAccount',
  'bank.below_minimum': 'belowMinimum',
  'bank.not_owner': 'notOwner',
  'bank.space_not_found': 'accountNotFound',
  'bank.space_locked': 'accountLocked',
  'bank.space_archived': 'accountLocked',
  'bank.recipient_cannot_receive': 'cannotReceive',
  'bank.dest_user_missing': 'cannotReceive',
  'bank.recipient_check_unavailable': 'receiveCheckDown',
  'bank.recipient_check_unset': 'receiveCheckOff',
  'ledger.insufficient_funds': 'notEnough',
  'bank.personal_note_invalid': 'noteInvalid',
  'bank.personal_reference_invalid': 'referenceInvalid',
  'bank.personal_transfer_conflict': 'transferConflict',
  'bank.transfer_message_conflict': 'transferConflict',
  'bank.personal_transfer_limit_exceeded': 'sendLimit',
  'bank.personal_transfer_daily_limit_exceeded': 'dailyLimit',
  'bank.personal_transfer_terms_unset': 'termsUnset',
  'bank.personal_transfer_fee_unwired': 'feeUnwired',
  'bank.ramp_conflict': 'rampConflict',
  'bank.destination_label_taken': 'labelTaken',
  'bank.withdraw_destination_missing': 'destinationGone',
  'bank.ramp_invalid_destination': 'labelInvalid',
};

/**
 * A conflict says the bank already holds a record under this reference, which proves something may have been committed:
 * the bank throws some of them after the ledger has posted. They get words, never a "nothing was sent" answer.
 */
const CONFLICTS: ReadonlySet<string> = new Set([
  'bank.card_issue_conflict',
  'bank.card_command_conflict',
  'bank.business_payroll_conflict',
  'bank.business_request_conflict',
  'bank.personal_transfer_conflict',
  'bank.transfer_message_conflict',
  'bank.ramp_conflict',
]);

/**
 * The writes whose refusal paths were read in svc-bank, code by code. Only on these is a typed refusal treated as
 * "nothing was posted or changed". Every other write (loans, earn, ramps, auto-invest, proposing a business payment...)
 * keeps the earlier rule: a refusal is an unconfirmed request, because some of them leave a stored claim behind.
 */
export const REFUSAL_CHECKED_WRITES: ReadonlySet<string> = new Set([
  'cards.setLimits',
  'cards.setChannels',
  'cards.issue',
  'cards.setStatus',
  'business.runPayroll',
  'business.setMemberRole',
  'business.removeMember',
  'transfers.create',
  'transfers.toUser',
  // A single label UPDATE: every refusal comes before it changes anything.
  'ramps.destinations.rename',
]);

/** The code's sentence key. A few sentences depend on which write was refused. */
function keyFor(code: string, procedure?: string): Key | undefined {
  const normal = code.trim().toLowerCase();
  // Only a payroll can be refused this way for being over the limit; for a payment it means a different thing.
  if (normal === 'bank.business_self_approve')
    return procedure === undefined || procedure === 'business.runPayroll' ? 'payrollOverLimit' : undefined;
  if (normal === 'bank.card_not_found' && procedure === 'cards.issue') return 'cardNotIssued';
  return WORDS[normal];
}

/** Every code with plain words that is a clean refusal on a checked write: not a conflict, not a "could not be issued". */
export const REFUSED_BEFORE_POSTING: ReadonlySet<string> = new Set(Object.keys(WORDS).filter((code) => !CONFLICTS.has(code)));

/** The plain sentence for a typed refusal, in the customer's language, or null when this file has none. */
export function moneyRefusalWords(code: string | undefined | null, locale?: UiLocale, procedure?: string): string | null {
  const key = code ? keyFor(code, procedure) : undefined;
  if (!key) return null;
  return locale ? moneyRefusalCopy.forLocale(locale).t(key) : moneyRefusalCopy.t(key);
}

/** A failed read with the bank's typed refusal put into plain words, when this file has words for it. */
export function withPlainRefusal<T extends { code?: string; message: string; messageCopy?: unknown }>(failure: T): T {
  const words = moneyRefusalWords(failure.code);
  return words ? { ...failure, message: words, messageCopy: undefined } : failure;
}

/**
 * Read a failed write once it has come back.
 *
 * On a write whose refusals were checked (`REFUSAL_CHECKED_WRITES`), a typed refusal made before the bank posts or
 * changes anything is a definite "no": plain words, and the request may be corrected. A conflict gets plain words but
 * stays unconfirmed, because it proves the bank already holds something under that reference. Everything else, including
 * a refusal with no code, a lost answer, an unknown ledger answer, or any write outside the checked list, is unchanged.
 */
export function settleRefusal(outcome: ApiResult<unknown>, procedure: string): { outcome: ApiResult<unknown>; refusedFirst: boolean } {
  if (outcome.ok || outcome.status === undefined || outcome.code === undefined) return { outcome, refusedFirst: false };
  const code = outcome.code.trim().toLowerCase();
  const words = moneyRefusalWords(code, undefined, procedure);
  if (!words) return { outcome, refusedFirst: false };
  const checked = REFUSAL_CHECKED_WRITES.has(procedure);
  const clean = checked && !CONFLICTS.has(code) && keyFor(code, procedure) !== 'cardNotIssued';
  if (clean) return { outcome: { ...outcome, reason: 'error', message: words, messageCopy: undefined }, refusedFirst: true };
  // Words, but the request stays unconfirmed. Only where the code proves something may exist, or on a checked write.
  if (CONFLICTS.has(code) || checked)
    return { outcome: { ...outcome, reason: 'uncertain', message: words, messageCopy: undefined }, refusedFirst: false };
  return { outcome, refusedFirst: false };
}
