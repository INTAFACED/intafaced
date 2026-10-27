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
  spaceChangeInvalid:
    'That change cannot be made to this space. A goal is above zero, and a lock date is in the future and no earlier than the lock already set. Nothing was changed.',
  unlockRuleUnset:
    'The bank has not set how long an early unlock waits, so no new lock is made and a locked space stays locked to its date. Nothing was changed.',
  spaceNotLocked: 'This space is not locked now, so there is no lock to end early. Nothing was changed.',
  roundUpTarget:
    'A round-up goes into one of your own spaces or one pool, and never back into the account it comes from. Nothing was set up.',
  sorterTermsUnset: 'The bank has not published when incoming payments are sorted, so no sorter can be set up now. Nothing was set up.',
  sorterInvalid:
    'A sorter sends whole percentages of each payment into your own spaces, at most 100% in all, each space once and never the account itself. Nothing was set up.',
  sorterExists: 'This currency already has a sorter. Stop that one first. Nothing was set up.',
  sorterNotFound: 'That sorter could not be found. Nothing was changed.',
  sorterConflict: 'This request was already used for a different sorter. Start again from the Spaces page. Nothing was set up.',
  cannotReceive: 'That person cannot receive this right now. Nothing was sent.',
  receiveCheckDown: 'We could not check whether the recipient can receive money. Nothing was sent. Try again in a moment.',
  receiveCheckOff: 'Paying other people is not set up on this service. Nothing was sent.',
  securityLocked:
    'Your security lock is on, so no withdrawal address can be added and nothing can be withdrawn to one until it ends. Nothing was changed.',
  securityLockDown: 'We could not check your security lock, so nothing was changed. Try again in a moment.',
  securityLockOff:
    'Withdrawal addresses and withdrawals are not set up on this service, because the security lock cannot be checked. Nothing was changed.',
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
  scheduleChanged:
    'This standing order changed since you opened it, so your edit was not applied. Nothing was changed. Refresh to see its current amount and end date, then edit again.',
  scheduleCutoff: 'The next run is too close to change this order now. Nothing was changed. Try again after that run.',
  scheduleEditOff: 'Changing standing orders is not set up on this service. Nothing was changed.',
  scheduleInactive: 'This standing order has ended or was cancelled, so it cannot be changed. Nothing was changed.',
  scheduleNotFound: 'That standing order could not be found. Refresh your standing orders. Nothing was changed.',
  spaceForbidden: 'You can see this shared pot, but your part in it does not let you move this money. Nothing was sent.',
  jointUnset:
    'The bank has not decided how long an invite lasts or how many people can share a pot, so pots are not shared. Nothing was changed.',
  inviteExpired: 'This invite has ended. Ask the pot’s owner for a new one. Nothing was changed.',
  inviteNotFound: 'This invite is no longer open to you. Nothing was changed.',
  inviteeNotFound: 'No active account has this handle or email. Check it and try again. Nothing was sent.',
  spaceNameTaken:
    'You already have a space with this name in this currency, perhaps an archived one. Pick another name. Nothing was changed.',
  sharedPotFull: 'This pot is shared with as many people as the bank allows, open invites included. Nothing was sent.',
  sharedPotInvalid:
    'That cannot be done with this pot: the person may already share it or have an open invite, or it is your own. Nothing was changed.',
  potCardForbidden: 'You can see this shared pot, but only its owner and contributors can freeze its card. Nothing was changed.',
  potCardMissing: 'No card is linked to this pot any more. Nothing was changed.',
  potCardTaken: 'This pot already has a linked card, or that card is linked to another pot. Unlink it first. Nothing was changed.',
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
  spaceChangeInvalid:
    'Ese cambio no se puede hacer en este espacio. Un objetivo es mayor que cero, y una fecha de bloqueo es futura y no anterior al bloqueo ya fijado. No se cambió nada.',
  unlockRuleUnset:
    'El banco no ha fijado cuánto espera un desbloqueo anticipado, así que no se crea ningún bloqueo nuevo y un espacio bloqueado sigue así hasta su fecha. No se cambió nada.',
  spaceNotLocked: 'Este espacio no está bloqueado ahora, así que no hay bloqueo que terminar antes. No se cambió nada.',
  roundUpTarget: 'Un redondeo va a uno de tus espacios o a un fondo, y nunca de vuelta a la cuenta de la que sale. No se configuró nada.',
  sorterTermsUnset:
    'El banco no ha publicado cuándo se reparten los pagos entrantes, así que ahora no se puede configurar un reparto. No se configuró nada.',
  sorterInvalid:
    'Un reparto envía porcentajes de cada pago a tus propios espacios, como máximo el 100 % en total, cada espacio una vez y nunca a la cuenta misma. No se configuró nada.',
  sorterExists: 'Esta moneda ya tiene un reparto. Detén ese primero. No se configuró nada.',
  sorterNotFound: 'No se encontró ese reparto. No se cambió nada.',
  sorterConflict: 'Esta solicitud ya se usó para otro reparto. Empieza de nuevo desde Espacios. No se configuró nada.',
  cannotReceive: 'Esa persona no puede recibir esto ahora. No se envió nada.',
  receiveCheckDown: 'No pudimos comprobar si el destinatario puede recibir dinero. No se envió nada. Inténtalo de nuevo en un momento.',
  receiveCheckOff: 'Pagar a otras personas no está configurado en este servicio. No se envió nada.',
  securityLocked:
    'Tu bloqueo de seguridad está activado: no se pueden añadir direcciones de retiro ni retirar nada a ellas hasta que termine. No se cambió nada.',
  securityLockDown: 'No pudimos comprobar tu bloqueo de seguridad, así que no se cambió nada. Inténtalo de nuevo en un momento.',
  securityLockOff:
    'Las direcciones de retiro y los retiros no están configurados en este servicio, porque no se puede comprobar el bloqueo de seguridad. No se cambió nada.',
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
  scheduleChanged:
    'Esta orden permanente cambió desde que la abriste, así que tu edición no se aplicó. No se cambió nada. Actualiza para ver su importe y fecha de fin actuales y edítala de nuevo.',
  scheduleCutoff:
    'La próxima ejecución está demasiado cerca para cambiar esta orden ahora. No se cambió nada. Inténtalo después de esa ejecución.',
  scheduleEditOff: 'Cambiar órdenes permanentes no está configurado en este servicio. No se cambió nada.',
  scheduleInactive: 'Esta orden permanente terminó o se canceló, así que no se puede cambiar. No se cambió nada.',
  scheduleNotFound: 'No se encontró esa orden permanente. Actualiza tus órdenes permanentes. No se cambió nada.',
  spaceForbidden: 'Puedes ver esta hucha compartida, pero tu papel en ella no te deja mover este dinero. No se envió nada.',
  jointUnset:
    'El banco no ha decidido cuánto dura una invitación ni con cuántas personas se comparte una hucha, así que no se comparten huchas. No se cambió nada.',
  inviteExpired: 'Esta invitación terminó. Pide una nueva al propietario de la hucha. No se cambió nada.',
  inviteNotFound: 'Esta invitación ya no está abierta para ti. No se cambió nada.',
  inviteeNotFound: 'Ninguna cuenta activa tiene ese usuario o correo. Revísalo e inténtalo de nuevo. No se envió nada.',
  spaceNameTaken: 'Ya tienes un espacio con este nombre en esta moneda, quizá uno archivado. Elige otro nombre. No se cambió nada.',
  sharedPotFull: 'Esta hucha se comparte con tantas personas como permite el banco, invitaciones abiertas incluidas. No se envió nada.',
  sharedPotInvalid:
    'Eso no se puede hacer con esta hucha: puede que la persona ya la comparta o tenga una invitación abierta, o es la tuya. No se cambió nada.',
  potCardForbidden: 'Puedes ver esta hucha compartida, pero solo su dueño y quienes aportan pueden congelar su tarjeta. No se cambió nada.',
  potCardMissing: 'Esta hucha ya no tiene ninguna tarjeta vinculada. No se cambió nada.',
  potCardTaken:
    'Esta hucha ya tiene una tarjeta vinculada, o esa tarjeta está vinculada a otra hucha. Desvincúlala primero. No se cambió nada.',
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
  spaceChangeInvalid:
    'Ce changement ne peut pas être fait sur cet espace. Un objectif est supérieur à zéro, et une date de verrouillage est future et pas antérieure au verrouillage déjà fixé. Rien n’a été modifié.',
  unlockRuleUnset:
    'La banque n’a pas fixé la durée d’attente d’un déverrouillage anticipé, donc aucun nouveau verrouillage n’est créé et un espace verrouillé le reste jusqu’à sa date. Rien n’a été modifié.',
  spaceNotLocked: 'Cet espace n’est pas verrouillé maintenant, donc il n’y a aucun verrouillage à terminer plus tôt. Rien n’a été modifié.',
  roundUpTarget: 'Un arrondi va dans un de tes espaces ou dans un fonds, et jamais dans le compte d’où il part. Rien n’a été configuré.',
  sorterTermsUnset:
    'La banque n’a pas publié quand les paiements entrants sont répartis, donc aucune répartition ne peut être configurée pour le moment. Rien n’a été configuré.',
  sorterInvalid:
    'Une répartition envoie des pourcentages de chaque paiement vers tes propres espaces, 100 % au plus au total, chaque espace une fois et jamais le compte lui-même. Rien n’a été configuré.',
  sorterExists: 'Cette devise a déjà une répartition. Arrête-la d’abord. Rien n’a été configuré.',
  sorterNotFound: 'Cette répartition est introuvable. Rien n’a été modifié.',
  sorterConflict: 'Cette demande a déjà servi pour une autre répartition. Recommence depuis Espaces. Rien n’a été configuré.',
  cannotReceive: 'Cette personne ne peut pas recevoir ceci pour le moment. Rien n’a été envoyé.',
  receiveCheckDown:
    'Nous n’avons pas pu vérifier si le destinataire peut recevoir de l’argent. Rien n’a été envoyé. Réessayez dans un instant.',
  receiveCheckOff: 'Payer d’autres personnes n’est pas configuré sur ce service. Rien n’a été envoyé.',
  securityLocked:
    'Votre verrou de sécurité est activé : aucune adresse de retrait ne peut être ajoutée et rien ne peut y être retiré tant qu’il dure. Rien n’a été modifié.',
  securityLockDown: 'Nous n’avons pas pu vérifier votre verrou de sécurité, donc rien n’a été modifié. Réessayez dans un instant.',
  securityLockOff:
    'Les adresses de retrait et les retraits ne sont pas configurés sur ce service, car le verrou de sécurité ne peut pas être vérifié. Rien n’a été modifié.',
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
  scheduleChanged:
    'Cet ordre permanent a changé depuis son ouverture, votre modification n’a donc pas été appliquée. Rien n’a été modifié. Actualisez pour voir son montant et sa date de fin actuels, puis modifiez-le à nouveau.',
  scheduleCutoff:
    'La prochaine exécution est trop proche pour modifier cet ordre maintenant. Rien n’a été modifié. Réessayez après cette exécution.',
  scheduleEditOff: 'La modification des ordres permanents n’est pas configurée sur ce service. Rien n’a été modifié.',
  scheduleInactive: 'Cet ordre permanent est terminé ou annulé, il ne peut donc pas être modifié. Rien n’a été modifié.',
  scheduleNotFound: 'Cet ordre permanent est introuvable. Actualisez vos ordres permanents. Rien n’a été modifié.',
  spaceForbidden: 'Tu vois cette cagnotte partagée, mais ton rôle ne te permet pas de déplacer cet argent. Rien n’a été envoyé.',
  jointUnset:
    'La banque n’a pas décidé combien de temps dure une invitation ni avec combien de personnes une cagnotte se partage, donc les cagnottes ne se partagent pas. Rien n’a été modifié.',
  inviteExpired: 'Cette invitation a pris fin. Demande-en une nouvelle au propriétaire de la cagnotte. Rien n’a été modifié.',
  inviteNotFound: 'Cette invitation n’est plus ouverte pour toi. Rien n’a été modifié.',
  inviteeNotFound: 'Aucun compte actif n’a cet identifiant ou cet e-mail. Vérifie-le et réessaie. Rien n’a été envoyé.',
  spaceNameTaken:
    'Tu as déjà un espace de ce nom dans cette devise, peut-être un espace archivé. Choisis un autre nom. Rien n’a été modifié.',
  sharedPotFull:
    'Cette cagnotte est partagée avec autant de personnes que la banque le permet, invitations ouvertes comprises. Rien n’a été envoyé.',
  sharedPotInvalid:
    'Ce n’est pas possible avec cette cagnotte : la personne la partage peut-être déjà ou a une invitation ouverte, ou c’est la tienne. Rien n’a été modifié.',
  potCardForbidden:
    'Tu vois cette cagnotte partagée, mais seules les personnes qui la possèdent ou y contribuent peuvent geler sa carte. Rien n’a été modifié.',
  potCardMissing: 'Aucune carte n’est plus liée à cette cagnotte. Rien n’a été modifié.',
  potCardTaken:
    'Cette cagnotte a déjà une carte liée, ou cette carte est liée à une autre cagnotte. Délie-la d’abord. Rien n’a été modifié.',
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
  'bank.space_change_invalid': 'spaceChangeInvalid',
  'bank.space_unlock_rule_unset': 'unlockRuleUnset',
  'bank.space_not_locked': 'spaceNotLocked',
  'bank.auto_invest_target_invalid': 'roundUpTarget',
  'bank.sorter_terms_unset': 'sorterTermsUnset',
  'bank.sorter_invalid': 'sorterInvalid',
  'bank.sorter_exists': 'sorterExists',
  'bank.sorter_conflict': 'sorterConflict',
  'bank.sorter_not_found': 'sorterNotFound',
  'bank.recipient_cannot_receive': 'cannotReceive',
  'bank.dest_user_missing': 'cannotReceive',
  'bank.recipient_check_unavailable': 'receiveCheckDown',
  'bank.recipient_check_unset': 'receiveCheckOff',
  'bank.security_locked': 'securityLocked',
  'bank.security_lock_unavailable': 'securityLockDown',
  'bank.security_lock_unset': 'securityLockOff',
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
  'bank.schedule_revision_conflict': 'scheduleChanged',
  'bank.schedule_cutoff': 'scheduleCutoff',
  'bank.schedule_edit_cutoff_unset': 'scheduleEditOff',
  'bank.schedule_inactive': 'scheduleInactive',
  'bank.schedule_not_found': 'scheduleNotFound',
  'bank.space_forbidden': 'spaceForbidden',
  'bank.joint_unset': 'jointUnset',
  'bank.invite_expired': 'inviteExpired',
  'bank.invite_not_found': 'inviteNotFound',
  'bank.invitee_not_found': 'inviteeNotFound',
  'bank.shared_pot_full': 'sharedPotFull',
  'bank.space_name_taken': 'spaceNameTaken',
  'bank.shared_pot_invalid': 'sharedPotInvalid',
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
  // One UPDATE in a transaction, after every check: a refusal changes nothing.
  'transfers.updateSchedule',
  // Shared pots (BK-acct-09): each change is one transaction that a refusal rolls back, and none moves money.
  'sharedPots.invite',
  'sharedPots.cancelInvite',
  'sharedPots.accept',
  'sharedPots.decline',
  'sharedPots.leave',
  'sharedPots.remove',
  // A pot's card: the link is one transaction; a freeze is refused before the card is touched, or it is the card's own
  // status change, which leaves the row as it was when the issuer refuses.
  'sharedPots.linkCard',
  'sharedPots.unlinkCard',
  'sharedPots.freezeCard',
  // A new space: one transaction behind the customer's advisory lock; a refusal (limit, duplicate name) rolls it all back.
  'spaces.create',
]);

/** The code's sentence key. A few sentences depend on which write was refused. */
function keyFor(code: string, procedure?: string): Key | undefined {
  const normal = code.trim().toLowerCase();
  // Only a payroll can be refused this way for being over the limit; for a payment it means a different thing.
  if (normal === 'bank.business_self_approve')
    return procedure === undefined || procedure === 'business.runPayroll' ? 'payrollOverLimit' : undefined;
  if (normal === 'bank.card_not_found' && procedure === 'cards.issue') return 'cardNotIssued';
  // A shared pot's card (BK-acct-09): the pot's own words, not the transfer's or the invite's.
  if (normal === 'bank.space_forbidden' && procedure === 'sharedPots.freezeCard') return 'potCardForbidden';
  if (normal === 'bank.card_not_found' && procedure === 'sharedPots.freezeCard') return 'potCardMissing';
  if (normal === 'bank.shared_pot_invalid' && procedure === 'sharedPots.linkCard') return 'potCardTaken';
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
